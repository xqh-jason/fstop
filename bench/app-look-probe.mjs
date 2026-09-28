/**
 * 整页外观检查：在真实视口下把应用从头到尾截一遍，看哪块区域的图片被裁得只剩一角。
 * 只读，不改数据（用已有的持久 profile 状态）。
 */
import path from 'node:path'
import { chromium } from '@playwright/test'

const PORT = Number(process.env.PROBE_PORT ?? 5198)
const BASE = `http://127.0.0.1:${PORT}`
const PROFILE = path.resolve('.cache', 'bench-profile')

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  viewport: {
    width: Number(process.env.PROBE_VW ?? 1512),
    height: Number(process.env.PROBE_VH ?? 982),
  },
})
const page = context.pages()[0] ?? (await context.newPage())
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
  timeout: 120_000,
})
await page.waitForTimeout(2500)

// 量一遍所有缩略图的呈现方式：naturalWidth/naturalHeight 与盒子尺寸之比，
// 比出来就知道是「整图缩放」还是「裁切只露一角」。
const report = await page.evaluate(() => {
  const rows = []
  const nodes = [...document.querySelectorAll('img')].filter((img) => img.offsetWidth > 0)
  for (const img of nodes.slice(0, 24)) {
    const box = img.getBoundingClientRect()
    const objectFit = getComputedStyle(img).objectFit
    rows.push({
      cls: img.parentElement?.className ?? '',
      natural: `${String(img.naturalWidth)}×${String(img.naturalHeight)}`,
      box: `${String(Math.round(box.width))}×${String(Math.round(box.height))}`,
      fit: objectFit,
      over: Number((img.offsetWidth / Math.max(1, img.naturalWidth)).toFixed(2)),
    })
  }
  return {
    rows,
    bodyWidth: document.body.clientWidth,
    shellWidth: document.querySelector('main')?.clientWidth,
  }
})
console.log('视口', report.bodyWidth, '主容器', report.shellWidth)
for (const row of report.rows) console.log(' ', JSON.stringify(row))

await page.screenshot({ path: '/tmp/app-full-1.png', fullPage: false })
// 往下滚两屏，覆盖照片墙与人物面板
await page.evaluate(() => window.scrollBy(0, window.innerHeight))
await page.waitForTimeout(1200)
await page.screenshot({ path: '/tmp/app-full-2.png' })
await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2))
await page.waitForTimeout(1200)
await page.screenshot({ path: '/tmp/app-full-3.png' })
console.log('截图：/tmp/app-full-1.png /tmp/app-full-2.png /tmp/app-full-3.png')

await context.close()
