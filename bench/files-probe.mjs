/**
 * `files` 模式静默失败根因探针 —— M0 实测记录 §8 第 7 项。
 *
 * 已知现象（§6）：`setInputFiles` 给 `<input webkitdirectory>` 塞**软链目录**时
 * `input.files.length` 恒为 0（静默），塞真实目录正常。但根因未钉死：
 * 是 Chromium 枚举时**逐项过滤软链**，还是**整个枚举中断**？硬链呢？混合目录呢？
 * M1 的 Playwright 端到端要复用 files 模式，必须先知道边界在哪。
 *
 * 方法：脱离业务代码，直接对 `<input webkitdirectory>` 塞 4 种目录，
 * 读回 `files.length` / 文件名 / `webkitRelativePath`：
 *   real     —— 3 张真实 JPEG（复制）
 *   hardlink —— 3 个硬链接
 *   softlink —— 3 个软链接
 *   mixed    —— 1 张真实 + 1 个软链（区分「逐项过滤」与「枚举中断」）
 *
 * 用法：`node bench/files-probe.mjs`
 */

import { chromium } from '@playwright/test'
import { copyFileSync, linkSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const project = path.resolve(here, '..')
const base = path.resolve(project, '.cache', 'files-probe')
const profileRoot = path.join(base, 'profiles')

/** 准备 4 种目录形态，源文件取 bench/corpus 的前 3 张真实 JPEG */
async function prepareCases() {
  rmSync(base, { recursive: true, force: true })
  await mkdir(profileRoot, { recursive: true })
  const corpusDir = path.join(project, 'bench', 'corpus')
  const sources = (await readdir(corpusDir)).filter((name) => name.endsWith('.jpg')).slice(0, 3)
  if (sources.length < 3) throw new Error('bench/corpus 里不足 3 张 JPEG，先跑语料抓取')
  const cases = { real: [], hardlink: [], softlink: [], mixed: [] }
  for (const name of Object.keys(cases)) {
    const dir = path.join(base, name)
    await mkdir(dir)
    cases[name] = dir
  }
  for (const [index, source] of sources.entries()) {
    const from = path.join(corpusDir, source)
    copyFileSync(from, path.join(cases.real, source))
    linkSync(from, path.join(cases.hardlink, source))
    symlinkSync(from, path.join(cases.softlink, source))
    if (index < 2) {
      copyFileSync(from, path.join(cases.mixed, `real-${source}`))
    } else {
      symlinkSync(from, path.join(cases.mixed, `link-${source}`))
    }
  }
  return cases
}

/** 单个目录 → 持久化 profile 的 headless Chrome → 读回 input 的文件列表 */
async function probeCase(label, dir) {
  const profileDir = path.join(profileRoot, label)
  await mkdir(profileDir, { recursive: true })
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    rmSync(path.join(profileDir, lock), { force: true })
  }
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: true,
  })
  try {
    const page = context.pages()[0] ?? (await context.newPage())
    page.on('pageerror', (error) => console.log(`  [pageerror] ${error.message}`))
    await page.setContent('<input id="f" type="file" webkitdirectory multiple>')
    await page.setInputFiles('#f', dir)
    return await page.evaluate(() => {
      const files = [...document.getElementById('f').files]
      return {
        length: files.length,
        names: files.map((file) => file.name),
        relativePaths: files.map((file) => file.webkitRelativePath),
        sizes: files.map((file) => file.size),
      }
    })
  } finally {
    await context.close()
  }
}

const cases = await prepareCases()
console.log(`探针目录：${base}\n`)
for (const [label, dir] of Object.entries(cases)) {
  const onDisk = readdirSync(dir).length
  try {
    const result = await probeCase(label, dir)
    const seen =
      result.length === onDisk ? '=' : result.length < onDisk ? '<（有丢失）' : '>（异常）'
    console.log(`${label.padEnd(9)} 磁盘 ${onDisk} 项 → input ${result.length} 项 ${seen}`)
    console.log(`          names: ${JSON.stringify(result.names)}`)
    console.log(`          relativePaths: ${JSON.stringify(result.relativePaths)}`)
    console.log(`          sizes: ${JSON.stringify(result.sizes)}`)
  } catch (error) {
    console.log(`${label.padEnd(9)} 探针失败：${error.message.split('\n')[0]}`)
  }
}
