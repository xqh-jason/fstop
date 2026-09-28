/**
 * 人物面板封面探针：把「一张白图」到底是哪种坏法抓出来。
 *
 * 两种可能的坏法（现象一样，成因完全不同）：
 * A. 封面 img 被 `visibility: hidden`（`thumbStyle` 拿不到 `width/height` 时就走这条）→ 容器留白；
 * B. `width*scale` 在真实照片上算到几万像素（4000×3000 照片里的人脸 ~300 px → 放大 13 倍），
 *    超大可绘制尺寸导致 Chromium 不渲染。
 *
 * 做法：跑通样例 → 识别人脸 → 展开一个组 → 把每个 `.face` 的内联样式、rect、naturalWidth 读出来，
 * 并存一张人物面板截图（人眼/vision 复核）。
 */

import { chromium } from '@playwright/test'
import path from 'node:path'

const PORT = Number(process.env.PROBE_PORT ?? 5198)
const BASE = `http://127.0.0.1:${PORT}`
const PROFILE = path.resolve('.cache', 'bench-profile')

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  // 用笔记本真实视口量尺寸：面板宽度与格子大小都受它影响
  viewport: {
    width: Number(process.env.PROBE_VW ?? 1512),
    height: Number(process.env.PROBE_VH ?? 982),
  },
})
const page = context.pages()[0] ?? (await context.newPage())

const waitText = (pattern, timeout) =>
  page.waitForFunction((source) => new RegExp(source).test(document.body.innerText), pattern, {
    timeout,
  })

try {
  await page.goto(BASE, { waitUntil: 'load' })
  await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
    timeout: 300_000,
  })
  console.log('应用就绪')

  // PROBE_SKIP_SEED=1：不动数据，只看已有状态（配合 e2e-faces 刚跑完的库/缩略图检查封面）
  if (process.env.PROBE_SKIP_SEED !== '1') {
    await page.evaluate(() => document.querySelector('[data-testid="try-samples"]')?.click())
    await waitText('索引完成|出错了|已停止', 900_000)
    console.log('样例索引完成')
  } else {
    console.log('跳过播种（只看已有状态）')
  }

  await page.evaluate(() => document.querySelector('[data-testid="people-run"]')?.click())
  await waitText('共 \\d+ 张人脸', 900_000)
  await page.waitForTimeout(1500)

  // 展开第一个组（封面按钮就是展开按钮）
  await page.evaluate(() => document.querySelector('.person__cover')?.click())
  await page.waitForTimeout(1200)

  const dump = await page.evaluate(() => {
    const faces = [...document.querySelectorAll('.face, .face-crop')].map((node) => {
      const img = node.querySelector('img')
      const rect = node.getBoundingClientRect()
      return {
        cls: node.className,
        boxW: Math.round(rect.width),
        boxH: Math.round(rect.height),
        img存在: img !== null,
        img_src: img?.getAttribute('src')?.slice(0, 24) ?? null,
        img内联: img?.getAttribute('style') ?? null,
        img_visibility: img === null ? null : getComputedStyle(img).visibility,
        img_offsetW: img === null ? null : img.offsetWidth,
        img_offsetH: img === null ? null : img.offsetHeight,
        img_natural: img === null ? null : [img.naturalWidth, img.naturalHeight],
        node内联: node.getAttribute('style'),
      }
    })
    const covers = [...document.querySelectorAll('.person__cover')].map((node) => {
      const rect = node.getBoundingClientRect()
      const img = node.querySelector('img')
      return {
        boxW: Math.round(rect.width),
        boxH: Math.round(rect.height),
        img存在: img !== null,
        img内联: img?.getAttribute('style') ?? null,
        img_visibility: img === null ? null : getComputedStyle(img).visibility,
        img_offsetW: img === null ? null : img.offsetWidth,
        img_natural: img === null ? null : [img.naturalWidth, img.naturalHeight],
      }
    })
    return {
      faces,
      covers,
      text: document.querySelector('[data-testid="people-panel"]')?.innerText?.slice(0, 200),
    }
  })

  console.log('\n=== 封面（组）===')
  for (const [index, cover] of dump.covers.entries()) console.log(index, JSON.stringify(cover))
  console.log('\n=== 人脸格子（前 6 个）===')
  for (const [index, face] of dump.faces.slice(0, 6).entries())
    console.log(index, JSON.stringify(face))
  console.log(`\n人脸格子数：${String(dump.faces.length)}`)
  console.log(`面板文字：${dump.text ?? ''}`)

  // 裁切区到底有没有「内容」：按同一套比例把源缩略图的人脸区画进 canvas，
  // 算亮度标准差 —— 一整片纯色（旧 bug）会接近 0，真有五官会明显大。
  const variance = await page.evaluate(async () => {
    const out = []
    for (const cell of [...document.querySelectorAll('.face-crop')].slice(0, 6)) {
      const img = cell.querySelector('img')
      if (img === null) {
        out.push({ note: '没有 img' })
        continue
      }
      const style = getComputedStyle(cell)
      const num = (name) => Number.parseFloat(style.getPropertyValue(name))
      await img.decode().catch(() => null)
      const naturalWidth = img.naturalWidth
      const naturalHeight = img.naturalHeight
      // 与页面同一套变量换算：人脸长边 = 格子宽，人脸中心在 (fx, fy) 个人脸长边处
      const cellWidth = cell.offsetWidth
      const scale = img.offsetWidth / naturalWidth
      const side = Math.max(1, Math.round(cellWidth / scale))
      const cropX = Math.max(
        0,
        Math.min(naturalWidth - side, Math.round((num('--fx') * cellWidth) / scale - side / 2)),
      )
      const cropY = Math.max(
        0,
        Math.min(naturalHeight - side, Math.round((num('--fy') * cellWidth) / scale - side / 2)),
      )
      const canvas = document.createElement('canvas')
      canvas.width = side
      canvas.height = side
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, cropX, cropY, side, side, 0, 0, side, side)
      const data = ctx.getImageData(0, 0, side, side).data
      let sum = 0
      let sumSq = 0
      let count = 0
      for (let i = 0; i < data.length; i += 4) {
        const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
        sum += lum
        sumSq += lum * lum
        count += 1
      }
      const mean = sum / count
      const left = Number.parseFloat(style.left ?? '0') || 0
      void left
      out.push({
        cell: cellWidth,
        imgW: img.offsetWidth,
        sw: Number(num('--sw').toFixed(3)),
        fx: Number(num('--fx').toFixed(3)),
        fy: Number(num('--fy').toFixed(3)),
        crop: `${side}×${side} @ ${cropX},${cropY}`,
        mean: Number(mean.toFixed(1)),
        stddev: Number(Math.sqrt(Math.max(0, sumSq / count - mean * mean)).toFixed(2)),
      })
    }
    return out
  })
  console.log('\n裁切区像素统计（标准差小 = 一片纯色）：')
  for (const row of variance) console.log(' ', JSON.stringify(row))

  const panel = await page.$('[data-testid="people-panel"]')
  await panel?.screenshot({ path: '/tmp/people-panel.png' })
  console.log('\n截图：/tmp/people-panel.png')
} catch (error) {
  console.error('探针失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await context.close()
}
