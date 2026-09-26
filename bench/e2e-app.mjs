/**
 * 产品路径端到端：播种 OPFS 语料 → 建立索引 → 检索 → 增量复扫（`pnpm e2e`）。
 *
 * 为什么必须有它：单测覆盖的是 `src/core/` 的判断，基准覆盖的是 worker 与存储的吞吐，
 * 而**「用户点一下会发生什么」**这条链路（`src/app/index-runner.ts` + `App.vue`）只有端到端能证明。
 * 原生目录选择器 `showDirectoryPicker` 无法被自动化驱动，所以走 `?root=opfs` 的合成根——
 * 与基准同一条通路，扫描/解码/嵌入/入库的代码路径完全一致。
 *
 * 顺带把「运行时零外发」的断言从基准页扩展到**产品页**（计划 §11.4）：
 * 除模型 origin 外任何请求都点名并让进程非零退出。
 */

import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

const PORT = Number(process.env.E2E_PORT ?? 5199)
const CORPUS_LIMIT = Number(process.env.E2E_PHOTOS ?? 40)
const OPFS_DIR = process.env.E2E_OPFS ?? 'e2e-corpus'
const QUERIES = ['雪地里的狗', '夜晚的城市', '山顶日出']
const HEADED = process.argv.includes('--headed')
/** 模型权重可以从这些 host 下载（首次冷缓存）；其余一律视为违规外发 */
const MODEL_HOSTS = ['huggingface.co', 'cdn-lfs.huggingface.co', 'hf-mirror.com']

const failures = []
function check(label, condition, detail = '') {
  const mark = condition ? '✓' : '✗'
  console.log(`${mark} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(label)
}

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
      // 必须钉死 IPv4：Vite 默认只监听 ::1，而 Node 的 localhost 可能解析到 127.0.0.1
      // （实测踩过：curl 对 127.0.0.1 返回 000、对 [::1] 返回 200）
      '--host',
      '127.0.0.1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  server.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`))
  server.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`))
  const base = `http://127.0.0.1:${PORT}`
  let context = null

  try {
    await waitForServer(`${base}/bench/corpus/manifest.json`, 120_000)
    const profileDir = path.resolve('.cache', 'bench-profile')
    await mkdir(profileDir, { recursive: true })
    // 被强杀会留下陈旧单例锁，Chrome 见到它直接拒绝启动
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      await rm(path.join(profileDir, name), { force: true })
    }
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: !HEADED,
    })
    const page = context.pages()[0] ?? (await context.newPage())

    const pageErrors = []
    page.on('pageerror', (error) => {
      pageErrors.push(String(error))
      console.error(`[pageerror] ${error}`)
    })
    const external = new Set()
    context.on('request', (request) => {
      const url = new URL(request.url())
      // 只统计真正会出网的协议：blob:/data: 的 host 是空串，会被误判成「外部 origin」
      // （照片墙与结果网格都用 blob: 显示缩略图，实测踩到过一次假红）
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return
      external.add(url.host)
    })

    // ——— 0. 确定性重置：先在**同源静态资源**上清 OPFS，再进应用 ———
    // 为什么不能进应用后再清：boot() 已经打开了 sqlite VFS 与向量文件，
    // 删除目录 = 句柄指向被 unlink 的文件（写入静默丢失，最难查的那种）。
    // 历史踩坑：上一版留下的孤儿 `.crswap` 交换文件会让新会话读到 0 字节的向量文件。
    await page.goto(`${base}/vite.svg`, { waitUntil: 'load' })
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

    await page.goto(`${base}/?root=opfs&opfs=${OPFS_DIR}`, { waitUntil: 'load' })

    // ——— 1. 播种：把 dev server 上的真实语料写进 OPFS（相当于「用户选定的文件夹」） ———
    const seeded = await page.evaluate(async (limit) => {
      const manifest = await (await fetch('/bench/corpus/manifest.json')).json()
      const names = manifest
        .map((entry) => entry.file)
        .filter(Boolean)
        .slice(0, limit)
      const root = await navigator.storage.getDirectory()
      const directory = await root.getDirectoryHandle('e2e-corpus', { create: true })
      let bytes = 0
      for (const name of names) {
        const response = await fetch(
          `/bench/corpus/${name.split('/').map(encodeURIComponent).join('/')}`,
        )
        if (!response.ok) throw new Error(`语料取回失败 HTTP ${response.status}：${name}`)
        const blob = await response.blob()
        const handle = await directory.getFileHandle(name, { create: true })
        const writable = await handle.createWritable()
        await writable.write(blob)
        await writable.close()
        bytes += blob.size
      }
      return { files: names.length, bytes }
    }, CORPUS_LIMIT)
    console.log(`播种：${seeded.files} 张 / ${(seeded.bytes / 1048576).toFixed(1)} MB`)
    check('语料已进 OPFS', seeded.files === CORPUS_LIMIT, `${seeded.files} 张`)

    // 等**就绪**，不是等按钮出现：按钮在 DOM 里一直有，模型没加载完时点它会走守卫分支
    // （首轮就是这么假失败的：脚本点得太早、页面弹了句误导性的提示、然后一直等完成状态）
    await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
      timeout: 300_000,
    })

    // ——— 2. 建立索引 ———
    const clickIndex = () =>
      page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find((b) =>
          b.textContent.includes('建立索引'),
        )
        if (button === undefined || button.disabled) return false
        button.click()
        return true
      })
    const readStatus = () =>
      page.evaluate(() => {
        const text = [...document.querySelectorAll('.card')]
          .map((card) => card.innerText)
          .join(' | ')
        const match = text.match(
          /正在扫描[^|]*|正在比对[^|]*|正在建立索引[^|]*|索引完成[^|]*|已停止[^|]*|出错了[^|]*|中断[^|]*/,
        )
        return {
          status: (match ? match[0] : '').trim(),
          notice: text.match(/初始化失败[^|]*/)?.[0] ?? null,
        }
      })

    check('应用已就绪（模型与向量矩阵）', true)
    check('「建立索引」按钮可用', await clickIndex())
    await page.waitForFunction(
      () => /索引完成|出错了|中断|已停止/.test(document.body.innerText),
      undefined,
      { timeout: 900_000 },
    )
    const first = await readStatus()
    console.log(`第一轮：${first.status}`)
    const firstDone = Number(first.status.match(/索引完成：(\d+)/)?.[1] ?? -1)
    const firstFailed = Number(first.status.match(/失败 (\d+)/)?.[1] ?? -1)
    const firstSkipped = Number(first.status.match(/跳过 (\d+)/)?.[1] ?? -1)
    check('索引完成且没有失败', /索引完成/.test(first.status) && firstFailed === 0, first.status)
    check('索引张数等于语料张数', firstDone === CORPUS_LIMIT, `${firstDone}/${CORPUS_LIMIT}`)
    if (firstSkipped > 0) console.log(`  注意：跳过 ${firstSkipped} 张（不支持的格式或解码失败）`)

    // ——— 3. 检索 ———
    for (const query of QUERIES) {
      await page.fill('input[type="search"]', query)
      await page.click('button[type="submit"]')
      try {
        await page.waitForFunction(
          () =>
            document.querySelectorAll('.result__path').length > 0 ||
            /索引还是空的/.test(document.body.innerText),
          undefined,
          { timeout: 120_000 },
        )
      } catch (error) {
        const state = await page.evaluate(() => ({
          ready: document.body.dataset.ready,
          text: document.body.innerText.slice(0, 800),
        }))
        console.error(`检索「${query}」没出结果，页面状态：`, JSON.stringify(state, null, 2))
        throw error
      }
      // 结果先出现、缩略图后补齐（首次命中要解码生成，属预期行为）→ 轮询等缩略图。
      // 注意：缩略图未就绪时模板里的 `v-if` 根本不渲染 <img>，所以判据必须是
      // 「有命中 → 至少一张缩略图」，否则「0 个 img」会被当成就绪（踩过，假红）。
      try {
        await page.waitForFunction(
          () => {
            const hits = document.querySelectorAll('.result__path').length
            if (hits === 0) return true
            return document.querySelectorAll('img.result__thumb').length > 0
          },
          undefined,
          { timeout: 60_000 },
        )
      } catch {
        // 超时不算失败：下面的断言会如实报出「0 张缩略图」并让进程非零退出
      }
      const outcome = await page.evaluate(() => ({
        paths: [...document.querySelectorAll('.result__path')].map(
          (node) => node.textContent ?? '',
        ),
        scores: [...document.querySelectorAll('.result__score')].map((node) =>
          Number(node.textContent),
        ),
        thumbs: [...document.querySelectorAll('img.result__thumb')].filter(
          (img) => (img.src ?? '') !== '',
        ).length,
        note: document.querySelector('.status')?.textContent ?? '',
      }))
      const sorted = outcome.scores.every(
        (score, index) => index === 0 || outcome.scores[index - 1] >= score,
      )
      console.log(
        `查询「${query}」→ ${outcome.paths.length} 条命中、${outcome.thumbs} 张缩略图、最高分 ${outcome.scores[0]?.toFixed(3)}`,
      )
      console.log(`   首位：${outcome.paths[0] ?? '（无）'}`)
      check(`检索「${query}」有命中`, outcome.paths.length > 0, `${outcome.paths.length} 条`)
      check(`检索「${query}」分数单调不增`, sorted)
      check(`检索「${query}」缩略图渲染`, outcome.thumbs > 0, `${outcome.thumbs} 张`)
    }

    // ——— 4. 增量复扫：再点一次必须几乎全是 unchanged，不重复算 ———
    check('再点「建立索引」可点', await clickIndex())
    await page.waitForFunction(
      () => /索引完成|出错了|中断/.test(document.body.innerText),
      undefined,
      { timeout: 300_000 },
    )
    const second = await readStatus()
    console.log(`第二轮（增量）：${second.status}`)
    check(
      '增量复扫零失败',
      /索引完成/.test(second.status) && !/失败 [1-9]/.test(second.status),
      second.status,
    )
    check(
      '增量复扫后张数不变',
      Number(second.status.match(/索引完成：(\d+)/)?.[1] ?? -1) === CORPUS_LIMIT,
    )

    // ——— 4.5 结果重排（M2）：切「按时间」后顺序真的变了，且首尾确是新/旧两端 ———
    const sortState = await page.evaluate(async () => {
      const select = document.querySelector('[data-testid="result-order"]')
      if (select === null) return null
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      const readPaths = () =>
        [...document.querySelectorAll('.result__path')].map((node) => node.textContent ?? '')
      const similarity = readPaths()
      setter?.call(select, 'newest')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 100))
      const newest = readPaths()
      const times = [...document.querySelectorAll('.result__time')].map((n) => n.textContent ?? '')
      setter?.call(select, 'oldest')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 100))
      const oldest = readPaths()
      return { similarity, newest, oldest, times }
    })
    check('排序控件存在', sortState !== null)
    if (sortState !== null) {
      const { similarity, newest, oldest } = sortState
      check('切成「按时间」后顺序改变', JSON.stringify(newest) !== JSON.stringify(similarity))
      check(
        '新旧两个方向的顺序互为反向',
        JSON.stringify([...newest].reverse()) === JSON.stringify(oldest),
      )
      check('时间列已渲染', sortState.times.length > 0, `${sortState.times.length} 行`)
      const parsed = sortState.times
        .map((text) => (text === '时间未知' ? null : Date.parse(text)))
        .filter((value) => value !== null)
      const descending = parsed.every((value, index) => index === 0 || parsed[index - 1] >= value)
      check('「新→旧」确实按时间不增排列', descending, sortState.times[0] ?? '')
    }

    // ——— 4.6 离线能力面板（M2）：应用自己的账本必须和外部请求钩子一致 ———
    const panelState = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="offline-panel"]')
      if (panel === null) return null
      const verdict = document.querySelector('[data-testid="offline-verdict"]')
      const rows = [...panel.querySelectorAll('tbody tr')].map((row) => ({
        host: row.querySelector('.offline__host')?.textContent?.trim() ?? '',
        kind: row.getAttribute('data-kind') ?? '',
      }))
      return {
        verdict: verdict?.textContent?.trim().replace(/\s+/g, ' ') ?? '',
        clean: verdict?.getAttribute('data-clean') ?? '',
        hosts: rows,
        violationRows: rows.filter((row) => row.kind === 'external').length,
        text: panel.textContent?.replace(/\s+/g, ' ').slice(0, 300) ?? '',
      }
    })

    // ——— 5. 运行时零外发（产品页）———
    const offenders = [...external].filter(
      (host) => !MODEL_HOSTS.some((allowed) => host.endsWith(allowed)),
    )
    const modelHits = [...external].filter((host) =>
      MODEL_HOSTS.some((allowed) => host.endsWith(allowed)),
    )
    check('除模型 origin 外零请求', offenders.length === 0, offenders.join(', ') || '无')
    if (modelHits.length > 0) {
      // 冷缓存首访会去 HuggingFace 取权重：这是唯一允许的外部 origin（计划 §11.4）
      console.log(`  模型 origin：${modelHits.join(', ')}（冷缓存时才会出现）`)
    }
    check('没有页面未捕获异常', pageErrors.length === 0, pageErrors[0] ?? '无')

    // ——— 6. 离线能力面板（M2）：应用自己的账本必须与脚本的外部请求钩子一致 ———
    check('离线能力面板已渲染', panelState !== null)
    if (panelState !== null) {
      check('面板判定「本会话零违规外发」', panelState.clean === 'true', panelState.verdict)
      check(
        '面板账本里没有 external 行',
        panelState.violationRows === 0,
        JSON.stringify(panelState.hosts.slice(0, 5)),
      )
      check(
        '面板账本记录了本机请求',
        panelState.hosts.some((host) => host.kind === 'local'),
        panelState.hosts.map((host) => `${host.kind}:${host.host}`).join(', '),
      )
      // 两套独立记账必须互相印证：脚本抓到过外部 host，面板就不能说零违规
      check(
        '面板与脚本的外发判定一致',
        offenders.length > 0 ? panelState.violationRows > 0 : panelState.violationRows === 0,
        `脚本 ${String(offenders.length)} 个 / 面板 ${String(panelState.violationRows)} 行`,
      )
      check('面板显示本机占用', /向量/.test(panelState.text), panelState.text.slice(0, 120))
    }
  } finally {
    await context?.close()
    server.kill('SIGTERM')
  }

  if (failures.length > 0) {
    console.error(`\n端到端失败 ${failures.length} 项：\n - ${failures.join('\n - ')}`)
    process.exitCode = 1
    return
  }
  console.log('\n端到端全部通过：扫描 → 增量判断 → 入库 → 逐条处理 → 检索 全链路正常。')
}

await main()
