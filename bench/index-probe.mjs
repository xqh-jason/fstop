/**
 * 产品路径索引吞吐探针（临时工具）：量「用户点一下建立索引」这条链路到底把时间花在哪。
 *
 * 为什么不能只看终端到终端的总时间：`bench/e2e-app.mjs` 只能告诉「40 张很久」，
 * 而可疑点有三个（每张多次 COMMIT / 嵌入后端 / 解码），得用事实分开。
 * 这里同时收三样证据：
 *   1. 进度曲线（每 500 ms 采样一次界面状态）→ 每张耗时与是否有停顿平台期；
 *   2. CDP CPU 采样剖面 → 时间落在哪个函数（wasm 推理？OPFS 写入？）；
 *   3. 请求清单 → 实际加载的是派生产物还是原生权重、有没有外部 origin。
 *
 * 用法（先自己起一个 dev server，脚本不代劳）：
 *   pnpm dev --port 5198 --host 127.0.0.1      # 另开一个终端
 *   node bench/index-probe.mjs                 # PROBE_PHOTOS=12 可改张数
 */

import { chromium } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

const PORT = Number(process.env.PROBE_PORT ?? 5198)
const PHOTOS = Number(process.env.PROBE_PHOTOS ?? 12)
const OPFS_DIR = process.env.PROBE_OPFS ?? 'probe-corpus'
const BASE = `http://127.0.0.1:${PORT}`
const PROFILE = path.resolve('.cache', 'bench-profile')
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT ?? 900_000)

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`服务在 ${timeoutMs} ms 内没有就绪：${url}`)
}

/**
 * 分阶段微基准（`PROBE_MODE=stage`）：在**同一台机器、同一个 Chrome** 上，
 * 把「解码 → 嵌入」拆开单量，绕开产品编排，看每一段自己的成本。
 *
 * 为什么要在页面里量而不是看总时间：CDP 的 CPU 剖面只覆盖页面主线程（worker 里的
 * 推理看不见），而 300 s 的等待里主线程 88% 是 idle——「谁在等谁」必须分段量出来。
 */
async function runStageProbe(page, count) {
  const result = await page.evaluate(async (limit) => {
    const out = { gpu: {}, decode: [], embed: {}, init: null }
    out.gpu.navigator = 'gpu' in navigator
    if ('gpu' in navigator) {
      const adapter = await navigator.gpu.requestAdapter()
      const info = adapter?.info
      out.gpu.adapter =
        adapter === null
          ? 'null'
          : info === undefined
            ? 'ok（无 info）'
            : `${info.vendor ?? '?'} / ${info.architecture ?? '?'} / ${info.description ?? '?'}`
    }

    const manifest = await (await fetch('/bench/corpus/manifest.json')).json()
    const names = manifest
      .map((entry) => entry.file)
      .filter(Boolean)
      .slice(0, limit)
    const blobs = []
    for (const name of names) {
      const response = await fetch(
        `/bench/corpus/${name.split('/').map(encodeURIComponent).join('/')}`,
      )
      blobs.push({ name, blob: await response.blob() })
    }

    const { decodePhoto, DEFAULT_DECODE_OPTIONS } = await import('/src/workers/decode.ts')

    // 第一张再拆细：整帧解码 / 缩放绘制 / 缩略图编码 各占多少
    const first = blobs[0]
    if (first !== undefined) {
      let t = performance.now()
      const full = await createImageBitmap(first.blob, { imageOrientation: 'from-image' })
      const fullMs = performance.now() - t
      t = performance.now()
      const canvas = new OffscreenCanvas(512, 512)
      const context = canvas.getContext('2d')
      context.drawImage(full, 0, 0, 512, 512)
      const drawMs = performance.now() - t
      t = performance.now()
      const bitmap = canvas.transferToImageBitmap()
      const transferMs = performance.now() - t
      t = performance.now()
      const thumbCanvas = new OffscreenCanvas(320, 320)
      thumbCanvas.getContext('2d').drawImage(full, 0, 0, 320, 320)
      const thumb = await thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
      const thumbMs = performance.now() - t
      out.decode.push({
        stage: '拆细（第一张）',
        fullMs: Math.round(fullMs),
        draw512Ms: Math.round(drawMs),
        transferMs: Math.round(transferMs),
        thumbEncodeMs: Math.round(thumbMs),
        thumbBytes: thumb.size,
        size: `${full.width}×${full.height}`,
      })
      full.close()
      bitmap.close()
    }

    const bitmaps = []
    for (const { name, blob } of blobs) {
      const started = performance.now()
      const decoded = await decodePhoto(blob, DEFAULT_DECODE_OPTIONS)
      out.decode.push({
        step: name.slice(-28),
        decodeMs: Math.round(performance.now() - started),
        jpegKB: Math.round(blob.size / 1024),
        size: `${decoded.width}×${decoded.height}`,
      })
      bitmaps.push(decoded.bitmap)
    }

    // 嵌入：用与产品页同一个 worker 模块，但自己开一个实例，逐张计时
    const resource = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /deps\/comlink\.js/.test(name))
    const Comlink = await import(resource ?? '/node_modules/.vite/deps/comlink.js')
    const worker = new Worker(new URL('/src/workers/embed.worker.ts', location.origin), {
      type: 'module',
    })
    const embed = Comlink.wrap(worker)
    const initStarted = performance.now()
    const init = await embed.init({ device: 'webgpu' })
    out.init = { ...init, initMs: Math.round(performance.now() - initStarted) }
    const times = []
    for (const bitmap of bitmaps) {
      const started = performance.now()
      await embed.embedImage(bitmap)
      times.push(Math.round(performance.now() - started))
      bitmap.close()
    }
    times.sort((a, b) => a - b)
    out.embed = {
      count: times.length,
      minMs: times[0] ?? 0,
      medianMs: times[Math.floor(times.length / 2)] ?? 0,
      maxMs: times[times.length - 1] ?? 0,
      timesMs: times,
    }
    // 再补量「入库侧」的两件事：缩略图写 OPFS（产品路径逐张 createWritable+close）、
    // 向量矩阵追加（占位向量即可，量 OPFS 写句柄的真实成本）。
    const root = await navigator.storage.getDirectory()
    const thumbDir = await root.getDirectoryHandle('probe-thumbs', { create: true })
    const vecDir = await root.getDirectoryHandle('probe-vec', { create: true })
    const vecHandle = await vecDir.getFileHandle('probe.f32', { create: true })
    const vecWritable = await vecHandle.createWritable({ keepExistingData: true })
    const stride = 512 * Float32Array.BYTES_PER_ELEMENT
    let vecPosition = (await vecHandle.getFile()).size
    const thumbWriteMs = []
    const vectorWriteMs = []
    const vector = new Float32Array(512).fill(0.1)
    for (let index = 0; index < limit; index += 1) {
      const t0 = performance.now()
      const handle = await thumbDir.getFileHandle(`probe-${index}.jpg`, { create: true })
      const writable = await handle.createWritable()
      await writable.write(new Blob([new Uint8Array(24 * 1024)]))
      await writable.close()
      thumbWriteMs.push(Math.round(performance.now() - t0))
      const t1 = performance.now()
      await vecWritable.write({
        type: 'write',
        position: vecPosition,
        data: vector.slice().buffer,
      })
      vecPosition += stride
      vectorWriteMs.push(Math.round(performance.now() - t1))
    }
    await vecWritable.close()
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
    out.storage = {
      thumbWriteMedianMs: median(thumbWriteMs),
      vectorWriteMedianMs: median(vectorWriteMs),
    }
    return out
  }, count)

  console.log(`WebGPU：${String(result.gpu.navigator)}，适配器 ${String(result.gpu.adapter)}`)
  console.log(`嵌入初始化：${JSON.stringify(result.init)}`)
  console.log('\n解码：')
  for (const row of result.decode) {
    if (row.stage !== undefined) {
      console.log(
        `  拆细：整帧解码 ${row.fullMs} ms / drawImage 512² ${row.draw512Ms} ms / transfer ${row.transferMs} ms / 缩略图编码 ${row.thumbEncodeMs} ms（${row.thumbBytes} B）`,
      )
    } else {
      console.log(`  ${row.step}  ${row.decodeMs} ms  ${row.size}  ${row.jpegKB} KB`)
    }
  }
  console.log(
    `\n嵌入：n=${result.embed.count}  中位 ${result.embed.medianMs} ms  最小 ${result.embed.minMs}  最大 ${result.embed.maxMs}`,
  )
  console.log(`  逐张：${result.embed.timesMs.join(', ')}`)
  console.log(
    `\n存储：缩略图写 ${result.storage.thumbWriteMedianMs} ms/张（中位），向量槽写 ${result.storage.vectorWriteMedianMs} ms/次（中位）`,
  )
}

/** 把 CDP 采样剖面按「自身耗时」聚合到函数名 + 文件 */
function aggregate(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const self = new Map()
  for (let i = 0; i < profile.samples.length; i += 1) {
    const id = profile.samples[i]
    const delta = profile.timeDeltas[i] ?? 0
    const node = byId.get(id)
    if (node === undefined) continue
    const frame = node.callFrame
    const url = (frame.url ?? '').replace(BASE, '')
    const key = `${frame.functionName || '(anonymous)'} @ ${url.split('/').slice(-2).join('/')}:${frame.lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + delta)
  }
  return [...self.entries()].sort((a, b) => b[1] - a[1])
}

async function main() {
  await waitForServer(`${BASE}/bench/corpus/manifest.json`, 60_000)
  await mkdir(PROFILE, { recursive: true })
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await rm(path.join(PROFILE, name), { force: true })
  }
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: !process.argv.includes('--headed'),
  })
  const page = context.pages()[0] ?? (await context.newPage())
  const errors = []
  page.on('pageerror', (error) => {
    errors.push(String(error))
    console.error(`[pageerror] ${error}`)
  })
  const logs = []
  page.on('console', (message) => {
    const text = message.text()
    logs.push(text)
    if (/\[embed\]|回落|derived/.test(text)) console.log(`[console] ${text}`)
  })
  const requests = []
  context.on('requestfinished', (request) => requests.push(request.url()))
  const external = new Set()
  context.on('request', (request) => {
    const host = new URL(request.url()).hostname
    if (host !== '127.0.0.1' && host !== 'localhost') external.add(host)
  })

  await page.goto(`${BASE}/?root=opfs&opfs=${OPFS_DIR}`, { waitUntil: 'load' })

  if (process.env.PROBE_MODE === 'stage') {
    await runStageProbe(page, PHOTOS)
    await context.close()
    return
  }

  if (process.env.PROBE_MODE === 'db') {
    // 「入库成本」单量：在产品页同款 worker + 独立 VFS 目录上，量 writeBatch 与
    // claimJobs/completeJob 各一段的真实耗时。这是「每张两次独立事务」怀疑点的直接检验。
    // 注意必须用独立的 vfs 目录：主页面 boot() 会在 .fstop-vfs 里开 opfs-sahpool 实例，
    // 同名目录的第二个实例（或与主页面的写句柄重叠）会直接硬失败。
    const vfs = process.env.PROBE_VFS ?? `probe-vfs-${Date.now()}`
    const dbResult = await page.evaluate(
      async (args) => {
        const resource = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => /deps\/comlink\.js/.test(name))
        const Comlink = await import(resource ?? '/node_modules/.vite/deps/comlink.js')
        const worker = new Worker(new URL('/src/storage/db.worker.ts', location.origin), {
          type: 'module',
        })
        const db = Comlink.wrap(worker)
        const opened = await db.open('probe', { directory: args.vfs })
        const count = args.count
        const now = Date.now()
        const rows = Array.from({ length: count }, (_, i) => ({
          relPath: `probe/photo-${String(i).padStart(4, '0')}.jpg`,
          ext: 'jpg',
          size: 700_000,
          mtime: now,
          contentHash: `hash-${i}`,
          width: 1920,
          height: 1440,
          thumbKey: `hash-${i}.jpg`,
          modelId: 'Xenova/chinese-clip-vit-base-patch16',
          dim: 512,
          matrixOffset: i,
        }))
        const t0 = performance.now()
        await db.writeBatch(rows)
        const writeBatchMs = Math.round(performance.now() - t0)
        const t1 = performance.now()
        const known = await db.knownPhotos()
        const knownMs = Math.round(performance.now() - t1)
        const t2 = performance.now()
        const plan = {
          inserts: [],
          reindex: [],
          moves: [],
          restores: [],
          unchanged: known.map((photo) => ({
            id: photo.id,
            entry: {
              relPath: photo.relPath,
              size: 1,
              mtime: now,
              contentHash: photo.contentHash ?? '',
            },
          })),
          deleted: [],
        }
        const applied = await db.applyScan(plan, Date.now())
        void applied
        const planMs = Math.round(performance.now() - t2)
        const t3 = performance.now()
        const jobs = await db.claimJobs('embed', count, Date.now())
        const claimMs = Math.round(performance.now() - t3)
        const completeMs = []
        for (const job of jobs) {
          const t = performance.now()
          await db.completeJob(job.jobId, Date.now())
          completeMs.push(Math.round(performance.now() - t))
        }
        completeMs.sort((a, b) => a - b)
        return {
          opened,
          writeBatchMs,
          writeBatchPerRow: Number((writeBatchMs / count).toFixed(2)),
          knownMs,
          planMs,
          claimMs,
          completeMedianMs: completeMs[Math.floor(completeMs.length / 2)] ?? 0,
          completeMaxMs: completeMs[completeMs.length - 1] ?? 0,
          stats: await db.stats(),
        }
      },
      { count: Math.max(20, PHOTOS), vfs },
    )
    console.log(`入库成本单量（产品同款 worker，vfs=${vfs}）：`)
    console.log(JSON.stringify(dbResult, null, 2))
    await context.close()
    return
  }

  // 每次测量前清掉上一轮的索引状态（数据库/向量/缩略图/语料）。
  // 不清的话第二轮扫描判定「全都未变」→ 一张都不用算，量出来的是 0。
  // 保留 profile 是为了让模型权重留在 CacheStorage 里（冷缓存下载会混进耗时）。
  if (process.env.PROBE_RESET !== '0') {
    const removed = await page.evaluate(
      async (names) => {
        const root = await navigator.storage.getDirectory()
        const gone = []
        for (const name of names) {
          try {
            await root.removeEntry(name, { recursive: true })
            gone.push(name)
          } catch {
            // 本来就没有
          }
        }
        return gone
      },
      ['.fstop-vfs', 'fstop-vectors', 'fstop-thumbs', OPFS_DIR],
    )
    console.log(`重置：清掉 ${removed.join(', ') || '（本来就没有）'}`)
  }

  const seeded = await page.evaluate(async (limit) => {
    const manifest = await (await fetch('/bench/corpus/manifest.json')).json()
    const names = manifest
      .map((entry) => entry.file)
      .filter(Boolean)
      .slice(0, limit)
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle('probe-corpus', { create: true })
    let bytes = 0
    for (const name of names) {
      const response = await fetch(
        `/bench/corpus/${name.split('/').map(encodeURIComponent).join('/')}`,
      )
      if (!response.ok) throw new Error(`语料取回失败 HTTP ${response.status}：${name}`)
      const blob = await response.blob()
      const writable = await (
        await directory.getFileHandle(name, { create: true })
      ).createWritable()
      await writable.write(blob)
      await writable.close()
      bytes += blob.size
    }
    return { files: names.length, bytes }
  }, PHOTOS)
  console.log(`播种：${seeded.files} 张 / ${(seeded.bytes / 1048576).toFixed(1)} MB`)

  const readyStart = Date.now()
  await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
    timeout: 300_000,
  })
  console.log(`应用就绪耗时：${((Date.now() - readyStart) / 1000).toFixed(1)} s`)

  const session = await context.newCDPSession(page)
  await session.send('Profiler.enable')
  await session.send('Profiler.setSamplingInterval', { interval: 500 })
  await session.send('Profiler.start')

  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent.includes('建立索引'),
    )
    if (button === undefined || button.disabled) return false
    button.click()
    return true
  })
  if (!clicked) throw new Error('「建立索引」按钮不可点')

  const started = Date.now()
  const curve = []
  let finished = false
  while (Date.now() - started < TIMEOUT_MS) {
    const text = await page.evaluate(() => document.querySelector('.status')?.textContent ?? '')
    const done = Number(text.match(/(\d+)\/(\d+)/)?.[1] ?? -1)
    const total = Number(text.match(/(\d+)\/(\d+)/)?.[2] ?? -1)
    curve.push({ at: Date.now() - started, text, done, total })
    if (/索引完成|出错了|中断|已停止/.test(await page.evaluate(() => document.body.innerText))) {
      finished = true
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  const elapsed = Date.now() - started
  const { profile } = await session.send('Profiler.stop')

  // —— 报告 ——
  const sampled = curve.filter(
    (point, index) => index === 0 || point.text !== curve[index - 1].text,
  )
  console.log(`\n进度曲线（${sampled.length} 个变化点）：`)
  let previous = { at: 0, done: 0 }
  for (const point of sampled) {
    const deltaDone = point.done - previous.done
    const deltaMs = point.at - previous.at
    const per = deltaDone > 0 ? ` | ${(deltaMs / deltaDone).toFixed(0)} ms/张` : ''
    console.log(`  ${(point.at / 1000).toFixed(1)}s  ${point.text}${per}`)
    previous = { at: point.at, done: point.done > 0 ? point.done : previous.done }
  }

  console.log(`\n总计：${(elapsed / 1000).toFixed(1)} s，结束=${finished}`)
  const last = curve[curve.length - 1]
  if (last !== undefined && last.done > 0) {
    console.log(
      `每张平均：${(elapsed / last.done).toFixed(0)} ms（${(1000 / (elapsed / last.done)).toFixed(2)} 张/秒）`,
    )
  }

  console.log('\nCPU 采样自身耗时 top 25（ms）：')
  for (const [key, micros] of aggregate(profile).slice(0, 25)) {
    console.log(`  ${(micros / 1000).toFixed(0).padStart(7)}  ${key}`)
  }

  const modelRequests = requests.filter((url) => /derived|\.onnx|huggingface|hf-mirror/.test(url))
  console.log('\n权重请求：')
  for (const url of [...new Set(modelRequests)]) console.log(`  ${url.replace(BASE, '')}`)
  console.log(`外部 origin：${[...external].join(', ') || '无'}`)
  console.log(`页面异常：${errors.length === 0 ? '无' : errors[0]}`)

  await context.close()
}

await main()
