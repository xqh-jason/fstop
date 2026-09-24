/**
 * 导出塔的 spike 页 —— 交接说明 §9A5 / §9B 的 D2 判定。
 *
 * 前置：`python3 bench/export-towers.py [--dtype q4f16|fp16]` 从 `.cache/models/.../model_<dtype>.onnx`
 * 切出子图（`bench/export/`，已 gitignore）。本页回答四个问题：
 *
 * 1. **成本**：只跑视觉塔要多久？224²（197 token）到 64²（17 token）各多少？
 *    —— 拆塔 spike（实测记录 §9.1）已证明 ORT 的 WebGPU EP 不会替我们剪图，所以这是唯一能
 *    直接量到「视觉塔单独成本」的办法。
 * 2. **保真**：切出来的子图与原双塔模型的对应输出是否一致（余弦 ≈ 1）？
 *    不一致就说明图手术改变了语义，后面的数字全都不算。
 * 3. **质量**：小分辨率版的位置编码插值是「改了模型的输入分布」，必须用检索质量页的同一套口径
 *    重测中文 R@1（39 张样例 × 23 条 query，ground truth 与 quality-queries.json 一致）。
 *    **速度收益只有配上质量数字才是可决策的。**
 * 4. **dtype**：`?dtype=fp16` 会加载同分辨率、不同权重量化档的导出塔（D3 对照）。
 *
 * 参数：`?dtype=fp16&runs=6&limit=0`。结果写入 `window.__EXPORT_RESULT`。
 */

import {
  AutoModel,
  AutoProcessor,
  AutoTokenizer,
  RawImage,
  type PreTrainedModel,
} from '@huggingface/transformers'
import type { PhotoRef } from '../src/core/photo-source'
import {
  configureModelRuntime,
  DEFAULT_DTYPE,
  DEFAULT_MODEL_ID,
  type Dtype,
} from '../src/storage/models'
import { DEFAULT_DECODE_OPTIONS, decodePhoto } from '../src/workers/decode'
import { toPixelValues } from '../src/workers/embed-preprocess'
import { HttpPhotoSource } from './http-photo-source'
import qualityQueries from './quality-queries.json'
import corpusQueries from './corpus-queries.json'

const params = new URLSearchParams(location.search)
const MODEL_ID = params.get('model') ?? DEFAULT_MODEL_ID
const DTYPE = (params.get('dtype') ?? DEFAULT_DTYPE) as Dtype
const RUNS = Number(params.get('runs') ?? 6)
const LIMIT = Number(params.get('limit') ?? 0)
const TOP_K = 10

interface OrtTensor {
  readonly data: ArrayLike<number>
}
interface OrtSession {
  run: (feeds: Record<string, unknown>, outputs?: string[]) => Promise<Record<string, OrtTensor>>
  inputNames: string[]
  outputNames: string[]
}
interface OrtSessions {
  create: (path: string, options?: Record<string, unknown>) => Promise<OrtSession>
}

interface QualityQuery {
  readonly id: string
  readonly match: string | readonly string[]
  readonly zh: string
  readonly en: string
}

const output = document.getElementById('out')

function render(payload: unknown): void {
  if (output !== null) output.textContent = JSON.stringify(payload, null, 2)
  ;(window as unknown as { __EXPORT_RESULT: unknown }).__EXPORT_RESULT = payload
  const phase = (payload as { phase?: string }).phase
  console.log(
    phase === undefined ? `done ${JSON.stringify(payload).slice(0, 300)}` : `phase ${phase}`,
  )
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0)
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += (a[index] ?? 0) * (b[index] ?? 0)
    normA += (a[index] ?? 0) ** 2
    normB += (b[index] ?? 0) ** 2
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

async function main(): Promise<void> {
  configureModelRuntime()
  render({ phase: 'load:model', model: MODEL_ID, dtype: DTYPE })

  const [processor, tokenizer] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL_ID),
    AutoTokenizer.from_pretrained(MODEL_ID),
  ])
  // 保真检查要拿「原双塔模型」当参照：fp16 档要再下 377 MB，代理链路上很容易失败，
  // 所以允许 `?fidelity=0` 跳过（跳过时结果里记 'skipped'，不允许悄悄变成通过）
  const checkFidelity = params.get('fidelity') !== '0'
  let InferenceSession: OrtSessions
  let dual: OrtSession | undefined
  if (checkFidelity) {
    const model = await AutoModel.from_pretrained(MODEL_ID, { dtype: DTYPE, device: 'webgpu' })
    dual = (model as unknown as PreTrainedModel & { sessions?: Record<string, OrtSession> })
      .sessions?.['model']
    if (dual === undefined) throw new Error('拿不到原双塔模型的底层 session')
    // ORT 的构造器从既有 session 上借：transformers.js 的 onnxruntime-web 不是本项目的直接依赖，
    // 直接 `import 'onnxruntime-web'` 在 pnpm 布局下解析不到
    InferenceSession = dual.constructor as unknown as OrtSessions
  } else {
    const probe = await AutoModel.from_pretrained(MODEL_ID, {
      dtype: DEFAULT_DTYPE,
      device: 'wasm',
    })
    const session = (probe as unknown as { sessions?: Record<string, OrtSession> }).sessions?.[
      'model'
    ]
    if (session === undefined) throw new Error('拿不到 ORT 构造器')
    InferenceSession = session.constructor as unknown as OrtSessions
  }
  const prepare = processor as unknown as (image: unknown) => Promise<Record<string, unknown>>
  const encode = tokenizer as unknown as (
    text: string[],
    options: Record<string, unknown>,
  ) => Record<string, unknown>

  const base = '/bench/export'
  /** 分辨率档：token = (size/16)²+1 —— 与 bench/export-towers.py 的 --sizes 对应；
   *  `?sizes=224,192,176,160` 可换成任意已导出的档位（找质量拐点时用） */
  const SIZES = (params.get('sizes') || '224,160,112,64')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
  const tokensOf = (size: number): number => (size / 16) ** 2 + 1
  render({ phase: 'load:exports', sizes: SIZES, dtype: DTYPE })
  const visionSessions = new Map<number, OrtSession>()
  const unavailable: Record<string, string> = {}
  for (const size of SIZES) {
    // 逐个建（并发建四个 webgpu 会话会互相争 GPU 内存，实测并发建更慢也更易失败）
    try {
      visionSessions.set(
        size,
        await InferenceSession.create(`${base}/vision${size}_${DTYPE}.onnx`, {
          executionProviders: ['webgpu'],
        }),
      )
    } catch (error) {
      // 允许只导出了部分分辨率（D3 的 fp16 对照只导 224/160 两档，避免 4 × 172 MB 的产物）
      unavailable[`${size}`] = String(error).slice(0, 160)
      console.warn(`视觉塔 ${size}² 建会话失败（跳过）：`, error)
    }
  }
  if (visionSessions.size === 0) throw new Error('一档视觉塔都没建起来')
  const text = await InferenceSession.create(`${base}/text_${DTYPE}.onnx`, {
    executionProviders: ['webgpu'],
  })
  const vision224 = visionSessions.get(224)
  const io = {
    vision: Object.fromEntries(
      [...visionSessions].map(([size, session]) => [
        `${size}²`,
        { inputs: session.inputNames, outputs: session.outputNames },
      ]),
    ),
    text: { inputs: text.inputNames, outputs: text.outputNames },
  }

  // ── 1) 保真：同一次 pixel_values 喂双塔与单塔，比较 image_embeds ───────────────
  const manifestResponse = await fetch('/samples/manifest.json')
  const samples = (await manifestResponse.json()) as ReadonlyArray<{ file: string }>
  const sample = samples.find((entry) => entry.file.startsWith('dog-snow')) ?? samples[0]
  if (sample === undefined) throw new Error('样例清单为空')
  const blob = await (await fetch(`/samples/${sample.file}`)).blob()
  const raw = await RawImage.fromBlob(blob)
  const processorOut = await prepare(raw)
  const pixelValues = processorOut['pixel_values'] as { ort_tensor: OrtTensor }
  const textFeeds = (value: string) => {
    const encoded = encode([value], { padding: true, truncation: true })
    return {
      input_ids: (encoded['input_ids'] as { ort_tensor: OrtTensor }).ort_tensor,
      attention_mask: (encoded['attention_mask'] as { ort_tensor: OrtTensor }).ort_tensor,
    }
  }
  const zeroImage = (): OrtTensor =>
    new (
      pixelValues.ort_tensor.constructor as new (
        type: string,
        data: Float32Array,
        dims: number[],
      ) => OrtTensor
    )('float32', new Float32Array(3 * 224 * 224), [1, 3, 224, 224])

  // 保真检查（`?fidelity=0` 时跳过：fp16 档的参照模型要再下 377 MB）
  const fidelity: Record<string, unknown> = { skipped: !checkFidelity }
  if (checkFidelity && dual !== undefined && vision224 !== undefined) {
    const dualImage = await dual.run({
      pixel_values: pixelValues.ort_tensor,
      ...textFeeds(''),
    })
    const visionOnlyImage = await vision224.run({ pixel_values: pixelValues.ort_tensor })
    fidelity['imageEmbedsCosine'] = Number(
      cosine(
        dualImage['image_embeds']?.data ?? [],
        visionOnlyImage['image_embeds']?.data ?? [],
      ).toFixed(6),
    )
    fidelity['dims'] = {
      dual: Array.from(dualImage['image_embeds']?.data ?? []).length,
      visionOnly: Array.from(visionOnlyImage['image_embeds']?.data ?? []).length,
    }
    const dualText = await dual.run({ ...textFeeds('雪地里的狗'), pixel_values: zeroImage() })
    const textOnly = await text.run(textFeeds('雪地里的狗'))
    fidelity['textEmbedsCosine'] = Number(
      cosine(dualText['text_embeds']?.data ?? [], textOnly['text_embeds']?.data ?? []).toFixed(6),
    )
    // 两条不同文本经切出来的文本塔也必须得到不同向量（M0 那个「常量向量」bug 的同类烟雾）
    fidelity['textSmokeDifferentVectors'] =
      cosine(
        textOnly['text_embeds']?.data ?? [],
        (await text.run(textFeeds('夜晚的城市')))['text_embeds']?.data ?? [],
      ) < 0.999
  }

  // ── 2) 成本：单塔 vs 双塔，224² vs 112²（1 次预热 + RUNS 次采样） ──────────────
  render({ phase: 'measure', runs: RUNS })
  async function medianMs(label: string, task: () => Promise<unknown>): Promise<number> {
    await task()
    const times: number[] = []
    for (let index = 0; index < RUNS; index += 1) {
      const started = performance.now()
      await task()
      times.push(performance.now() - started)
    }
    const value = median(times)
    console.log(`${label}: ${value} ms`)
    return value
  }

  /**
   * 与产品路径**共用同一份预处理**（`src/workers/embed-preprocess.ts`）：
   * 基准测的必须就是产品跑的，否则测出来的分辨率/质量结论不描述产品。
   * 这里只多一步把 Float32Array 包成 ORT 张量（张量构造器从参照模型借，避免再加载一份 ORT）。
   */
  const feedsFrom = async (bitmap: ImageBitmap, size: number): Promise<Record<string, unknown>> => {
    const data = await toPixelValues(bitmap, size)
    const Tensor = pixelValues.ort_tensor.constructor as new (
      type: string,
      data: Float32Array,
      dims: number[],
    ) => OrtTensor
    return { pixel_values: new Tensor('float32', data, [1, 3, size, size]) }
  }

  const decoded = await decodePhoto(blob, DEFAULT_DECODE_OPTIONS)
  const feedsAt = (size: number) => feedsFrom(decoded.bitmap, size)

  // 成本：双塔（原样，fidelity=0 时没有参照模型就跳过）与四档单塔视觉
  // （同一份权重、只差 token 数）→ 分离每 token 成本与固定开销
  const costMs: Record<string, number> = {
    text: await medianMs('text', () => text.run(textFeeds('雪地里的狗'))),
  }
  if (dual !== undefined) {
    costMs['dualFull'] = await medianMs('dualFull', () =>
      dual.run({ pixel_values: pixelValues.ort_tensor, ...textFeeds('') }),
    )
  }
  const visionCostMs: Record<string, number> = {}
  const vectorsBySize = new Map<number, ArrayLike<number>>()
  for (const size of SIZES) {
    const session = visionSessions.get(size)
    if (session === undefined) continue
    const feeds = await feedsAt(size)
    visionCostMs[`${size}`] = await medianMs(`vision${size}`, () => session.run(feeds))
    vectorsBySize.set(size, (await session.run(feeds))['image_embeds']?.data ?? [])
  }
  decoded.bitmap.close()

  /** 最小二乘拟合 ms = 固定开销 + k × token —— §9A5 要的就是这两个数 */
  const fit = (() => {
    const points = [...visionSessions.keys()]
      .sort((a, b) => a - b)
      .map((size) => ({ x: tokensOf(size), y: visionCostMs[`${size}`] ?? 0 }))
    const n = points.length
    const meanX = points.reduce((sum, p) => sum + p.x, 0) / n
    const meanY = points.reduce((sum, p) => sum + p.y, 0) / n
    const covariance = points.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0)
    const variance = points.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0)
    const slope = covariance / variance
    const intercept = meanY - slope * meanX
    return {
      // 只有两档时直线必然过两点，拟合没有意义 → 只报点
      perTokenMs: points.length >= 3 ? Math.round(slope * 10000) / 10000 : null,
      fixedMs: points.length >= 3 ? Math.round(intercept * 100) / 100 : null,
      points: points.map((p) => ({ tokens: p.x, ms: p.y })),
    }
  })()
  // 同图在不同分辨率下的向量（诊断：插值改变输入分布，余弦不会 = 1，但应随图像变化而稳定）
  const crossResolutionCosine: Record<string, number> = {}
  const reference = vectorsBySize.get(224) ?? []
  for (const size of SIZES) {
    if (size === 224) continue
    crossResolutionCosine[`224vs${size}`] = Number(
      cosine(reference, vectorsBySize.get(size) ?? []).toFixed(4),
    )
  }
  console.log(`拟合 ${JSON.stringify(fit)}；跨分辨率余弦 ${JSON.stringify(crossResolutionCosine)}`)

  // ── 3) 质量：图库内每张照片建一个矩阵（各分辨率各一份），query 走同一套 ground truth ──
  //    默认是 39 张样例库 + 23 条 query（M0 那套，可与 §7 直接对照）；
  //    `?queries=corpus&gallery=bench/corpus` 换成 783 张真实语料 + 106 条 query
  //    （query 由 Commons 上传者写的英文标题转写，未看图，见 bench/corpus-queries.json）
  render({ phase: 'quality', runs: RUNS })
  const QUERY_SET = params.get('queries') ?? 'samples'
  const queries = (
    QUERY_SET === 'corpus' ? corpusQueries : qualityQueries
  ) as readonly QualityQuery[]
  const gallery = params.get('gallery') || (QUERY_SET === 'corpus' ? 'bench/corpus' : 'samples')
  const source = await HttpPhotoSource.open(gallery, location.origin, 0, gallery)
  const refs: PhotoRef[] = []
  for await (const ref of source.list()) refs.push(ref)
  const subset = LIMIT > 0 ? refs.slice(0, LIMIT) : refs
  /** `match` 可以是前缀（老格式）或精确文件名数组（新格式，含扩展名时按精确匹配） */
  const matchesOf = (match: string | readonly string[]): readonly string[] =>
    typeof match === 'string' ? [match] : match
  const targetsOf = queries.map((query) => {
    const patterns = matchesOf(query.match)
    const targets = refs
      .map((ref) => ref.relPath)
      .filter((file) =>
        patterns.some((pattern) =>
          /\.(jpe?g|png|webp|tiff?)$/i.test(pattern)
            ? file === pattern
            : file.startsWith(`${pattern}-`),
        ),
      )
    if (targets.length === 0) throw new Error(`query ${query.id} 的 match 没有命中任何照片`)
    return targets
  })

  const DIM = 512
  const matrices = new Map<number, Float32Array>()
  for (const size of SIZES) {
    if (visionSessions.has(size)) matrices.set(size, new Float32Array(subset.length * DIM))
  }
  const imageTimings: Record<string, number[]> = Object.fromEntries(
    [...matrices.keys()].map((size) => [`${size}`, []]),
  )
  for (let index = 0; index < subset.length; index += 1) {
    const ref = subset[index]
    if (ref === undefined) continue
    const bitmap = (await decodePhoto(await source.read(ref), DEFAULT_DECODE_OPTIONS)).bitmap
    for (const size of SIZES) {
      const session = visionSessions.get(size)
      const matrix = matrices.get(size)
      if (session === undefined || matrix === undefined) continue
      const started = performance.now()
      const out = await session.run(await feedsFrom(bitmap, size))
      imageTimings[`${size}`]?.push(performance.now() - started)
      matrix.set(out['image_embeds']?.data ?? new Float32Array(DIM), index * DIM)
    }
    bitmap.close()
    if ((index + 1) % 10 === 0) console.log(`embedded ${index + 1}/${subset.length}`)
  }

  /** 与 quality.ts 相同的暴力余弦 top-k */
  function topK(matrix: Float32Array, query: ArrayLike<number>, k: number) {
    const scores = new Float32Array(subset.length)
    for (let row = 0; row < subset.length; row += 1) {
      let sum = 0
      const offset = row * DIM
      for (let column = 0; column < DIM; column += 1) {
        sum += (matrix[offset + column] ?? 0) * (query[column] ?? 0)
      }
      scores[row] = sum
    }
    return Array.from(scores.keys())
      .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))
      .slice(0, k)
      .map((index) => ({ index, score: scores[index] ?? 0 }))
  }

  /** 中文 query 向量：只算一遍，两种分辨率共用 */
  const queryVectors = new Map<string, Float32Array>()
  const queryTimings: number[] = []
  for (const query of queries) {
    const started = performance.now()
    const out = await text.run(textFeeds(query.zh))
    queryTimings.push(performance.now() - started)
    queryVectors.set(query.id, out['text_embeds']?.data as Float32Array)
  }

  function evaluate(matrix: Float32Array) {
    const outcomes: Array<{ id: string; bestRank: number | null }> = []
    for (let q = 0; q < queries.length; q += 1) {
      const query = queries[q]
      if (query === undefined) continue
      const vector = queryVectors.get(query.id)
      if (vector === undefined) throw new Error(`query ${query.id} 缺向量`)
      const ranking = topK(matrix, vector, TOP_K)
      const targetSet = new Set(targetsOf[q])
      let bestRank: number | null = null
      for (let position = 0; position < ranking.length; position += 1) {
        const hit = ranking[position]
        if (
          bestRank === null &&
          hit !== undefined &&
          targetSet.has(refs[hit.index]?.relPath ?? '')
        ) {
          bestRank = position + 1
        }
      }
      outcomes.push({ id: query.id, bestRank })
    }
    const ranked = outcomes.filter((outcome) => outcome.bestRank !== null)
    const hit = (k: number) => ranked.filter((o) => (o.bestRank ?? Infinity) <= k).length
    return {
      queries: outcomes.length,
      recallAt1: Math.round((hit(1) / outcomes.length) * 1000) / 1000,
      recallAt5: Math.round((hit(5) / outcomes.length) * 1000) / 1000,
      recallAt10: Math.round((hit(10) / outcomes.length) * 1000) / 1000,
      mrr:
        Math.round(
          (ranked.reduce((sum, o) => sum + 1 / (o.bestRank ?? Infinity), 0) / outcomes.length) *
            1000,
        ) / 1000,
      perQuery: outcomes,
    }
  }

  const quality: Record<string, unknown> = {}
  for (const size of SIZES) {
    const matrix = matrices.get(size)
    if (matrix === undefined) continue
    quality[`zh${size}`] = evaluate(matrix)
  }

  render({
    model: MODEL_ID,
    dtype: DTYPE,
    sample: sample.file,
    io,
    fidelity,
    costMs,
    visionCostMs,
    fit,
    unavailable,
    crossResolutionCosine,
    imageEmbedMs: Object.fromEntries(
      [...matrices.keys()].map((size) => [`median${size}`, median(imageTimings[`${size}`] ?? [])]),
    ),
    textEmbedMs: { median: median(queryTimings) },
    samples: subset.length,
    queries: queries.length,
    quality,
  })
}

await main().catch((error: unknown) => {
  render({
    phase: 'error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.split('\n').slice(0, 4).join(' | ') : undefined,
  })
})
