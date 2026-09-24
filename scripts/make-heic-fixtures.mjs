#!/usr/bin/env node
/**
 * HEIC / HEIF 夹具 —— 服务 §九 M0 第 3 项（HEIC 能否 `createImageBitmap` 解开）。
 *
 * 两类夹具，用途不同，不要混：
 * 1. `bench/fixtures/*.heic`：用 `sips` 从样例 JPEG 转出来的「教科书 HEIC」。
 *    只能回答「Chromium 有没有 HEIC 解码通路」，**不代表 iPhone 原图**——
 *    真机产物还有 HDR gain map、10-bit、Live Photo 容器等变体。
 * 2. `bench/fixtures/private/*`：把 iPhone 原图拷进来（默认从 `~/Pictures` 之外的路径手动指定），
 *    这才是第 3 项要的覆盖。该目录已 gitignore，不会入库。
 *
 * 用法：
 *   node scripts/make-heic-fixtures.mjs                       # 由样例库生成基准 HEIC
 *   node scripts/make-heic-fixtures.mjs <某个含 .heic 的目录>  # 同时收真实样张进 private/
 *
 * 非 macOS 没有 sips：脚本会跳过第 1 类并提示，第 2 类仍可手工放入。
 */

import { execFile } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const FIXTURES = path.join(process.cwd(), 'bench', 'fixtures')
const PRIVATE = path.join(FIXTURES, 'private')
const SAMPLES = path.join(process.cwd(), 'public', 'samples')

async function makeFromSamples() {
  if (process.platform !== 'darwin') {
    console.warn('⚠ 非 macOS：跳过 sips 生成，请手工放入 bench/fixtures/*.heic')
    return 0
  }
  const manifest = JSON.parse(await readFile(path.join(SAMPLES, 'manifest.json'), 'utf8'))
  const sources = manifest.slice(0, 3)
  await mkdir(FIXTURES, { recursive: true })
  for (const [index, entry] of sources.entries()) {
    const input = path.join(SAMPLES, entry.file)
    const output = path.join(FIXTURES, `sample-${index + 1}.heic`)
    await run('sips', ['-s', 'format', 'heic', input, '--out', output])
    console.log(`  ✓ ${path.basename(output)}  ← ${entry.file}`)
  }
  return sources.length
}

async function collectPrivate(sourceDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true })
  const heics = entries.filter((entry) => /\.(heic|heif|hif)$/i.test(entry.name))
  if (heics.length === 0) {
    console.warn(`⚠ ${sourceDir} 里没有 .heic/.heif 文件`)
    return 0
  }
  await mkdir(PRIVATE, { recursive: true })
  for (const entry of heics) {
    await copyFile(path.join(sourceDir, entry.name), path.join(PRIVATE, entry.name))
    console.log(`  ✓ private/${entry.name}`)
  }
  return heics.length
}

const sourceDir = process.argv[2]
const generated = await makeFromSamples()
const collected = sourceDir === undefined ? 0 : await collectPrivate(sourceDir)
console.log(`\n生成 ${generated} 个基准 HEIC，收进 ${collected} 个真实样张 → bench/fixtures/`)
