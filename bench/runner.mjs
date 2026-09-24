#!/usr/bin/env node
/**
 * `pnpm bench` 的驱动器 —— 见项目计划 §九 M0 交付物 1：
 * 「任何人 `pnpm bench` 都能得到 photos/s 并贴进 issue」。
 *
 * 做法：起一个 Vite 服务 → 用 Playwright 打开 `bench/run.html` → 把语料目录塞进
 * `<input webkitdirectory>`（原生目录选择器无法被自动化驱动，这是唯一不复制文件又能自动化的通路）
 * → 等页面把 `window.__BENCH_RESULT` 写出来 → 落 `bench/results/<时间戳>.json` 并打印。
 *
 * 用系统已装的 Chrome（`channel: 'chrome'`）而不是下载 Playwright 自带 Chromium：
 * 省一次几百 MB 下载，而且**基准本来就该跑在用户真实浏览器上**。
 *
 * 用法：
 *   pnpm bench                                  # 合成语料（OPFS），可复现基线
 *   pnpm bench -- --corpus bench/corpus         # 真实照片语料（目录）
 *   pnpm bench -- --headed --count 200          # 有头 + 限量
 *   pnpm bench -- --model Xenova/clip-vit-base-patch32 --dtype q4f16
 *   pnpm bench -- --query                       # 检索延迟（§八 ≤ 300 ms）
 *   pnpm bench -- --quality                     # 检索质量（中文 query 命中率，M0 收口 §A2）
 */

import { spawn } from 'node:child_process'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'

const args = process.argv.slice(2)

/** @param {string} name @param {string} fallback */
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const PORT = Number(arg('port', '5199'))
const CORPUS = arg('corpus', null)
const COUNT = arg('count', '200')
const DECODE = arg('decode', '3')
const MODEL = arg('model', 'Xenova/chinese-clip-vit-base-patch16')
const DTYPE = arg('dtype', 'q4f16')
/** 拆塔 spike 的 EP 对照（webgpu | wasm）：判定「不剪枝」是 ORT 通用行为还是 WebGPU EP 特有 */
const DEVICE = arg('device', 'webgpu')
const HEADED = args.includes('--headed')
/** `--source http`：语料由 dev server 直接服务，页面用 HTTP 读（绕开 setInputFiles 那条不稳的路） */
const SOURCE = args.includes('--source')
  ? arg('source', 'opfs')
  : CORPUS === null
    ? 'opfs'
    : 'files'
/** `--query`：跑检索延迟页（§八 ≤ 300 ms），不建索引 */
const QUERY_MODE = args.includes('--query')
/** `--quality`：跑检索质量页（M0 收口 §9A2 中文 query 命中率），样例库即检索库 */
const QUALITY_MODE = args.includes('--quality')
/** `--towers`：跑拆塔方案 C spike（§9A3：ORT 指定输出列表是否真能剪掉另一塔） */
const TOWERS_MODE = args.includes('--towers')
/** `--exported`：跑导出塔 spike（§9A5 / D2：图手术切出的单塔成本 + 112² 版的中文 R@1） */
const EXPORTED_MODE = args.includes('--exported')

/** @param {string} url @param {number} timeoutMs */
async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`Vite 服务在 ${timeoutMs} ms 内没有就绪：${url}`)
}

async function main() {
  const server = spawn(
    process.execPath,
    [
      path.join('node_modules', 'vite', 'bin', 'vite.js'),
      '--port',
      String(PORT),
      '--strictPort',
      // 必须钉死 IPv4：Vite 默认只监听 ::1，而 Node 的 `localhost` 可能解析到 127.0.0.1，
      // 于是就绪探测永远连不上（实测踩过：curl 对 127.0.0.1 返回 000、对 [::1] 返回 200）
      '--host',
      '127.0.0.1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  // 输出必须接出来：否则 Vite 的报错只会在管道里堆着，失败时无从诊断
  server.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`))
  server.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`))
  const base = `http://127.0.0.1:${PORT}`

  let context = null
  try {
    await waitForServer(`${base}/bench/run.html`, 120_000)

    // 用**持久化 profile**：Playwright 默认每次启动都是全新临时 profile，
    // 于是每跑一次基准都要重新下载 131.8 MB 权重（实测把一轮 40 张的基准拖成十分钟以上）。
    // 持久化后 Cache Storage 跨轮复用，权重只下一次。
    const profileDir = path.resolve('.cache', 'bench-profile')
    await mkdir(profileDir, { recursive: true })
    // 被强杀（例如 `timeout` 打断）会留下陈旧的进程单例锁，Chrome 见到它**直接拒绝启动**。
    // 这个 profile 归基准独占（并发跑两轮基准本就不支持），所以直接清理。
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      await rm(path.join(profileDir, name), { force: true })
    }
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: !HEADED,
    })
    const page = context.pages()[0] ?? (await context.newPage())
    const consoleErrors = []
    // 页面错误必须**立刻**打出来：只在结尾汇总等于盲飞（实测被这个坑过一次）
    page.on('pageerror', (error) => {
      consoleErrors.push(String(error))
      console.error(`[pageerror] ${error}`)
    })
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
      console.log(`[page] ${message.text()}`)
    })
    // 资源 404 也要点名：首轮 spike 里有一条无主的 404，只有 URL 才能定位（可观测性纪律）。
    // 注意必须挂在 **context** 上：模型权重是 Worker 里 fetch 的，page 级监听收不到 Worker 的请求。
    context.on('response', (response) => {
      if (response.status() >= 400) console.log(`[http ${response.status()}] ${response.url()}`)
    })
    context.on('requestfailed', (request) => {
      console.log(`[http failed] ${request.url()} ${request.failure()?.errorText ?? ''}`)
    })

    const query = new URLSearchParams({
      count: COUNT,
      decode: DECODE,
      model: MODEL,
      dtype: DTYPE,
      device: DEVICE,
      source: SOURCE,
      limit: String(Number(arg('limit', '0'))),
      fidelity: arg('fidelity', '1'),
      queries: arg('queries', 'samples'),
      gallery: arg('gallery', ''),
      sizes: arg('sizes', ''),
      vfs: `fstop-vfs-bench-${Date.now()}`,
    })
    const pagePath = EXPORTED_MODE
      ? 'bench/exported.html'
      : TOWERS_MODE
        ? 'bench/towers.html'
        : QUALITY_MODE
          ? 'bench/quality.html'
          : QUERY_MODE
            ? 'bench/query.html'
            : 'bench/run.html'
    const resultKey = EXPORTED_MODE
      ? 'window.__EXPORT_RESULT'
      : TOWERS_MODE
        ? 'window.__TOWER_RESULT'
        : QUALITY_MODE
          ? 'window.__QUALITY_RESULT'
          : QUERY_MODE
            ? 'window.__QUERY_RESULT'
            : 'window.__BENCH_RESULT'
    await page.goto(`${base}/${pagePath}?${query.toString()}`, { waitUntil: 'domcontentloaded' })
    page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`))

    if (CORPUS !== null && !QUERY_MODE && !QUALITY_MODE && !TOWERS_MODE && !EXPORTED_MODE) {
      // Playwright 对 `<input webkitdirectory>` 只接受**目录**（传文件数组会直接报错）。
      // 目录里的**软链会被 Chromium 逐项静默过滤**（安全机制；混合目录只丢软链项，
      // 实测 files-probe 四形态对照），因此 `--limit N` 用「硬链接子集目录」实现：
      // 不复制字节、也不触发软链过滤。
      const limit = Number(arg('limit', '0'))
      if (limit > 0) {
        const manifest = JSON.parse(await readFile(path.join(CORPUS, 'manifest.json'), 'utf8'))
        const subset = path.resolve('.cache', 'bench-subset')
        await rm(subset, { recursive: true, force: true })
        await mkdir(subset, { recursive: true })
        for (const entry of manifest.slice(0, limit)) {
          const target = path.join(subset, entry.file)
          await link(path.resolve(CORPUS, entry.file), target).catch(() => undefined)
        }
        console.log(`子集目录（硬链接 ${limit} 个）→ ${subset}`)
        await page.setInputFiles('#corpus', subset)
      } else {
        await page.setInputFiles('#corpus', path.resolve(CORPUS))
      }
    }

    // 就绪条件必须等**终态字段**：页面一开始就会渲染 `{phase}` 这类中间态，
    // 只等「结果存在」会立刻返回中间态（实测两次踩到）。
    // 同时要接受 `phase === 'error'`：页面把异常渲染进 `#out` 但不会写终态字段，
    // 少了这一条，一次加载失败会把驱动器白等满 60 分钟（拆塔页首跑就是这么浪费的）。
    const failed = `${resultKey} !== undefined && ${resultKey}.phase === 'error'`
    const ready = `(${
      EXPORTED_MODE
        ? `${resultKey} !== undefined && ${resultKey}.costMs !== undefined`
        : TOWERS_MODE
          ? `${resultKey} !== undefined && ${resultKey}.prunedImageMs !== undefined`
          : QUALITY_MODE
            ? `${resultKey} !== undefined && ${resultKey}.metrics !== undefined`
            : QUERY_MODE
              ? `${resultKey} !== undefined && ${resultKey}.textEmbedMs !== undefined`
              : `${resultKey} !== undefined && ${resultKey}.photosPerSecond !== undefined`
    }) || (${failed})`
    // 等待期间每 20 s 汇报一次页面状态：卡住时能直接看到页面停在哪
    const heartbeat = setInterval(async () => {
      const snapshot = await page
        .evaluate('document.getElementById("out")?.textContent?.slice(0, 200) ?? "no #out"')
        .catch((error) => `unavailable: ${String(error)}`)
      console.log(`[wait] ${String(snapshot).replace(/\s+/g, ' ')}`)
    }, 20_000)

    try {
      // 注意 waitForFunction 的第二个参数是 arg、第三个才是 options：写错位置会静默用 30 s 默认超时
      await page.waitForFunction(ready, undefined, { timeout: 60 * 60 * 1000 })
    } finally {
      clearInterval(heartbeat)
    }
    const result = await page.evaluate(resultKey)
    const userAgent = await page.evaluate('navigator.userAgent')
    if (result?.phase === 'error') console.error(`页面失败：${result.message ?? '(无 message)'}`)

    const payload = {
      measuredAt: new Date().toISOString(),
      browser: userAgent,
      headed: HEADED,
      ...result,
    }
    await mkdir(path.join('bench', 'results'), { recursive: true })
    // 导出塔模式带 dtype 后缀：同一轮 D3 对照要能同时留下 q4f16 与 fp16 两份结果
    const prefix = EXPORTED_MODE
      ? `exported-${DTYPE}`
      : TOWERS_MODE
        ? 'towers'
        : QUALITY_MODE
          ? 'quality'
          : QUERY_MODE
            ? 'query'
            : 'index'
    const file = path.join(
      'bench',
      'results',
      `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    )
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`)

    console.log(`\n浏览器：${userAgent}`)
    console.log(`模型：${MODEL} [${DTYPE}]`)
    if (EXPORTED_MODE) {
      console.log(
        result.fidelity?.skipped === true
          ? '保真：已跳过（?fidelity=0，没有参照双塔模型）'
          : `保真（与原双塔模型比）：image_embeds 余弦 ${result.fidelity?.imageEmbedsCosine}，文本 ${result.fidelity?.textEmbedsCosine}（维度 ${JSON.stringify(result.fidelity?.dims)}；文本烟雾 ${result.fidelity?.textSmokeDifferentVectors}）`,
      )
      console.log(
        `双塔全算中位：${result.costMs?.dualFull ?? '—'} ms；文本塔 ${result.costMs?.text} ms`,
      )
      console.log(`视觉塔单塔中位（ms）：${JSON.stringify(result.visionCostMs)}`)
      if (Object.keys(result.unavailable ?? {}).length > 0) {
        console.log(`⚠ 未导出/建不起来的档：${JSON.stringify(result.unavailable)}`)
      }
      console.log(
        `拟合：固定开销 ${result.fit?.fixedMs ?? '—'} ms + ${result.fit?.perTokenMs ?? '—'} ms/token（点 ${JSON.stringify(result.fit?.points)}）`,
      )
      console.log(`同图 224² 与各档的余弦：${JSON.stringify(result.crossResolutionCosine)}`)
      console.log(
        `样例库图像向量化中位（ms）：${JSON.stringify(result.imageEmbedMs)}；文本 ${result.textEmbedMs?.median} ms`,
      )
      for (const [label, metrics] of Object.entries(result.quality ?? {})) {
        const m = metrics
        console.log(
          `[${label}] 中文 R@1 ${(m.recallAt1 * 100).toFixed(1)}%  R@5 ${(m.recallAt5 * 100).toFixed(1)}%  R@10 ${(m.recallAt10 * 100).toFixed(1)}%  MRR ${m.mrr}（${result.samples} 张 / ${result.queries} 条）`,
        )
      }
    } else if (TOWERS_MODE) {
      console.log(
        `全输出 run（现状）：${result.fullImageMs} ms；指定 ['image_embeds']：${result.prunedImageMs} ms（${result.prunedSpeedup}×）`,
      )
      console.log(
        `输出键：全量 ${JSON.stringify(result.fullOutputKeys)} → 指定后 ${JSON.stringify(result.prunedOutputKeys)}`,
      )
      console.log(`耗时分布（min/median/max ms）：${JSON.stringify(result.spreadMs)}`)
      for (const item of result.sweep ?? []) {
        console.log(
          `[扫描] ${item.label}（图 ${item.imageSize}px，文本 ${item.textTokens} token）：${item.medianMs ?? `失败 ${item.error}`} ms`,
        )
      }
      console.log(
        `剪枝文本塔：${result.prunedTextMs} ms；只喂单侧输入：${JSON.stringify(result.omitOtherInputs)}`,
      )
      console.log(
        `一致性：image_embeds 余弦 ${result.imageEmbedsCosine}；文本烟雾 ${result.textSmokeDifferentVectors ? '通过' : '失败'}`,
      )
    } else if (QUALITY_MODE) {
      console.log(`样例库：${result.samples} 张，query ${result.queries} 条 × 中英双语`)
      for (const lang of ['zh', 'en']) {
        const m = result.metrics[lang]
        if (m === undefined) continue
        console.log(
          `[${lang}] R@1 ${(m.recallAt1 * 100).toFixed(1)}%  R@5 ${(m.recallAt5 * 100).toFixed(1)}%  R@10 ${(m.recallAt10 * 100).toFixed(1)}%  MRR ${m.mrr}`,
        )
      }
    } else if (QUERY_MODE) {
      console.log(`索引规模：${result.vectors} 条 × ${result.dim} 维`)
      console.log(`文本向量化中位：${result.textEmbedMs.median} ms`)
      console.log(`暴力余弦 top-50 中位：${result.vectorSearchMs.median} ms`)
      console.log(
        `检索总延迟中位：${result.totalMedianMs} ms  ${result.withinBudget ? '✓ 在 300 ms 预算内' : '✗ 超出 300 ms 预算'}`,
      )
    } else {
      console.log(`dualTower=${result.model.dualTower}`)
      console.log(`语料：${JSON.stringify(result.corpus)}`)
      console.log(`照片数：${result.photos}  解码并发：${result.decodeConcurrency}`)
      console.log(
        `端到端：${result.indexSeconds} s → ${result.photosPerSecond} photos/s（1 万张外推 ${result.projected10kMinutes} 分钟）`,
      )
      console.log(`分阶段中位（ms）：${JSON.stringify(result.perStageMedianMs)}`)
      console.log(`入库：${JSON.stringify(result.dbStats)}  向量槽位：${result.vectorSlots}`)
    }
    console.log(`结果 → ${file}`)
    if (consoleErrors.length > 0) console.error(`页面错误：${consoleErrors.join(' | ')}`)
  } finally {
    // 浏览器必须在这里关：写在 try 末尾的话，一旦中途抛错/被 Ctrl-C，Chrome 会带着
    // 持久化 profile 留在后台（并留下进程单例锁，下一轮启动要先去清锁）。实测确认过
    // 正常路径下不留残留进程；这里补的是**异常路径**。
    if (context !== null)
      await context.close().catch((error) => console.error(`关闭浏览器失败：${error}`))
    server.kill('SIGTERM')
  }
}

await main()
