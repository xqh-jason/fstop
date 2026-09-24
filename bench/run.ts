/**
 * M0 基准页 —— 端到端跑「扫描 → 解码 → 向量化 → 缩略图 → 入库」，产出 §九 第 4 项的 photos/s。
 *
 * **这是 M0 的临时编排**：状态机与任务队列应当属于 `src/core/`（§11.3 约定 1），
 * 这里只是把同一条链路先接通、先测出数字，M1 落地时由 core 的状态机接管，本文件只留驱动器。
 *
 * URL 参数：`?count=200&decode=3&dtype=q4f16&device=webgpu&model=...&seed=...`
 */

import * as Comlink from 'comlink'
import type { PhotoRef, PhotoSource } from '../src/core/photo-source'
import { DEFAULT_DTYPE, DEFAULT_MODEL_ID, modelBytes, modelSpec } from '../src/storage/models'
import type { DbService, PhotoWrite } from '../src/storage/db.worker'
import { clearOpfsFiles, countOpfsFiles, opfsDirectory, writeOpfsFile } from '../src/storage/opfs'
import { OpfsPhotoSource } from '../src/storage/photo-source-opfs'
import { VectorMatrix } from '../src/storage/vector-matrix'
import { DEFAULT_DECODE_OPTIONS, decodePhoto } from '../src/workers/decode'
import type { EmbedService } from '../src/workers/embed.worker'
import type { CorpusFile, CorpusSink } from './corpus'
import { DEFAULT_CORPUS, generateCorpus } from './corpus'
import { FileListPhotoSource } from './file-list-source'

const params = new URLSearchParams(location.search)
const COUNT = Number(params.get('count') ?? 200)
const DECODE_CONCURRENCY = Number(params.get('decode') ?? 3)
const DTYPES = ['q4f16', 'fp16', 'fp32'] as const
const DTYPE = DTYPES.find((candidate) => candidate === params.get('dtype')) ?? DEFAULT_DTYPE
const MODEL_ID = params.get('model') ?? DEFAULT_MODEL_ID
const SOURCE = params.get('source') === 'files' ? 'files' : 'opfs'
const BATCH_SIZE = 32
const CORPUS_SEGMENTS = ['bench-corpus'] as const
const THUMB_SEGMENTS = ['bench-thumbs'] as const
const VECTOR_SEGMENTS = ['bench-vectors'] as const

interface PhotoTiming {
  readMs: number
  decodeMs: number
  embedMs: number
  thumbMs: number
  hashMs: number
}

const output = document.getElementById('out')

function render(payload: unknown): void {
  if (output !== null) output.textContent = JSON.stringify(payload, null, 2)
  ;(window as unknown as { __BENCH_RESULT: unknown }).__BENCH_RESULT = payload
}

async function corpusSink(): Promise<CorpusSink> {
  const directory = await opfsDirectory(...CORPUS_SEGMENTS)
  return {
    async write(file: CorpusFile) {
      await writeOpfsFile(directory, file.name, file.blob)
    },
  }
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** 等 runner 把目录塞进 `<input webkitdirectory>`；超时即失败，不静默跑空语料 */
async function waitForDirectoryFiles(input: HTMLInputElement): Promise<File[]> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (input.files !== null && input.files.length > 0) return [...input.files]
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('等待语料目录超时（bench/runner.mjs 应该用 setInputFiles 注入）')
}

/** §7.6：size + 首尾各 64 KB 的哈希；内容身份让移动/重命名不触发重算 */
async function contentHash(blob: Blob): Promise<string> {
  const slice = 64 * 1024
  const head = await blob.slice(0, slice).arrayBuffer()
  const tail = await blob.slice(Math.max(0, blob.size - slice)).arrayBuffer()
  const payload = new Uint8Array(head.byteLength + tail.byteLength + 8)
  payload.set(new Uint8Array(head), 0)
  payload.set(new Uint8Array(tail), head.byteLength)
  new DataView(payload.buffer).setFloat64(head.byteLength + tail.byteLength, blob.size)
  const digest = await crypto.subtle.digest('SHA-256', payload)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function main(): Promise<void> {
  const startedAll = performance.now()
  render({ phase: 'opfs:corpus' })

  /** files 模式：语料来自磁盘真实照片，由 bench/runner.mjs 通过 setInputFiles 注入 */
  let fileSource: FileListPhotoSource | null = null
  let corpusReport: unknown = {}
  if (SOURCE === 'files') {
    const hint = document.getElementById('corpus-hint')
    if (hint !== null) hint.hidden = false
    const input = document.getElementById('corpus') as HTMLInputElement | null
    if (input === null) throw new Error('页面缺少 #corpus 输入元素')
    const files = await waitForDirectoryFiles(input)
    fileSource = new FileListPhotoSource('bench', files)
    corpusReport = {
      source: 'files',
      count: fileSource.count,
      bytes: fileSource.bytes,
      medianBytes: medianOf([...files].map((file) => file.size)),
    }
  } else {
    const corpusDirectory = await opfsDirectory(...CORPUS_SEGMENTS)
    const existing = await countOpfsFiles(corpusDirectory)
    corpusReport = { reused: existing }
    if (existing !== COUNT) {
      await clearOpfsFiles(corpusDirectory)
      corpusReport = await generateCorpus(await corpusSink(), { ...DEFAULT_CORPUS, count: COUNT })
    }
  }

  render({ phase: 'load:models', corpus: corpusReport })

  const embedStarted = performance.now()
  const embed = Comlink.wrap<EmbedService>(
    new Worker(new URL('../src/workers/embed.worker.ts', import.meta.url), { type: 'module' }),
  )
  const model = await embed.init({ modelId: MODEL_ID, dtype: DTYPE, device: 'webgpu' })
  const modelLoadMs = Math.round(performance.now() - embedStarted)

  const embedWorker = new Worker(new URL('../src/storage/db.worker.ts', import.meta.url), {
    type: 'module',
  })
  const db = Comlink.wrap<DbService>(embedWorker)
  const database = await db.open('bench', {
    directory: params.get('vfs') ?? '.fstop-vfs',
  })

  const thumbs = await opfsDirectory(...THUMB_SEGMENTS)
  const vectors = await VectorMatrix.open(
    await opfsDirectory(...VECTOR_SEGMENTS),
    modelSpec(MODEL_ID).space,
    model.dim,
  )
  const source: PhotoSource = fileSource ?? new OpfsPhotoSource('bench', CORPUS_SEGMENTS)

  const refs: PhotoRef[] = []
  for await (const ref of source.list()) refs.push(ref)
  render({ phase: 'index', corpus: corpusReport, model, queue: refs.length })

  const timings: PhotoTiming[] = []
  let pending: PhotoWrite[] = []
  let embedChain: Promise<unknown> = Promise.resolve()
  let cursor = 0
  let thumbnailBytes = 0

  async function processOne(ref: PhotoRef): Promise<void> {
    const timing: PhotoTiming = { readMs: 0, decodeMs: 0, embedMs: 0, thumbMs: 0, hashMs: 0 }

    const readStarted = performance.now()
    const blob = await source.read(ref)
    timing.readMs = performance.now() - readStarted

    const hashStarted = performance.now()
    const hash = await contentHash(blob)
    timing.hashMs = performance.now() - hashStarted

    const decodeStarted = performance.now()
    const decoded = await decodePhoto(blob, DEFAULT_DECODE_OPTIONS)
    timing.decodeMs = performance.now() - decodeStarted

    // 串行化：GPU 只有一个会话，并发提交只会让队列互相排队（§7.4）
    const embedStarted = performance.now()
    const next = embedChain.then(() => embed.embedImage(decoded.bitmap))
    embedChain = next.catch(() => undefined)
    const vector = (await next) as Float32Array
    timing.embedMs = performance.now() - embedStarted
    decoded.bitmap.close()

    const thumbStarted = performance.now()
    const thumbName = `${ref.relPath.replace(/\.[^.]+$/, '')}.jpg`
    thumbnailBytes += await writeOpfsFile(thumbs, thumbName, decoded.thumb)
    timing.thumbMs = performance.now() - thumbStarted

    const offset = await vectors.append(vector)
    pending.push({
      relPath: ref.relPath,
      ext: 'jpg',
      size: blob.size,
      mtime: 0,
      contentHash: hash,
      width: decoded.width,
      height: decoded.height,
      thumbKey: thumbName,
      modelId: model.modelId,
      dim: model.dim,
      matrixOffset: offset,
    })
    if (pending.length >= BATCH_SIZE) {
      const batch = pending
      pending = []
      await db.writeBatch(batch)
    }
    timings.push(timing)
  }

  const indexStarted = performance.now()
  await Promise.all(
    Array.from({ length: Math.max(1, DECODE_CONCURRENCY) }, async () => {
      while (cursor < refs.length) {
        const ref = refs[cursor]
        cursor += 1
        if (ref !== undefined) await processOne(ref)
      }
    }),
  )
  if (pending.length > 0) await db.writeBatch(pending)
  const indexMs = Math.round(performance.now() - indexStarted)
  await vectors.close()

  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    return Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0)
  }

  const result = {
    corpus: corpusReport,
    model,
    modelBytes: modelBytes(MODEL_ID, DTYPE),
    modelLoadMs,
    database,
    decodeConcurrency: DECODE_CONCURRENCY,
    photos: timings.length,
    indexSeconds: Number((indexMs / 1000).toFixed(2)),
    photosPerSecond: Number((timings.length / (indexMs / 1000)).toFixed(2)),
    projected10kMinutes: Number((10000 / (timings.length / (indexMs / 1000)) / 60).toFixed(1)),
    perStageMedianMs: {
      read: median(timings.map((t) => t.readMs)),
      hash: median(timings.map((t) => t.hashMs)),
      decode: median(timings.map((t) => t.decodeMs)),
      embed: median(timings.map((t) => t.embedMs)),
      thumb: median(timings.map((t) => t.thumbMs)),
    },
    thumbnailBytes,
    vectorSlots: vectors.slots,
    dbStats: await db.stats(),
    totalSeconds: Number(((performance.now() - startedAll) / 1000).toFixed(2)),
    weights: performance
      .getEntriesByType('resource')
      .filter((entry) => /huggingface\.co|hf\.co/.test(entry.name))
      .map((entry) => ({
        file: entry.name.replace(/^https:\/\/[^/]+\//, '').split('?')[0],
        transferBytes: (entry as PerformanceResourceTiming).transferSize,
        bodyBytes: (entry as PerformanceResourceTiming).encodedBodySize,
        ms: Math.round(entry.duration),
      })),
  }
  render(result)
}

await main()
