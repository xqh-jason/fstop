/**
 * M3 端到端：**构建产物**能不能当静态站点跑，以及「打开即可体验」这条通不通。
 *
 * 为什么单独一个脚本（而不是复用 `bench/e2e-app.mjs`）：
 * `e2e-app` 跑的是 dev server（源码 + HMR + 未打包的资源图），它证明不了发布形态。
 * 发布要看的是 `dist/`：ORT 与 sqlite 的 wasm 是否同源、样例库能否被索引、
 * 面板对自己的 origin 会不会误报。这些只有「静态托管构建产物」才暴露 —— 本轮就是这么
 * 抓到 `egress-ledger` 把 app 自己的 origin 判成 external 的。
 *
 * 用法：
 *   pnpm build && node bench/e2e-samples.mjs      # 默认静态托管 dist/（端口 5190）
 *   E2E_PORT=6001 node bench/e2e-samples.mjs
 *   E2E_DIST=~/code/fstop-release/fstop-0.3.0-dist node bench/e2e-samples.mjs   # 验证发布物本身
 */

import { chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const DIST = path.resolve(process.env.E2E_DIST ?? 'dist')
const PORT = Number(process.env.E2E_PORT ?? 5190)
// 挂载前缀：用来验证「部署在子路径下」的形态（GitHub Pages 的项目站就是 /<repo>/）
const BASE_PATH = (process.env.E2E_BASE_PATH ?? '/').replace(/\/*$/, '/')
const BASE = `http://127.0.0.1:${PORT}${BASE_PATH}`
/**
 * 样例库张数**从清单读**，不写死：写死过一次 40（真实是 39，`ls | wc -l` 把 manifest.json
 * 也算进去了），结果端到端红在一句「39/40」上 —— 断言数字写死就会这样烂掉。
 */
const SAMPLE_COUNT = JSON.parse(
  await readFile(path.resolve('public/samples/manifest.json'), 'utf8'),
).length
const PROFILE = path.resolve('.cache', 'bench-profile')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

/** 极简静态服务器：只服务 dist/，等价于「把纯静态产物部署到任何静态托管」 */
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', BASE)
  const pathname = decodeURIComponent(url.pathname)
  // 前缀之外的路径一律 404 —— 真实的子路径托管也是这个行为
  if (!pathname.startsWith(BASE_PATH)) {
    response.writeHead(404)
    response.end('not found')
    return
  }
  const mounted = pathname.slice(BASE_PATH.length)
  const rel = mounted === '' ? '/index.html' : `/${mounted}`
  const file = path.join(DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  readFile(file)
    .then((buffer) => {
      response.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      })
      response.end(buffer)
    })
    .catch(() => {
      // SPA 回退到 index.html
      readFile(path.join(DIST, 'index.html'))
        .then((buffer) => {
          response.writeHead(200, { 'content-type': MIME['.html'] })
          response.end(buffer)
        })
        .catch(() => {
          response.writeHead(404)
          response.end('not found')
        })
    })
})
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

const failures = []
function check(label, ok, detail = '') {
  const mark = ok ? '✓' : '✗'
  console.log(`${mark} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  args: ['--use-webgpu'],
})
const page = context.pages()[0] ?? (await context.newPage())

/** 真实请求的 host 记账（与离线面板同一口径的独立一份：脚本侧不看页面自述） */
const hosts = new Map()
const pageErrors = []
page.on('request', (request) => {
  const url = new URL(request.url())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return
  hosts.set(url.host, (hosts.get(url.host) ?? 0) + 1)
})
page.on('pageerror', (error) => {
  pageErrors.push(error.message)
})

try {
  const indexResponse = await page.goto(BASE, { waitUntil: 'load' })
  check(
    '构建产物可被静态托管打开',
    indexResponse?.status() === 200,
    `HTTP ${String(indexResponse?.status())}`,
  )

  await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
    timeout: 300_000,
  })
  check('构建产物里应用就绪（模型与向量矩阵装配完成）', true)

  // ——— 「打开即可体验」：不选目录，直接索引内置样例 ———
  const clicked = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="try-samples"]')
    if (button === null || button.disabled) return false
    button.click()
    return true
  })
  check('「先试用内置样例」按钮可点', clicked)

  // 只认**终态**词：进度首帧是「正在建立索引… 0/0（跳过 0、失败 0）」，
  // 把「失败」写进等待正则会立刻命中，断言于是读到首帧（e2e-app 首轮就栽在这上面）
  await page.waitForFunction(
    () => /索引完成|出错了|索引中断|已停止/.test(document.body.innerText),
    undefined,
    { timeout: 900_000 },
  )
  const status = await page.evaluate(() =>
    [...document.querySelectorAll('.card')].map((card) => card.innerText).join(' | '),
  )
  const done = Number(status.match(/索引完成：(\d+)/)?.[1] ?? -1)
  const failed = Number(status.match(/失败 (\d+)/)?.[1] ?? -1)
  check(
    '内置样例索引完成且没有失败',
    /索引完成/.test(status) && failed === 0,
    `完成 ${String(done)}`,
  )
  check('索引张数等于样例库张数', done === SAMPLE_COUNT, `${String(done)}/${String(SAMPLE_COUNT)}`)

  // ——— 检索 ———
  await page.fill('input[type="search"]', 'a sunset over the sea')
  await page.click('button[type="submit"]')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="result-thumb"], .result, figure').length > 0,
    undefined,
    { timeout: 120_000 },
  )
  const hits = await page.evaluate(() => document.querySelectorAll('figure, .result').length)
  check('构建产物里检索有结果', hits > 0, `${String(hits)} 个结果`)

  // ——— 离线面板：同一个坑的另一面 —— 面板不能对自己的 origin 报警 ———
  const panel = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="offline-panel"]')
    if (node === null) return null
    return {
      text: node.innerText,
      verdict: document.querySelector('[data-testid="offline-verdict"]')?.innerText ?? '',
    }
  })
  check('离线面板已渲染', panel !== null)
  const ledgerLocal = /本机/.test(panel?.text ?? '')
  check(
    '面板把自身 origin 记成「本机」而不是违规',
    ledgerLocal && !/违规/.test(panel?.verdict ?? ''),
    panel?.verdict ?? '',
  )

  // ——— 脚本侧的独立核对：只有自己的 origin 与模型 origin ———
  const own = new URL(BASE).host
  const MODEL_HOSTS = [
    'huggingface.co',
    'cdn-lfs.huggingface.co',
    'cdn-lfs-us-1.huggingface.co',
    'hf-mirror.com',
    'hf.co',
  ]
  const offenders = [...hosts.keys()].filter(
    (host) =>
      host !== own &&
      !MODEL_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)),
  )
  check('构建产物没有模型 origin 之外的外发', offenders.length === 0, offenders.join(', ') || '无')
  const ownHits = hosts.get(own) ?? 0
  check('自身静态资源确实从本机 origin 加载', ownHits > 0, `${String(ownHits)} 次`)
  console.log(`  host 账本：${JSON.stringify([...hosts.entries()])}`)
  check('没有页面未捕获异常', pageErrors.length === 0, pageErrors[0] ?? '无')
} catch (error) {
  failures.push(`异常：${error instanceof Error ? error.message : String(error)}`)
  console.error(error)
} finally {
  await context.close()
  server.close()
}

if (failures.length === 0) {
  console.log(
    '\n端到端通过：构建产物可静态部署，「打开即可体验」通路正常，自身 origin 不被误判为外发。',
  )
  process.exit(0)
}
console.log(`\n端到端失败 ${String(failures.length)} 项：`)
for (const failure of failures) console.log(` - ${failure}`)
process.exit(1)
