/**
 * 临时诊断驱动器（调试用，收尾删除）：跑产品页路径，把所有 console 原样打出来，
 * 并每 100 ms 采样一次界面状态。配合 `src/app/index-runner.ts` 里的临时 `[trace]` 打点，
 * 定位「用户点一下建立索引」这条链路到底把时间花在哪一步。
 *
 * 用法：node bench/trace-run.mjs      （先起 pnpm dev --port 5198 --host 127.0.0.1）
 */

import { chromium } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

const PORT = Number(process.env.PROBE_PORT ?? 5198)
const PHOTOS = Number(process.env.PROBE_PHOTOS ?? 12)
const OPFS_DIR = process.env.PROBE_OPFS ?? 'trace-corpus'
const BASE = `http://127.0.0.1:${PORT}`
const PROFILE = path.resolve(process.env.PROBE_PROFILE ?? '.cache/bench-profile')
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
const started = Date.now()
page.on('console', (message) => {
  const at = ((Date.now() - started) / 1000).toFixed(2)
  console.log(`[${at}s console.${message.type()}] ${message.text()}`)
})
page.on('pageerror', (error) => console.error(`[pageerror] ${error}`))

await page.addInitScript(() => {
  globalThis.__fstopTrace = true
})
await page.goto(`${BASE}/?root=opfs&opfs=${OPFS_DIR}`, { waitUntil: 'load' })

const removed = await page.evaluate(async (names) => {
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
}, ['.fstop-vfs', 'fstop-vectors', 'fstop-thumbs', OPFS_DIR])
console.log(`重置：清掉 ${removed.join(', ') || '（本来就没有）'}`)

const seeded = await page.evaluate(async (args) => {
  const manifest = await (await fetch('/bench/corpus/manifest.json')).json()
  const names = manifest
    .map((entry) => entry.file)
    .filter(Boolean)
    .slice(0, args.limit)
  const root = await navigator.storage.getDirectory()
  const directory = await root.getDirectoryHandle(args.dir, { create: true })
  let bytes = 0
  for (const name of names) {
    const response = await fetch(`/bench/corpus/${name.split('/').map(encodeURIComponent).join('/')}`)
    if (!response.ok) throw new Error(`语料取回失败 HTTP ${response.status}：${name}`)
    const blob = await response.blob()
    const writable = await (await directory.getFileHandle(name, { create: true })).createWritable()
    await writable.write(blob)
    await writable.close()
    bytes += blob.size
  }
  return { files: names.length, bytes }
}, { limit: PHOTOS, dir: OPFS_DIR })
console.log(`播种：${seeded.files} 张 / ${(seeded.bytes / 1048576).toFixed(1)} MB`)

const readyStart = Date.now()
await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
  timeout: 300_000,
})
console.log(`应用就绪耗时：${((Date.now() - readyStart) / 1000).toFixed(1)} s`)

const clicked = await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) =>
    b.textContent.includes('建立索引'),
  )
  if (button === undefined || button.disabled) return false
  button.click()
  return true
})
if (!clicked) throw new Error('「建立索引」按钮不可点')

const indexStart = Date.now()
let finished = false
while (Date.now() - indexStart < TIMEOUT_MS) {
  const text = await page.evaluate(() => {
    const main = document.body.innerText
    return { status: document.querySelector('.status')?.textContent ?? '', main }
  })
  console.log(
    `[${((Date.now() - indexStart) / 1000).toFixed(1)}s ui] ${text.status.replace(/\s+/g, ' ')}`,
  )
  if (/索引完成|出错了|中断|已停止/.test(text.main)) {
    finished = true
    break
  }
  await new Promise((r) => setTimeout(r, 1000))
}
console.log(`总计：${((Date.now() - indexStart) / 1000).toFixed(1)} s，结束=${finished}`)

await context.close()
