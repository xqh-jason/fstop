#!/usr/bin/env node
/**
 * 样例图片库 —— 从 Wikimedia Commons 取 **CC0 / 公有领域** 图片，供内置 demo 与 M0 基准使用。
 *
 * 为什么需要它：访客点开就应能试语义检索，而要求访客授权整个照片文件夹的转化率接近于零（§九 M0 交付物 2）。
 *
 * 许可纪律：
 * - 只接受 LicenseShortName 为 CC0 / Public domain 的文件；有署名义务的（CC BY、CC BY-SA）一律不要，
 *   避免「一个文件一条署名链」的维护成本。
 * - 每张图的来源页、作者、许可、sha256、字节数全部写进 `public/samples/manifest.json`。
 *   该清单是**唯一真相源**，禁止手改；NOTICE 只引用它。
 *   `discoveredBy` 只是「用哪条检索式找到的」，**不是内容标注**（Commons 搜索相关性有限，
 *   例如用 bird 检索到的可能是湖景）。不要拿它当评测标签。
 * - 清单一旦存在即视为已锁定：默认按清单里的 downloadUrl 重取并校验 sha256，
 *   只有 `--refresh` 才会重新检索（搜索结果顺序会漂移）。
 *
 * 用法：
 *   node scripts/fetch-samples.mjs             # 按清单补齐缺失文件并校验
 *   node scripts/fetch-samples.mjs --refresh   # 重新检索并重建清单
 *
 * 代理环境：Node 的 fetch 默认不读 HTTP(S)_PROXY，需要 `NODE_USE_ENV_PROXY=1 node scripts/fetch-samples.mjs`。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const API = 'https://commons.wikimedia.org/w/api.php'
const USER_AGENT = 'fstop-sample-fetcher/0.1 (+https://github.com/xqh-jason/fstop)'
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'samples')
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')

/** Wikimedia 忽略 iiurlwidth、固定回 960px 桶（实测），单张约 190 KB，故每主题取 2 张 */
const THUMB_WIDTH = 640
const MIN_SOURCE_WIDTH = 800
const PER_THEME = 2
const MAX_TOTAL_BYTES = 9 * 1024 * 1024

const ALLOWED_LICENSE = [/^cc0/i, /^public domain/i, /^pd[- ]/i]
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** 主题要覆盖语义检索能问出的东西；每个主题的 query 就是检索词本身 */
const THEMES = [
  { theme: 'coffee-breakfast', query: 'coffee cup breakfast table' },
  { theme: 'dog-snow', query: 'dog snow' },
  { theme: 'cat-indoor', query: 'cat indoor' },
  { theme: 'mountain-sunrise', query: 'mountain sunrise landscape' },
  { theme: 'beach-sunset', query: 'beach sunset sea' },
  { theme: 'city-skyline-night', query: 'city skyline night' },
  { theme: 'bicycle-street', query: 'bicycle street' },
  { theme: 'red-flower', query: 'red flower closeup' },
  { theme: 'star-night-sky', query: 'night sky stars' },
  { theme: 'book-page-text', query: 'open book pages text' },
  { theme: 'car-vintage', query: 'vintage car' },
  { theme: 'child-playground', query: 'children playground' },
  { theme: 'train-station', query: 'train station platform' },
  { theme: 'forest-path', query: 'forest path trees' },
  { theme: 'bird-water', query: 'bird water lake' },
  { theme: 'street-food-market', query: 'street food market' },
  { theme: 'keyboard-desk', query: 'keyboard desk computer' },
  { theme: 'guitar-music', query: 'guitar music instrument' },
  { theme: 'temple-architecture', query: 'temple architecture' },
  { theme: 'boat-harbor', query: 'boat harbor' },
]

/** @typedef {{ theme: string, query: string }} Theme */
/** @typedef {{
 *   file: string, title: string, source: string, downloadUrl: string,
 *   author: string, license: string, licenseUrl: string,
 *   width: number, height: number, bytes: number, sha256: string,
 *   discoveredBy: string, description: string,
 * }} SampleEntry */

/** @param {string} value */
function stripHtml(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** @param {string} title */
function slugify(title, theme, index) {
  const base = title
    .replace(/^File:/, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
  return `${theme}-${String(index + 1).padStart(2, '0')}-${base || 'photo'}.jpg`
}

/** @param {URLSearchParams} params */
async function callApi(params) {
  const url = `${API}?${params.toString()}`
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok) throw new Error(`Commons API ${response.status} for ${url}`)
  return response.json()
}

/** @param {{ theme: string, query: string }} theme @param {Set<string>} used */
async function discoverTheme(theme, used) {
  const data = await callApi(
    new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: `incategory:"CC-Zero" filetype:bitmap ${theme.query}`,
      gsrnamespace: '6',
      gsrlimit: '12',
      prop: 'imageinfo',
      iiprop: 'url|extmetadata|size|mime',
      iiurlwidth: String(THUMB_WIDTH),
      format: 'json',
      formatversion: '2',
    }),
  )

  /** @type {SampleEntry[]} */
  const picked = []
  for (const page of data.query?.pages ?? []) {
    if (picked.length >= PER_THEME) break
    if (used.has(page.title)) continue

    const info = page.imageinfo?.[0]
    const meta = info?.extmetadata ?? {}
    const license = stripHtml(meta.LicenseShortName?.value ?? '')
    const mime = info?.mime ?? ''
    const isAllowedLicense = ALLOWED_LICENSE.some((pattern) => pattern.test(license))

    if (!isAllowedLicense || !ALLOWED_MIME.has(mime)) continue
    if (!info.thumburl || (info.width ?? 0) < MIN_SOURCE_WIDTH) continue

    const thumbUrl = (info.thumburl ?? '').split('?')[0]
    if (thumbUrl === '') continue

    // Wikimedia 会忽略 iiurlwidth、返回固定档位（实测请求 640/800 都回 960px）：
    // 因此宽度以 URL 里的 `NNNpx-` 为准，高度按原图宽高比推导，而不是信 thumbwidth。
    const urlWidth = Number(/\/thumb\/.*\/(\d+)px-[^/]+$/.exec(thumbUrl)?.[1] ?? 0)
    const width = urlWidth > 0 ? urlWidth : (info.thumbwidth ?? 0)
    const height =
      urlWidth > 0 ? Math.round((urlWidth * (info.height ?? 0)) / (info.width ?? 1)) : 0
    if (width === 0 || height === 0) continue

    used.add(page.title)
    picked.push({
      file: slugify(page.title, theme.theme, picked.length),
      title: page.title,
      source: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
      downloadUrl: thumbUrl,
      author: stripHtml(meta.Artist?.value ?? 'unknown'),
      license,
      licenseUrl: stripHtml(meta.LicenseUrl?.value ?? ''),
      width,
      height,
      bytes: 0,
      sha256: '',
      discoveredBy: theme.theme,
      description: stripHtml(meta.ImageDescription?.value ?? '').slice(0, 160),
    })
  }
  return picked
}

/** @param {string} url */
async function download(url) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok) throw new Error(`download ${response.status} for ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

/** @param {Buffer} buffer @param {string} file */
async function verifyExisting(buffer, file) {
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  if (sha256 !== file) throw new Error(`sha256 不匹配`)
}

async function main() {
  const refresh = process.argv.includes('--refresh')
  await mkdir(OUTPUT_DIR, { recursive: true })

  /** @type {SampleEntry[]} */
  let entries = []
  if (!refresh) {
    try {
      entries = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
    } catch {
      entries = []
    }
  }

  if (entries.length === 0) {
    const used = new Set()
    for (const theme of THEMES) {
      const picked = await discoverTheme(theme, used)
      if (picked.length === 0) console.warn(`⚠ 主题 ${theme.theme} 没有符合许可的候选`)
      entries.push(...picked)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    entries.sort((a, b) => a.file.localeCompare(b.file))
  }

  let totalBytes = 0
  for (const entry of entries) {
    const target = path.join(OUTPUT_DIR, entry.file)
    let buffer
    try {
      buffer = await readFile(target)
      if (entry.sha256) await verifyExisting(buffer, entry.sha256)
    } catch {
      buffer = await download(entry.downloadUrl)
      await writeFile(target, buffer)
    }
    entry.bytes = buffer.byteLength
    entry.sha256 = createHash('sha256').update(buffer).digest('hex')
    totalBytes += buffer.byteLength
    console.log(
      `  ${entry.file.padEnd(46)} ${entry.license.padEnd(14)} ${entry.width}x${entry.height}  ${(buffer.byteLength / 1024).toFixed(0)} KB`,
    )
  }

  await writeFile(MANIFEST_PATH, `${JSON.stringify(entries, null, 2)}\n`)
  const megabytes = totalBytes / 1024 / 1024
  console.log(
    `\n${entries.length} 张，共 ${megabytes.toFixed(2)} MB → public/samples/manifest.json`,
  )
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(
      `样例库超过 ${MAX_TOTAL_BYTES / 1024 / 1024} MB 预算，请调小 THUMB_WIDTH 或减主题`,
    )
  }
}

await main()
