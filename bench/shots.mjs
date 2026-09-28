/**
 * 出 README / 发布用的截图。
 *
 * 从**构建产物**取图，而不是 dev server：截图要跟别人下载到的东西一致。
 *
 * 用法：
 *   pnpm build && pnpm release:package
 *   node bench/shots.mjs                     # 默认读 release 产物，写到 ~/code/fstop-release/screenshots
 *   E2E_DIST=dist node bench/shots.mjs       # 指定要截的 dist 目录
 *   SHOTS_OUT=/tmp/shots node bench/shots.mjs
 *
 * 四张：① 索引进度 ② 检索结果 ③ 照片墙 ④ 离线能力面板。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { homedir } from 'node:os'
import { chromium } from '@playwright/test'

const DIST = resolve(process.env.E2E_DIST ?? join(homedir(), 'code/fstop-release/fstop-0.3.0-dist'))
const OUT = resolve(process.env.SHOTS_OUT ?? join(homedir(), 'code/fstop-release/screenshots'))
const PROFILE = resolve('.cache/bench-profile')
const PORT = Number(process.env.SHOTS_PORT ?? 5195)
const BASE = `http://127.0.0.1:${PORT}/`

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', BASE)
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  const path = join(DIST, rel === '/' ? 'index.html' : rel)
  try {
    const body = await readFile(path)
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})
await new Promise((done) => server.listen(PORT, '127.0.0.1', done))
mkdirSync(OUT, { recursive: true })

// 上一轮被强杀会在 profile 里留下单例锁，Chrome 见到它直接拒绝启动（其它 bench 脚本同样处理）
for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
  await rm(join(PROFILE, name), { force: true })
}

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  viewport: { width: 1512, height: 982 },
})
const page = context.pages()[0] ?? (await context.newPage())
const shot = async (name) => {
  const file = join(OUT, `${name}.png`)
  await page.screenshot({ path: file })
  console.log('✓', file)
}

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
// 冷缓存首次运行要下权重（131.8 MB），慢链路下可能好几分钟
await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
  timeout: 900_000,
})

// ① 索引进度：先滚到入口卡片，点下去立刻拍（进度条只在跑的时候存在）
await page.evaluate(() => {
  document
    .querySelector('[data-testid="try-samples"]')
    ?.closest('.card')
    ?.scrollIntoView({ block: 'center' })
})
await page.waitForTimeout(400)
await page.evaluate(() => document.querySelector('[data-testid="try-samples"]')?.click())
await page.waitForTimeout(1500)
await shot('01-indexing')

// 等索引跑完
await page.waitForFunction(() => /索引完成/.test(document.body.innerText), undefined, {
  timeout: 600_000,
})
await page.waitForTimeout(500)

// ② 检索结果：等结果行真的渲染出来（应用不打印「N 个结果」这种文字），再滚到结果区
await page.fill('input[type="search"]', '海边日落')
await page.click('button[type="submit"]')
await page.waitForFunction(() => document.querySelectorAll('li.result').length > 0, undefined, {
  timeout: 120_000,
})
await page.evaluate(() => document.querySelector('li.result')?.scrollIntoView({ block: 'start' }))
await page.waitForTimeout(3000)
await shot('02-search')

// ③ 照片墙：铺满宽度的那一屏
await page.evaluate(() => {
  const wall = [...document.querySelectorAll('button')].find((b) =>
    /浏览全部照片/.test(b.innerText),
  )
  wall?.click()
})
await page.waitForTimeout(4000)
await shot('03-wall')

// ④ 离线面板：把面板滚进视野再拍（它是页面里的一段，不是弹窗）
await page.evaluate(() => {
  document.querySelector('[data-testid="offline-panel"]')?.scrollIntoView({ block: 'center' })
})
await page.waitForTimeout(600)
await shot('04-offline')

await context.close()
server.close()
console.log('截图目录：', OUT)
