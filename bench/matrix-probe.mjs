/**
 * 临时诊断（收尾删除）：检索「0 张已落盘」的直接观测。
 * 在产品页自己的环境里读 OPFS 向量文件的真实大小 + db 里的 matrixOffset 分布，
 * 对照出「哪一层把数据弄丢」：写入没落盘（文件 0 字节）vs 槽位映射错（文件有数据、offset 对不上）。
 */
import { chromium } from '@playwright/test'
import path from 'node:path'

const PORT = Number(process.env.PROBE_PORT ?? 5198)
const OPFS_DIR = process.env.PROBE_OPFS ?? 'matri-corpus'
const BASE = `http://127.0.0.1:${PORT}`
const PROFILE = path.resolve('.cache', 'bench-profile')

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  args: ['--use-webgpu', '--enable-dawn-features=use_dxc'],
})
const page = context.pages()[0] ?? (await context.newPage())
page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`))
page.on('console', (message) => {
  const text = message.text()
  if (/\[vector\]/.test(text)) console.log(`[console] ${text}`)
})

await page.goto(`${BASE}/?root=opfs&opfs=${OPFS_DIR}`, { waitUntil: 'load' })

// 播种（与 e2e-app 相同：真语料）
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
  { limit: 12, dir: OPFS_DIR },
)
console.log(`播种 ${String(seeded)}`)

await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
  timeout: 300_000,
})
await page.locator('button', { hasText: '建立索引' }).click()
await page.waitForFunction(() => /索引完成/.test(document.body.innerText), undefined, {
  timeout: 300_000,
})
console.log('✓ 索引完成')

const probe = await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  const out = { vectorDir: [], files: [] }
  try {
    const vectors = await root.getDirectoryHandle('fstop-vectors')
    for await (const [name, handle] of vectors.entries()) {
      if (handle.kind === 'file') {
        const file = await handle.getFile()
        out.vectorDir.push({ name, size: file.size })
      }
    }
  } catch (error) {
    out.vectorDir = [`读取失败：${String(error)}`]
  }
  return out
})
console.log('OPFS 向量文件：', JSON.stringify(probe, null, 2))

// 再补一发真实检索，看 ranked 与矩阵可读槽数
await page.fill('input[type="search"]', '雪地里的狗')
await page.click('button[type="submit"]')
await page.waitForFunction(
  () =>
    /库内/.test(document.body.innerText) || document.querySelectorAll('.result__path').length > 0,
  undefined,
  { timeout: 120_000 },
)
const searchState = await page.evaluate(() => ({
  note: [...document.querySelectorAll('.status')].map((node) => node.textContent).join(' | '),
  results: document.querySelectorAll('.result__path').length,
}))
console.log('检索后状态：', JSON.stringify(searchState))

await context.close()
