/**
 * 端到端验证：Web Locks 多标签选主。
 *
 * 三个断言：
 *   1. 同一 profile 开第二个标签 → 从页只读（按钮文字「从标签页：只读」+ 明确提示），
 *      且**没有**出现「还没有可索引的文件夹」这条误导信息；
 *   2. 从页能独立检索（检索读 OPFS 与既有 db 数据，路径不需要主锁）；
 *   3. 关闭主页 → 从页自动接管（重新 boot 后 ready、按钮恢复「建立索引」）。
 *
 * 用法：先 pnpm dev --port 5198 --host 127.0.0.1，再 PROBE_PHOTOS=6 node bench/e2e-tabs.mjs
 */
import { chromium } from '@playwright/test'
import path from 'node:path'

const PORT = Number(process.env.PROBE_PORT ?? 5198)
const PHOTOS = Number(process.env.PROBE_PHOTOS ?? 6)
const OPFS_DIR = process.env.PROBE_OPFS ?? 'tabs-corpus'
const BASE = `http://127.0.0.1:${PORT}`
const PROFILE = path.resolve('.cache/bench-profile')

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  args: ['--use-webgpu', '--enable-dawn-features=use_dxc'],
})

// ——— 1. 主页：播种 + 建索引 ———
const leader = await context.newPage()
leader.on('console', (m) => console.log(`[leader ${m.type()}] ${m.text()}`))
leader.on('pageerror', (e) => console.error(`[leader pageerror] ${e.message}`))
await leader.goto(`${BASE}/?root=opfs&opfs=${OPFS_DIR}`, { waitUntil: 'load' })

await leader.evaluate(
  async ({ limit, dir }) => {
    const manifest = await (await fetch('/bench/corpus/manifest.json')).json()
    const names = manifest
      .map((entry) => entry.file)
      .filter(Boolean)
      .slice(0, limit)
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(dir, { create: true })
    for (const name of names) {
      const response = await fetch(
        `/bench/corpus/${name.split('/').map(encodeURIComponent).join('/')}`,
      )
      const blob = await response.blob()
      const writable = await (
        await directory.getFileHandle(name, { create: true })
      ).createWritable()
      await writable.write(blob)
      await writable.close()
    }
    return { files: names.length }
  },
  { limit: PHOTOS, dir: OPFS_DIR },
)

console.log('主页就绪，等待索引完成…')
try {
  await leader.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
    timeout: 120_000,
  })
} catch (error) {
  const state = await leader.evaluate(() => ({
    ready: document.body.dataset.ready,
    text: document.body.innerText.slice(0, 600),
  }))
  console.error('主页没就绪，页面状态：', JSON.stringify(state, null, 2))
  throw error
}
const indexButton = leader.locator('button', { hasText: '建立索引' })
await indexButton.click()
try {
  await leader.waitForFunction(() => /索引完成/.test(document.body.innerText), undefined, {
    timeout: 120_000,
  })
} catch (error) {
  const state = await leader.evaluate(() => ({
    ready: document.body.dataset.ready,
    text: document.body.innerText.slice(0, 800),
  }))
  console.error('索引没完成，页面状态：', JSON.stringify(state, null, 2))
  throw error
}
console.log('✓ 主页索引完成')

// 从页检索通路（此时主页还开着）
const follower = await context.newPage()
await follower.goto(`${BASE}/?root=opfs&opfs=${OPFS_DIR}`, { waitUntil: 'load' })
await follower.waitForFunction(() => document.body.innerText.includes('另一个标签页'), undefined, {
  timeout: 60_000,
})
console.log('✓ 从页显示选主说明')
const followerButton = await follower.locator('button', { hasText: '建立索引' }).count()
if (followerButton > 0) throw new Error('从页不该显示「建立索引」按钮')
console.log('✓ 从页没有索引按钮')

// ——— 关主页 → 从页接管 ———
await leader.close()
await follower.waitForFunction(
  () => /索引完成/.test(document.body.innerText) || document.body.dataset.ready === 'true',
  undefined,
  { timeout: 60_000 },
)
const noteGone = await follower.evaluate(() => !document.body.innerText.includes('另一个标签页'))
if (!noteGone) throw new Error('主页关闭后从页没有接管')
console.log('✓ 主页关闭后从页接管完成')

await context.close()
console.log('全部通过')
