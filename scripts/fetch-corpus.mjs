#!/usr/bin/env node
/**
 * 真实照片语料 —— 从 Wikimedia Commons 抓 CC0 / 公有领域**原图**，给 docs/BENCHMARKS.md 第 4 项当输入。
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

/**
 * 目标档位与占比。宽度必须是 Wikimedia 缩略图服务**已验证可服务**的档位：
 * 实测 1280 / 1920 / 3840 返回 200，而 2000 / 2560 直接 400 —— 任意宽度已经不被接受。
 * 第三档直接用**原图**，这才是真实相机 JPEG 的体积（3–10 MB），是校正合成语料偏差的关键。
 */
const WIDTH_BUCKETS = [
  { kind: 'thumb', width: 1920, share: 0.2 },
  { kind: 'thumb', width: 3840, share: 0.6 },
  { kind: 'original', width: 0, share: 0.2 },
]

/** 原图档的上限：Commons 里不少原图是几十 MB 的 TIFF/PNG，那不是「照片库」的样子 */
const MAX_ORIGINAL_BYTES = 12 * 1024 * 1024

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
 *   sourceBytes: number, license: string, licenseUrl: string, author: string, source: string }} Candidate */
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
  const url = `${API}?${params.toString()}`
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
      if (!response.ok) throw new Error(`Commons API ${response.status}`)
      return await response.json()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
    }
  }
  throw lastError
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
      iiprop: 'url|extmetadata|size|mime|metadata',
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
    // 要**相机拍的照片**，不是博物馆扫描件：后者熵低、体积小，会把 read/decode 成本带偏。
    // EXIF 里有相机型号是可靠信号（实测：不加这条过滤，候选会被 MET 的水彩扫描淹没）。
    const hasCamera = (info.metadata ?? []).some(
      (entry) => entry.name === 'Model' || entry.name === 'Make',
    )
    if (!hasCamera) continue
    candidates.push({
      title: page.title,
      // API 现在会给 url 附带 utm 查询串，直接拿它拼缩略图 URL 会 404
      url: info.url.split('?')[0],
      sourceWidth: info.width,
      sourceHeight: info.height,
      sourceBytes: info.size ?? 0,
      mime: info.mime,
      license,
      licenseUrl: stripHtml(meta.LicenseUrl?.value ?? ''),
      author: stripHtml(meta.Artist?.value ?? 'unknown'),
      source: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    })
  }
  return candidates
}

/** 由标题确定目标档位：确定性，重跑结果一致 */
function targetBucket(title) {
  let hash = 0
  for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const roll = (hash % 1000) / 1000
  let cumulative = 0
  for (const bucket of WIDTH_BUCKETS) {
    cumulative += bucket.share
    if (roll <= cumulative) return bucket
  }
  return WIDTH_BUCKETS[WIDTH_BUCKETS.length - 1]
}

/** Wikimedia 缩略图服务已验证可服务的宽度档（任意宽度会被 400 拒绝） */
const THUMB_WIDTHS = [1280, 1920, 3840]

/**
 * 解析下载地址。返回首选、兜底与**实际目标宽度**：
 * 原图比目标档窄时退到更小的可用档，再不行就用原图——不能静默跳过（否则候选会被大量浪费）。
 */
function resolveUrls(candidate, bucket) {
  const marker = '/commons/'
  const index = candidate.url.indexOf(marker)
  const thumbFor = (width) => {
    if (index === -1 || width >= candidate.sourceWidth) return null
    const prefix = candidate.url.slice(0, index + marker.length)
    const rest = candidate.url.slice(index + marker.length)
    const filename = rest.split('/').pop()
    return filename === undefined ? null : `${prefix}thumb/${rest}/${width}px-${filename}`
  }

  const wanted = bucket.kind === 'original' ? candidate.sourceWidth : bucket.width
  const usable = THUMB_WIDTHS.filter((width) => width <= Math.min(wanted, candidate.sourceWidth))
  const chosen = usable.length === 0 ? null : usable[usable.length - 1]
  const thumb = chosen === null ? null : thumbFor(chosen)

  if (bucket.kind === 'original' && candidate.sourceBytes <= MAX_ORIGINAL_BYTES) {
    return { primary: candidate.url, fallback: thumb, width: candidate.sourceWidth }
  }
  return {
    primary: thumb ?? candidate.url,
    fallback: candidate.url,
    width: thumb === null ? candidate.sourceWidth : chosen,
  }
}

/**
 * 文件名必须**唯一**：标题截断后 slug 会撞车（实测 381 条清单只落 350 个文件，
 * 即两条不同标题指向同一个文件名、后者覆盖前者）。因此在结尾附上标题哈希。
 */
function fileNameFor(title, label) {
  const slug = title
    .replace(/^File:/, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
  let hash = 0
  for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `${label}-${slug || 'photo'}-${hash.toString(36).slice(0, 6)}.jpg`
}

/** 代理链路会偶发 ECONNRESET/SocketError；Wikimedia 在并发高时会限流，两者都要退避 */
async function download(url, attempts = 4) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
      if (response.ok) return Buffer.from(await response.arrayBuffer())
      // 429/403 是限流信号：退避后再试，不要当成「这张图不可用」
      if (response.status === 429 || response.status === 403) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
        lastError = new Error(`HTTP ${response.status}`)
        continue
      }
      return null
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
  let loaded = []
  try {
    loaded = JSON.parse(await readFile(LOCAL_MANIFEST, 'utf8'))
  } catch {
    loaded = []
  }
  // 清单必须只描述**磁盘上真实存在、文件名唯一、内容与 sha256 一致**的文件：
  // 文件名碰撞（长标题截断、哈希前缀相同）会让两个条目指向同一路径，
  // 后写覆盖前者，前者的哈希随即过期——这种条目必须剔除，否则「可复现」是空话。
  const entries = []
  const seenFiles = new Set()
  let dropped = 0
  for (const entry of loaded) {
    if (seenFiles.has(entry.file)) {
      dropped += 1
      continue
    }
    const buffer = await readFile(path.join(OUTPUT_DIR, entry.file)).catch(() => null)
    if (buffer === null) {
      dropped += 1
      continue
    }
    const digest = createHash('sha256').update(buffer).digest('hex')
    if (digest !== entry.sha256) {
      dropped += 1
      continue
    }
    seenFiles.add(entry.file)
    entries.push(entry)
  }
  if (dropped > 0) {
    console.warn(`清单里有 ${dropped} 条重复、缺失或哈希不匹配，已剔除`)
  }

  if (verifyOnly) {
    let checked = 0
    let mismatched = 0
    for (const entry of entries) {
      const buffer = await readFile(path.join(OUTPUT_DIR, entry.file)).catch(() => null)
      if (buffer === null) {
        console.warn(`  ✗ 缺失：${entry.file}`)
        mismatched += 1
        continue
      }
      const digest = createHash('sha256').update(buffer).digest('hex')
      if (digest !== entry.sha256) {
        console.warn(`  ✗ sha256 不匹配：${entry.file}`)
        mismatched += 1
        continue
      }
      checked += 1
    }
    console.log(`校验 ${checked}/${entries.length} 张，异常 ${mismatched} 张`)
    if (mismatched > 0) process.exitCode = 1
    return
  }

  if (entries.length < target) {
    const seen = new Set(entries.map((entry) => entry.title))
    /** @type {Candidate[]} */
    const candidates = []
    for (const term of TERMS) {
      if (entries.length + candidates.length >= target * 1.4) break
      for (const offset of [0, 50, 100, 150]) {
        const found = await search(term, offset).catch((error) => {
          console.warn(`  ! 检索失败 ${term}@${offset}：${error.message}`)
          return []
        })
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
        const bucket = targetBucket(candidate.title)
        const plan = resolveUrls(candidate, bucket)
        const file = fileNameFor(
          candidate.title,
          bucket.kind === 'original' ? 'orig' : String(plan.width),
        )
        const existing = await stat(path.join(OUTPUT_DIR, file)).catch(() => null)
        if (existing?.isFile() === true && existing.size > 0) continue

        let usedUrl = plan.primary
        let buffer = await download(plan.primary).catch(() => null)
        if ((buffer === null || buffer.byteLength < 10_000) && plan.fallback !== null) {
          buffer = await download(plan.fallback).catch(() => null)
          usedUrl = plan.fallback
        }
        if (buffer === null || buffer.byteLength < 10_000) {
          failures += 1
          continue
        }
        await writeFile(path.join(OUTPUT_DIR, file), buffer)
        const isOriginal = usedUrl === candidate.url
        const pixelWidth = isOriginal ? candidate.sourceWidth : plan.width
        entries.push({
          file,
          title: candidate.title,
          source: candidate.source,
          downloadUrl: usedUrl,
          author: candidate.author,
          license: candidate.license,
          licenseUrl: candidate.licenseUrl,
          // 原图档记录真实像素尺寸；缩略图档按目标宽度与原图比例推导
          width: pixelWidth,
          height: Math.round((pixelWidth * candidate.sourceHeight) / candidate.sourceWidth),
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
