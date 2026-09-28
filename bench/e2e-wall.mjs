/**
 * 端到端验证：照片墙的虚拟滚动（M1）。
 *
 * 为什么不只靠单测：窗口计算与 LRU 都有单测，但「万张级只渲染可视行」这件事
 * 依赖真实布局（容器高度、CSS grid、滚动容器），必须在真浏览器里数 DOM 节点。
 *
 * 断言：
 *   1. 索引 200 张后打开照片墙，渲染的格子数**远小于**总数（有界窗口）；
 *   2. 滚到底部：格子数仍有界，且能滚动到最后一行的照片；
 *   3. 缩略图 src 是 blob:（走 LRU 缓存与显式 revoke 的那条路），不是原始路径。
 *
 * 用法：先 pnpm dev --port 5198 --host 127.0.0.1，再 node bench/e2e-wall.mjs
 */
import { chromium } from '@playwright/test'
import path from 'node:path'

const PORT = Number(process.env.PROBE_PORT ?? 5198)
const PHOTOS = Number(process.env.PROBE_PHOTOS ?? 200)
const OPFS_DIR = process.env.PROBE_OPFS ?? `wall-corpus-${Date.now()}`
const BASE = `http://127.0.0.1:${PORT}`
const PROFILE = path.resolve('.cache', 'bench-profile')

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  args: ['--use-webgpu', '--enable-dawn-features=use_dxc'],
})
const page = context.pages()[0] ?? (await context.newPage())
page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`))

await page.goto(`${BASE}/?root=opfs&opfs=${OPFS_DIR}`, { waitUntil: 'load' })

const seeded = await page.evaluate(
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
    return names.length
  },
  { limit: PHOTOS, dir: OPFS_DIR },
)
console.log(`播种 ${String(seeded)} 张`)

await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
  timeout: 300_000,
})
await page.locator('button', { hasText: '建立索引' }).click()
await page.waitForFunction(() => /索引完成/.test(document.body.innerText), undefined, {
  timeout: 300_000,
})
const indexedText = await page.locator('.status').first().textContent()
console.log(`✓ 索引完成：${String(indexedText).trim()}`)

// 打开照片墙
await page.locator('button', { hasText: '浏览全部照片' }).click()
await page.waitForSelector('[data-testid="photo-wall"]', { timeout: 30_000 })
// 等缩略图加载出第一屏
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="photo-wall"] img').length > 0,
  undefined,
  { timeout: 60_000 },
)

const top = await page.evaluate(() => {
  const wall = document.querySelector('[data-testid="photo-wall"]')
  return {
    cells: wall?.querySelectorAll('li').length ?? 0,
    images: wall?.querySelectorAll('img').length ?? 0,
    blobSrcs: [...(wall?.querySelectorAll('img') ?? [])].filter((img) =>
      img.src.startsWith('blob:'),
    ).length,
    scrollHeight: wall?.scrollHeight ?? 0,
    clientHeight: wall?.clientHeight ?? 0,
  }
})
console.log('首屏：', JSON.stringify(top))

if (top.cells >= seeded / 2)
  throw new Error(`虚拟滚动没生效：渲染了 ${top.cells} 个格子（共 ${seeded} 张）`)
if (top.cells === 0) throw new Error('照片墙一个格子都没渲染')
if (top.blobSrcs === 0) throw new Error('缩略图没有走 objectURL 通路')
console.log(`✓ 首屏只渲染 ${top.cells} 个格子 / 共 ${seeded} 张`)

// 滚到底
const bottom = await page.evaluate(async () => {
  const wall = document.querySelector('[data-testid="photo-wall"]')
  if (wall === null) throw new Error('找不到照片墙')
  wall.scrollTop = wall.scrollHeight
  await new Promise((resolve) => setTimeout(resolve, 800))
  return {
    cells: wall.querySelectorAll('li').length,
    images: wall.querySelectorAll('img').length,
    scrollTop: wall.scrollTop,
    lastTitle: wall.querySelector('li:last-child')?.getAttribute('title') ?? null,
  }
})
console.log('底部：', JSON.stringify(bottom))
if (bottom.scrollTop === 0) throw new Error('滚不动：撑高可能是 0（虚拟滚动的经典 bug）')
if (bottom.cells >= seeded / 2) throw new Error(`滚动后渲染仍然过多：${bottom.cells}`)
console.log(`✓ 滚到底仍有界（${bottom.cells} 个格子），最后一格是 ${String(bottom.lastTitle)}`)

await context.close()
console.log('全部通过')
