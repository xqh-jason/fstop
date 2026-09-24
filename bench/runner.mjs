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
const HEADED = args.includes('--headed')
/** `--source http`：语料由 dev server 直接服务，页面用 HTTP 读（绕开 setInputFiles 那条不稳的路） */
const SOURCE = args.includes('--source')
  ? arg('source', 'opfs')
  : CORPUS === null
    ? 'opfs'
    : 'files'
/** `--query`：跑检索延迟页（§八 ≤ 300 ms），不建索引 */
const QUERY_MODE = args.includes('--query')

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
    const context = await chromium.launchPersistentContext(profileDir, {
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

    const query = new URLSearchParams({
      count: COUNT,
      decode: DECODE,
      model: MODEL,
      dtype: DTYPE,
      source: SOURCE,
      limit: String(Number(arg('limit', '0'))),
      vfs: `fstop-vfs-bench-${Date.now()}`,
    })
    const pagePath = QUERY_MODE ? 'bench/query.html' : 'bench/run.html'
    const resultKey = QUERY_MODE ? 'window.__QUERY_RESULT' : 'window.__BENCH_RESULT'
    await page.goto(`${base}/${pagePath}?${query.toString()}`, { waitUntil: 'domcontentloaded' })

    if (CORPUS !== null && !QUERY_MODE) {
      // Playwright 对 `<input webkitdirectory>` 只接受**目录**（传文件数组会直接报错），
      // 而目录里的**软链会被 Chrome 静默忽略**（实测 files.length 恒为 0）。
      // 因此 `--limit N` 用「硬链接子集目录」实现：不复制字节、也不触发软链问题。
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
    // 只等「结果存在」会立刻返回中间态（实测两次踩到）
    const ready = QUERY_MODE
      ? `${resultKey} !== undefined && ${resultKey}.textEmbedMs !== undefined`
      : `${resultKey} !== undefined && ${resultKey}.photosPerSecond !== undefined`
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

    const payload = {
      measuredAt: new Date().toISOString(),
      browser: userAgent,
      headed: HEADED,
      ...result,
    }
    await mkdir(path.join('bench', 'results'), { recursive: true })
    const prefix = QUERY_MODE ? 'query' : 'index'
    const file = path.join(
      'bench',
      'results',
      `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    )
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`)

    console.log(`\n浏览器：${userAgent}`)
    console.log(`模型：${MODEL} [${DTYPE}]`)
    if (QUERY_MODE) {
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

    await context.close()
  } finally {
    server.kill('SIGTERM')
  }
}

await main()
