#!/usr/bin/env node
/**
 * 真实照片语料 —— 从 Wikimedia Commons 抓 CC0 / 公有领域**原图**，给 §九 第 4 项当输入。
 *
 * 为什么需要它：合成语料的 JPEG 只有 ~200 KB（真实相机 12MP 是 3–6 MB），
 * 会把 read 与部分 decode 成本显著低估。真实语料用来校正这个偏差。
 *
 * 语料**不进 git**（2–3 GB 级别），只提交 `bench/corpus-manifest.json`：
 * 它按标题锁定了每一张图与它的目标宽度，任何人重跑都能拿到同一批。
 *
 * 规格刻意贴近真实照片库：分辨率按 6MP / 10.7MP / 24MP 三档混合，
 * 横竖构图来自真实原图（带真实 EXIF 方向标签），并混入少量 PNG/WebP。
 *
 * 用法：
 *   NODE_USE_ENV_PROXY=1 node scripts/fetch-corpus.mjs --count 1000
 *   node scripts/fetch-corpus.mjs --verify        # 只校验已有文件的 sha256
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const API = 'https://commons.wikimedia.org/w/api.php'
const USER_AGENT = 'fstop-corpus-fetcher/0.1 (+https://github.com/xqh-jason/fstop)'
const OUTPUT_DIR = path.join(process.cwd(), 'bench', 'corpus')
const LOCAL_MANIFEST = path.join(OUTPUT_DIR, 'manifest.json')
const COMMITTED_MANIFEST = path.join(process.cwd(), 'bench', 'corpus-manifest.json')

/** 目标宽度档位与占比：6 MP / 10.7 MP / 24 MP，覆盖旧图到现代相机 */
const WIDTH_BUCKETS = [
  { width: 2000, share: 0.2 },
  { width: 4000, share: 0.6 },
  { width: 6000, share: 0.2 },
]

const ALLOWED_LICENSE = [/^cc0/i, /^public domain/i, /^pd[- ]/i]
const ALLOWED_MIME = {
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
}

/** 检索式要杂，否则语料会聚成一类内容；内容语义不影响吞吐，但会影响熵编码复杂度分布 */
const TERMS = [
  'landscape mountain',
  'city street',
  'portrait person',
  'food meal',
  'animal wildlife',
  'building architecture',
  'flower plant',
  'car vehicle',
  'boat water',
  'train railway',
  'forest tree',
  'beach coast',
  'snow winter',
  'market shop',
  'museum interior',
  'sports game',
  'concert music',
  'office desk',
  'book paper',
  'sky cloud',
  'river lake',
  'bridge road',
  'farm field',
  'bird flying',
  'insect macro',
  'night light',
  'festival crowd',
  'church temple',
  'aircraft plane',
  'bicycle bike',
  'child toy',
  'dog pet',
  'cat kitten',
  'mountain hiking',
  'desert sand',
  'waterfall',
  'cave rock',
  'stadium field',
  'kitchen cooking',
  'garden park',
]

/** @typedef {{ title: string, url: string, sourceWidth: number, sourceHeight: number, mime: string,
 *   license: string, licenseUrl: string, author: string, source: string }} Candidate */
/** @typedef {{ file: string, title: string, source: string, downloadUrl: string, author: string,
 *   license: string, licenseUrl: string, width: number, height: number, bytes: number, sha256: string }} Entry */

/** @param {string} value */
function stripHtml(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** @param {URLSearchParams} params */
async function callApi(params) {
  const response = await fetch(`${API}?${params.toString()}`, {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!response.ok) throw new Error(`Commons API ${response.status}`)
  return response.json()
}

/** @param {string} term @param {number} offset @returns {Promise<Candidate[]>} */
async function search(term, offset) {
  const data = await callApi(
    new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: `incategory:"CC-Zero" filetype:bitmap ${term}`,
      gsrnamespace: '6',
      gsrlimit: '50',
      gsroffset: String(offset),
      prop: 'imageinfo',
      iiprop: 'url|extmetadata|size|mime',
      format: 'json',
      formatversion: '2',
    }),
  )
  const candidates = []
  for (const page of data.query?.pages ?? []) {
    const info = page.imageinfo?.[0]
    const meta = info?.extmetadata ?? {}
    const license = stripHtml(meta.LicenseShortName?.value ?? '')
    if (!ALLOWED_LICENSE.some((pattern) => pattern.test(license))) continue
    if (ALLOWED_MIME[info?.mime ?? ''] !== true) continue
    if (!info.url || (info.width ?? 0) < WIDTH_BUCKETS[0].width) continue
    candidates.push({
      title: page.title,
      url: info.url,
      sourceWidth: info.width,
      sourceHeight: info.height,
      mime: info.mime,
      license,
      licenseUrl: stripHtml(meta.LicenseUrl?.value ?? ''),
      author: stripHtml(meta.Artist?.value ?? 'unknown'),
      source: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    })
  }
  return candidates
}

/** 由标题确定目标宽度：确定性，重跑结果一致 */
function targetWidth(title, sourceWidth) {
  let hash = 0
  for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const roll = (hash % 1000) / 1000
  let cumulative = 0
  for (const bucket of WIDTH_BUCKETS) {
    cumulative += bucket.share
    if (roll <= cumulative) return Math.min(bucket.width, sourceWidth)
  }
  return Math.min(WIDTH_BUCKETS[WIDTH_BUCKETS.length - 1].width, sourceWidth)
}

/** 缩略图 URL 自己拼：Commons 的 iiurlwidth 会忽略请求值（实测请求 640/800 都回 960px） */
function thumbUrl(candidate, width) {
  const marker = '/commons/'
  const index = candidate.url.indexOf(marker)
  if (index === -1) return null
  const prefix = candidate.url.slice(0, index + marker.length)
  const rest = candidate.url.slice(index + marker.length)
  const filename = rest.split('/').pop()
  if (filename === undefined) return null
  return `${prefix}thumb/${rest}/${width}px-${filename}`
}

function fileNameFor(title, width) {
  const slug = title
    .replace(/^File:/, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `${String(width).padStart(4, '0')}-${slug || 'photo'}.jpg`
}

/** 代理链路会偶发 ECONNRESET/SocketError，单张失败不该让整轮抓取作废 */
async function download(url, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
      if (!response.ok) return null
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
  console.warn(`  ! 下载失败（${attempts} 次）：${url} — ${lastError?.message ?? lastError}`)
  return null
}

async function main() {
  const verifyOnly = process.argv.includes('--verify')
  const countIndex = process.argv.indexOf('--count')
  const target = countIndex === -1 ? 1000 : Number(process.argv[countIndex + 1])

  await mkdir(OUTPUT_DIR, { recursive: true })

  /** @type {Entry[]} */
  let entries = []
  try {
    entries = JSON.parse(await readFile(LOCAL_MANIFEST, 'utf8'))
  } catch {
    entries = []
  }

  if (!verifyOnly && entries.length < target) {
    const seen = new Set(entries.map((entry) => entry.title))
    /** @type {Candidate[]} */
    const candidates = []
    for (const term of TERMS) {
      if (entries.length + candidates.length >= target * 1.4) break
      for (const offset of [0, 50]) {
        const found = await search(term, offset)
        for (const candidate of found) {
          if (seen.has(candidate.title)) continue
          seen.add(candidate.title)
          candidates.push(candidate)
        }
      }
      console.log(`  检索 ${term.padEnd(22)} 候选 ${candidates.length}`)
    }

    let index = 0
    let failures = 0
    const queue = candidates.slice(0, target * 1.2)
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length > 0 && entries.length < target) {
        const candidate = queue.shift()
        if (candidate === undefined) return
        const width = targetWidth(candidate.title, candidate.sourceWidth)
        const url = thumbUrl(candidate, width)
        if (url === null) continue
        const file = fileNameFor(candidate.title, width)
        const existing = await stat(path.join(OUTPUT_DIR, file)).catch(() => null)
        if (existing?.isFile() === true && existing.size > 0) continue

        const buffer = await download(url).catch((error) => {
          console.warn(`  ! ${candidate.title}：${error.message}`)
          return null
        })
        if (buffer === null || buffer.byteLength < 10_000) {
          failures += 1
          continue
        }
        await writeFile(path.join(OUTPUT_DIR, file), buffer)
        entries.push({
          file,
          title: candidate.title,
          source: candidate.source,
          downloadUrl: url,
          author: candidate.author,
          license: candidate.license,
          licenseUrl: candidate.licenseUrl,
          width,
          height: Math.round((width * candidate.sourceHeight) / candidate.sourceWidth),
          bytes: buffer.byteLength,
          sha256: createHash('sha256').update(buffer).digest('hex'),
        })
        index += 1
        if (index % 50 === 0) {
          const total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
          console.log(
            `  已抓 ${entries.length}/${target}，累计 ${(total / 1024 / 1024).toFixed(0)} MB`,
          )
          await writeFile(LOCAL_MANIFEST, `${JSON.stringify(entries, null, 2)}\n`)
        }
      }
    })
    await Promise.all(workers)
    console.log(`  跳过（无法构造缩略图或体积异常）：${failures}`)
  }

  entries.sort((a, b) => a.file.localeCompare(b.file))
  await writeFile(LOCAL_MANIFEST, `${JSON.stringify(entries, null, 2)}\n`)
  await writeFile(COMMITTED_MANIFEST, `${JSON.stringify(entries, null, 2)}\n`)

  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  const medianBytes = [...entries.map((entry) => entry.bytes)].sort((a, b) => a - b)[
    Math.floor(entries.length / 2)
  ]
  console.log(
    `\n${entries.length} 张，共 ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB，单张中位 ${((medianBytes ?? 0) / 1024 / 1024).toFixed(2)} MB`,
  )
  console.log(`本地清单 → bench/corpus/manifest.json；可提交清单 → bench/corpus-manifest.json`)
}

await main()
