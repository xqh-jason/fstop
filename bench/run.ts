/**
 * M0 基准页 —— 端到端跑「扫描 → 解码 → 向量化 → 缩略图 → 入库」，产出 docs/BENCHMARKS.md 第 4 项的 photos/s。
 *
 * **这是 M0 的临时编排**：状态机与任务队列应当属于 `src/core/`（docs/DESIGN.md 约定 1），
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
import { HttpPhotoSource } from '../src/storage/photo-source-http'

const params = new URLSearchParams(location.search)
const COUNT = Number(params.get('count') ?? 200)
const DECODE_CONCURRENCY = Number(params.get('decode') ?? 3)
const DTYPES = ['q4f16', 'fp16', 'fp32'] as const
const DTYPE = DTYPES.find((candidate) => candidate === params.get('dtype')) ?? DEFAULT_DTYPE
const MODEL_ID = params.get('model') ?? DEFAULT_MODEL_ID
const SOURCE_PARAM = params.get('source')
const SOURCE = SOURCE_PARAM === 'files' ? 'files' : SOURCE_PARAM === 'http' ? 'http' : 'opfs'
const LIMIT = Number(params.get('limit') ?? 0)
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
  // 进度必须打到 console：驱动器会转发它，否则「卡住了」只能靠猜
  const phase = (payload as { phase?: string }).phase
  console.log(
    phase === undefined ? `done ${JSON.stringify(payload).slice(0, 300)}` : `phase ${phase}`,
  )
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

/** docs/DESIGN.md：size + 首尾各 64 KB 的哈希；内容身份让移动/重命名不触发重算 */
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

  /** files/http 模式：语料来自磁盘真实照片（http 模式由 dev server 直接服务，见 HttpPhotoSource 的说明） */
  let externalSource: PhotoSource | null = null
  let corpusReport: unknown = {}
  if (SOURCE === 'http') {
    const httpSource = await HttpPhotoSource.open('bench', location.origin, LIMIT)
    externalSource = httpSource
    corpusReport = {
      source: 'http',
      count: httpSource.count,
      bytes: httpSource.bytes,
    }
  } else if (SOURCE === 'files') {
    const hint = document.getElementById('corpus-hint')
    if (hint !== null) hint.hidden = false
    const input = document.getElementById('corpus') as HTMLInputElement | null
    if (input === null) throw new Error('页面缺少 #corpus 输入元素')
    const files = await waitForDirectoryFiles(input)
    const fileSource = new FileListPhotoSource('bench', files)
    externalSource = fileSource
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
  // 派生单塔默认开启（探测不到自动回落原生双塔）；`?derived=0` 关掉、`?derived=192` 钉住档位
  // 注意 `||`：runner 传的是空字符串（不是缺参数），空串必须当"没指定"而不是 0
  const derivedParam = params.get('derived') || null
  const derivedOptions =
    derivedParam === null
      ? {}
      : derivedParam === '0'
        ? { useDerived: false }
        : { derivedResolution: Number(derivedParam) }
  const model = await embed.init({
    modelId: MODEL_ID,
    dtype: DTYPE,
    device: 'webgpu',
    ...derivedOptions,
  })
  const modelLoadMs = Math.round(performance.now() - embedStarted)

  // 文本侧冒烟：派生路径下文本塔是懒加载的（77.9 MB + 建会话），必须在这里确认它能用。
  // 顺带把「首次文本查询要付多少」测出来——索引基准本身不查文本，不测就等于没验证过。
  let textWarmupMs: number | null = null
  let textSearchMs: number | null = null
  try {
    textWarmupMs = await embed.warmupText()
    const smokeStarted = performance.now()
    const smokeVector = await embed.embedText('雪地里的狗')
    textSearchMs = Math.round(performance.now() - smokeStarted)
    if (smokeVector.length !== model.dim) {
      throw new Error(`文本向量维度 ${smokeVector.length} 与目录声明的 ${model.dim} 不一致`)
    }
    console.log(`文本塔就绪 ${textWarmupMs} ms，首次查询 ${textSearchMs} ms`)
  } catch (error) {
    console.error(
      `文本侧冒烟失败：${error instanceof Error ? error.message : String(error)}（派生塔的文本输出名或分词器契约不匹配）`,
    )
    throw error
  }

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
  const source: PhotoSource = externalSource ?? new OpfsPhotoSource('bench', CORPUS_SEGMENTS)

  const refs: PhotoRef[] = []
  for await (const ref of source.list()) refs.push(ref)
  render({ phase: 'index', corpus: corpusReport, model, queue: refs.length })

  const timings: PhotoTiming[] = []
  let pending: PhotoWrite[] = []
  let embedChain: Promise<unknown> = Promise.resolve()
  // 数据库只有一个连接，`BEGIN` 不能并发：多个解码 worker 同时提交批次会互相打断
  let dbChain: Promise<unknown> = Promise.resolve()
  let cursor = 0
  let thumbnailBytes = 0
  let currentStage = 'idle'

  async function processOne(ref: PhotoRef): Promise<void> {
    const timing: PhotoTiming = { readMs: 0, decodeMs: 0, embedMs: 0, thumbMs: 0, hashMs: 0 }
    // 前 5 张逐阶段打点：一旦「卡住」要能立刻看出卡在哪一步，而不是靠猜
    const verbose = timings.length < 5
    const mark = (stage: string) => {
      currentStage = `${ref.relPath.slice(0, 28)} ${stage}`
      if (verbose) console.log(`  ${ref.relPath.slice(0, 40)} ${stage}`)
    }

    const readStarted = performance.now()
    mark('read:start')
    const blob = await source.read(ref)
    timing.readMs = performance.now() - readStarted
    mark(`read:done ${(blob.size / 1024).toFixed(0)}KB`)

    const hashStarted = performance.now()
    const hash = await contentHash(blob)
    timing.hashMs = performance.now() - hashStarted
    mark('hash:done')

    const decodeStarted = performance.now()
    const decoded = await decodePhoto(blob, DEFAULT_DECODE_OPTIONS)
    timing.decodeMs = performance.now() - decodeStarted
    mark(`decode:done ${decoded.width}x${decoded.height}`)

    // 串行化：GPU 只有一个会话，并发提交只会让队列互相排队
    const embedStarted = performance.now()
    const next = embedChain.then(() => embed.embedImage(decoded.bitmap))
    embedChain = next.catch(() => undefined)
    mark('embed:start')
    const vector = (await next) as Float32Array
    timing.embedMs = performance.now() - embedStarted
    mark('embed:done')
    decoded.bitmap.close()

    const thumbStarted = performance.now()
    const thumbName = `${ref.relPath.replace(/\.[^.]+$/, '')}.jpg`
    thumbnailBytes += await writeOpfsFile(thumbs, thumbName, decoded.thumb)
    timing.thumbMs = performance.now() - thumbStarted
    mark('thumb:done')

    const offset = await vectors.append(vector)
    mark(`vector:done slot=${offset}`)
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
      dbChain = dbChain.then(() => db.writeBatch(batch))
      await dbChain
    }
    timings.push(timing)
  }

  const indexStarted = performance.now()
  const progressStep = Math.max(1, Math.round(refs.length / 10))
  // 心跳：卡住时必须能立刻看出「完成到哪、当前停在哪一步」，而不是等半小时
  const heartbeat = setInterval(() => {
    console.log(`hb indexed=${timings.length}/${refs.length} cursor=${cursor} at=${currentStage}`)
  }, 5000)
  await Promise.all(
    Array.from({ length: Math.max(1, DECODE_CONCURRENCY) }, async () => {
      while (cursor < refs.length) {
        const ref = refs[cursor]
        cursor += 1
        if (ref !== undefined) await processOne(ref)
        if (timings.length % progressStep === 0) {
          console.log(`indexed ${timings.length}/${refs.length}`)
        }
      }
    }),
  )
  clearInterval(heartbeat)
  if (pending.length > 0) {
    dbChain = dbChain.then(() => db.writeBatch(pending))
    await dbChain
  }
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
    textWarmupMs,
    textSearchMs,
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
