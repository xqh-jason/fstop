#!/usr/bin/env node
/**
 * 人脸语料 —— 从 Wikimedia Commons 抓「同一人多张 + 多人对照」的**公有领域**照片。
 *
 * 为什么必须是带标签的：人脸聚类唯一值得验证的问题是「有没有把两个人合成一个人」。
 * 用一堆互不相干的肖像照，聚出 N 组各 1 张，什么也证明不了；只有「同一人的多张必须同组、
 * 不同人的必须异组」这种带标签的输入，才能把「不误吸」变成可断言的结论。
 *
 * 语料同样**不进 git**（只提交 manifest）：每条记录带人物标签、Commons 来源与许可，
 * 任何人重跑都能拿到同一批。
 *
 * 用法：
 *   NODE_USE_ENV_PROXY=1 node scripts/fetch-faces-corpus.mjs
 *   NODE_USE_ENV_PROXY=1 node scripts/fetch-faces-corpus.mjs --verify
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const API = 'https://commons.wikimedia.org/w/api.php'
const USER_AGENT = 'fstop-faces-corpus-fetcher/0.1 (+https://github.com/xqh-jason/fstop)'
const OUTPUT_DIR = path.join(process.cwd(), 'bench', 'corpus-faces')
const MANIFEST = path.join(OUTPUT_DIR, 'manifest.json')

/** 清单里写明「照片不入库」，免得后来的人误以为照片可以跟着提交。 */
const MANIFEST_NOTE =
  '照片本体不入库（.gitignore 已覆盖 bench/corpus-faces/）：本清单只记录来源、许可与 sha256，供按同一批公有领域肖像复现基准。'

/** 每个人的候选分类：多分类是为了拿到不同年份/角度的脸（同人不同光照才是真实难度） */
const PEOPLE = [
  {
    person: 'obama',
    label: '奥巴马',
    /**
     * **人工点名的文件**，不再按分类抓。
     *
     * 反面教训（实测踩过）：分类里夹着合影与文字图 —— 「Official portrait of President Obama and
     * Vice President Biden 2009」一张照片里两个人（检出 2 张脸）、「President Barack Obama with
     * full cabinet」检出 24 张脸、「Biden Rule」是纯文字图。这类文件进了语料，
     * **「按文件名标注人物」这个前提就死了**：一张 obama-*.jpg 里的脸可能是拜登的，
     * 端到端于是报「把两个人合成一组」，而真相是测试自己标错了。
     * 语料是夹具，夹具错了先修夹具：这里直接点名**单人世代的官方肖像**，并且刻意跨年代
     * （2005 参议员 / 2012 / 2013），因为「同人不同年代」才是这个人脸功能真正的难点。
     */
    files: [
      'File:President Barack Obama.jpg',
      'File:Barack Obama 2013 (4x5).png',
      'File:Barack Obama Senate portrait crop.jpg',
      'File:President Barack Obama (1).jpg',
    ],
  },
  {
    person: 'biden',
    label: '拜登',
    files: [
      'File:Joe Biden official portrait.jpg',
      'File:Joe Biden presidential portrait.jpg',
      'File:Inaugural portrait of Joe Biden.jpg',
    ],
  },
]

/** 许可白名单：只要公有领域（美国联邦政府作品）或 CC0 —— 与主语料同一口径 */
const LICENSE_OK = [/^public domain/i, /^pd/i, /cc0/i]

const THUMB_WIDTH = 1024

async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', ...params }).toString()}`
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok) throw new Error(`Commons API ${response.status}`)
  return response.json()
}

async function fileInfo(titles) {
  if (titles.length === 0) return []
  const data = await api({
    action: 'query',
    titles: titles.join('|'),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: String(THUMB_WIDTH),
  })
  return Object.values(data.query?.pages ?? {})
}

function licenseOf(page) {
  const meta = page.imageinfo?.[0]?.extmetadata ?? {}
  return (meta.LicenseShortName?.value ?? '').trim()
}

async function download(url, target) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(target, buffer)
  return {
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

async function verify() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  let ok = 0
  for (const entry of manifest.files) {
    const buffer = await readFile(path.join(OUTPUT_DIR, entry.file))
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    if (sha256 === entry.sha256) ok += 1
    else console.error(`✗ ${entry.file} 校验失败`)
  }
  console.log(`校验完成：${ok}/${manifest.files.length} 通过`)
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true })
  const files = []
  for (const spec of PEOPLE) {
    const candidates = [...spec.files]
    console.log(`[${spec.person}] 候选 ${candidates.length} 个`)
    const pages = await fileInfo(candidates)
    let taken = 0
    for (const page of pages) {
      if (taken >= spec.files.length) break
      const info = page.imageinfo?.[0]
      if (info === undefined) continue
      const license = licenseOf(page)
      if (!LICENSE_OK.some((pattern) => pattern.test(license))) {
        console.log(`  跳过（许可 ${license || '未知'}）：${page.title}`)
        continue
      }
      const mime = info.mime ?? ''
      if (!/^image\/(jpeg|png|webp)$/.test(mime)) continue
      const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]
      const file = `${spec.person}-${String(taken + 1).padStart(2, '0')}.${extension}`
      const url = info.thumburl ?? info.url
      try {
        const saved = await download(url, path.join(OUTPUT_DIR, file))
        files.push({
          file,
          person: spec.person,
          label: spec.label,
          license,
          source: page.title,
          width: info.thumbwidth ?? info.width,
          height: info.thumbheight ?? info.height,
          ...saved,
        })
        taken += 1
        console.log(`  ✓ ${file}  ${license}`)
      } catch (error) {
        console.error(`  ✗ ${file}：${error.message}`)
      }
    }
    if (taken === 0) console.error(`[${spec.person}] 一张都没抓到（分类或网络问题）`)
  }

  await writeFile(
    MANIFEST,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), note: MANIFEST_NOTE, files }, null, 2)}\n`,
  )
  const byPerson = files.reduce((acc, entry) => {
    acc[entry.person] = (acc[entry.person] ?? 0) + 1
    return acc
  }, {})
  console.log(`共 ${files.length} 张：${JSON.stringify(byPerson)}`)
  console.log(`清单：${MANIFEST}`)
}

if (process.argv.includes('--verify')) await verify()
else await main()
