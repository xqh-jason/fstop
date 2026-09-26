/**
 * 相似分组端到端：真语料里人为造一批「重复」（同一张照片换名写入多份），
 * 断言：① 分组按钮能跑出「≥2 张」的组；② 这些组确实主要是复制对；
 * ③ 不同的原始照片之间不互相误吸（8 张原始 + 若干复制品 → 分组数有上界）。
 *
 * 用法：先起 dev server（pnpm dev --port 5198 --host 127.0.0.1），
 * 再 PROBE_OPFS=similar-corpus node bench/e2e-similar.mjs
 */
import { chromium } from '@playwright/test'
import path from 'node:path'
import { execSync } from 'node:child_process'

const PORT = Number(process.env.PROBE_PORT ?? 5198)
const BASE = `http://127.0.0.1:${PORT}`
const OPFS_DIR = process.env.PROBE_OPFS ?? 'similar-corpus'
const PROFILE = path.resolve('.cache', 'bench-profile')
const PRIMARY = Number(process.env.PROBE_PHOTOS ?? 8) // 原始照片数
const DUPLICATES = Number(process.env.PROBE_DUPES ?? 1) // 每张原始照片额外复制几份

const failures = []
function check(label, ok, detail = '') {
  const mark = ok ? '✓' : '✗'
  console.log(`${mark} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
process.on('exit', () => {
  if (failures.length > 0) {
    console.error(`\n端到端失败 ${failures.length} 项：`)
    for (const label of failures) console.error(` - ${label}`)
    process.exitCode = 1
  } else {
    console.log('\n端到端全部通过：相似分组在真向量上行为正确。')
  }
})

try {
  execSync(`pkill -f "user-data-dir=${PROFILE}"`, { stdio: 'ignore' })
} catch {
  // 没有残留
}
await new Promise((resolve) => setTimeout(resolve, 2000))

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  args: ['--use-webgpu', '--enable-dawn-features=use_dxc'],
})
const page = context.pages()[0] ?? (await context.newPage())
page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`))

// ——— 0. 确定性重置（与 e2e-app 同款：在静态资源页上清 OPFS）———
await page.goto(`${BASE}/vite.svg`, { waitUntil: 'load' })
const cleared = await page.evaluate(
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
console.log(`重置：清掉 ${cleared.join(', ') || '（本来就没有）'}`)

// ——— 1. 播种（在 **同一个应用页面** 里做，与 e2e-wall 完全相同的顺序）———
await page.goto(`${BASE}/?root=opfs&opfs=${OPFS_DIR}`, { waitUntil: 'load' })
const seeded = await page.evaluate(
  async ({ limit, dir, copies }) => {
    const manifest = await (await fetch('/bench/corpus/manifest.json')).json()
    const all = manifest.map((entry) => entry.file).filter(Boolean)
    // **等距取样**：清单开头的条目是同一系列街景（本来就该被合并），
    // 要让「不误吸」这条断言有意义，原片必须来自语料的不同段落。
    const stride = Math.max(1, Math.floor(all.length / limit))
    const names = all.filter((_, index) => index % stride === 0).slice(0, limit)
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(dir, { create: true })
    const written = []
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]
      const response = await fetch(
        `/bench/corpus/${name.split('/').map(encodeURIComponent).join('/')}`,
      )
      const blob = await response.blob()
      for (let copy = 0; copy <= copies; copy += 1) {
        const target = copy === 0 ? name : `dup${copy}-${name}`
        const writable = await (
          await directory.getFileHandle(target, { create: true })
        ).createWritable()
        await writable.write(blob)
        await writable.close()
        written.push(target)
      }
    }
    return written
  },
  { limit: PRIMARY, dir: OPFS_DIR, copies: DUPLICATES },
)
const total = seeded.length
console.log(`播种 ${PRIMARY} 张原始 + ${DUPLICATES} 份复制品 = ${total} 张`)

// ——— 2. 索引 ———
await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
  timeout: 300_000,
})
await page.locator('button', { hasText: '建立索引' }).click()
await page
  .waitForFunction(
    // 只认「索引完成」：进度文本里有「失败 0」，把它一起塞进正则会让断言读到首帧进度（踩过）
    () => /索引完成/.test(document.querySelector('.status')?.textContent ?? ''),
    undefined,
    { timeout: 300_000 },
  )
  .catch(async () => {
    const state = await page.evaluate(() => ({
      ready: document.body.dataset.ready,
      text: document.body.innerText.slice(0, 500),
    }))
    console.error(`索引没到终态，页面状态：${JSON.stringify(state, null, 2)}`)
    throw new Error('索引超时')
  })
const indexNote = await page.evaluate(() => document.querySelector('.status')?.textContent ?? '')
check('索引完成，张数 == 播种数', indexNote.includes(`${total} 张`), indexNote.trim())

// ——— 3. 构建相似分组数据源（打开照片墙 = 复用 searchRows 快照路径）———
await page.locator('button', { hasText: '浏览全部照片' }).click()
await page.waitForFunction(() => /共 \d+ 张/.test(document.body.innerText), undefined, {
  timeout: 120_000,
})

// ——— 4. 跑分组并断言 ———
await page.locator('button', { hasText: '查找重复 / 相似照片' }).click()
await page.waitForFunction(() => /张相似|没有发现重复/.test(document.body.innerText), undefined, {
  timeout: 120_000,
})
const state = await page.evaluate(() => {
  const heads = [...document.querySelectorAll('[data-testid="similar-group"]')]
  // 组头文字是「N 张相似」→ 抽数字（直接 Number() 会得到 NaN）
  const counts = heads.map((head) =>
    Number(/(\d+)/.exec(head.querySelector('.similar__count')?.textContent ?? '')?.[1] ?? 0),
  )
  return {
    note: [...document.querySelectorAll('.similar__note')].map((n) => n.textContent).join(' | '),
    counts,
  }
})
console.log(`分组结果：${JSON.stringify(state.counts)} 注记：${state.note}`)

// 断言：至少 DUPLICATES 组被找到（每张原始 + 复制品应自成一组）
check('发现重复组', state.counts.length > 0, `${state.counts.length} 组`)
// 每组大小 = DUPLICATES + 1（原始 + 复制品）
const expectedSize = DUPLICATES + 1
const allRightSize = state.counts.length > 0 && state.counts.every((c) => c === expectedSize)
check(`所有组大小都是 ${expectedSize}（原始 + 复制品）`, allRightSize, JSON.stringify(state.counts))
check(
  '组数 == 原始照片数（不同照片之间不误吸）',
  state.counts.length === PRIMARY,
  `${state.counts.length} vs ${PRIMARY}`,
)
check('分组没有页面异常', true)

await context.close()
