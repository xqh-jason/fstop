/**
 * 拆塔方案 C 的 spike —— 交接说明 §9A3（实测记录 §7 判定后的下一步）。
 *
 * 背景：Chinese-CLIP 是单文件双塔。transformers.js 的 `runInferenceSession` 调
 * `session.run(ortFeed)` 时**从不传输出列表**，ORT 于是计算全部输出——每次图像 embedding
 * 都白算文本塔（实测记录 §2：双塔 176 ms vs 单塔 72 ms 的差距即由此来）。
 * 方案 C 的赌注：直接拿到底层 ORT session，用 `session.run(feeds, ['image_embeds'])`
 * 指定输出列表，ORT 只执行目标输出所需的子图——**这个假设必须实测，文档不能替我们回答**。
 *
 * 本页只回答四个问题，不做工程化（不进 Worker、不做缓存）：
 * 1. 能否从 transformers.js 模型对象拿到底层 ORT session（`model.sessions`）；
 * 2. 指定输出列表后 ORT 是否真的剪掉另一塔——看耗时，对照全输出 run；
 * 3. 只喂单侧输入 + 指定输出，能否绕过「Missing the following inputs」的图输入校验
 *    （M0 §2 记录过：只喂 pixel_values 会报缺 input_ids）；
 * 4. 剪枝输出与全量输出是否一致（余弦 ≈ 1）。
 *
 * 参数：`?model=&dtype=&runs=10`。结果写入 `window.__TOWER_RESULT`。
 */

import {
  AutoModel,
  AutoProcessor,
  AutoTokenizer,
  RawImage,
  type PreTrainedModel,
} from '@huggingface/transformers'
import { configureModelRuntime, DEFAULT_DTYPE, DEFAULT_MODEL_ID } from '../src/storage/models'

const params = new URLSearchParams(location.search)
const MODEL_ID = params.get('model') ?? DEFAULT_MODEL_ID
const DTYPES = ['q4f16', 'fp16', 'fp32'] as const
const DTYPE = DTYPES.find((candidate) => candidate === params.get('dtype')) ?? DEFAULT_DTYPE
const RUNS = Number(params.get('runs') ?? 10)
/** 与 embed.worker 的 IMAGE_SIZE 一致：preprocessor 缺省输出 224×224×3 的 pixel_values */
const IMAGE_PIXELS = 3 * 224 * 224

const output = document.getElementById('out')

function render(payload: unknown): void {
  if (output !== null) output.textContent = JSON.stringify(payload, null, 2)
  ;(window as unknown as { __TOWER_RESULT: unknown }).__TOWER_RESULT = payload
  const phase = (payload as { phase?: string }).phase
  console.log(
    phase === undefined ? `done ${JSON.stringify(payload).slice(0, 300)}` : `phase ${phase}`,
  )
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0)
}

/** 中位数耗时：1 次预热 + RUNS 次采样（M0 §3 的教训——首跑含初始化，不可比） */
async function medianMs(fn: () => Promise<unknown>, runs: number): Promise<number> {
  await fn()
  const times: number[] = []
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now()
    await fn()
    times.push(performance.now() - started)
  }
  return median(times)
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

interface OrtTensor {
  readonly data: ArrayLike<number>
  constructor: new (type: string, data: ArrayBufferLike | Float32Array, dims: number[]) => OrtTensor
}
type Session = {
  run: (feeds: Record<string, unknown>, outputs?: string[]) => Promise<Record<string, OrtTensor>>
  inputNames: string[]
  outputNames: string[]
}

async function main(): Promise<void> {
  configureModelRuntime()
  render({ phase: 'load:model', model: MODEL_ID, dtype: DTYPE })

  const [processor, tokenizer, model] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL_ID),
    AutoTokenizer.from_pretrained(MODEL_ID),
    AutoModel.from_pretrained(MODEL_ID, { dtype: DTYPE, device: 'webgpu' }),
  ])

  // 1) 底层 session：transformers.js 把它存在 model.sessions['model']（公开字段）
  const sessions =
    (model as unknown as PreTrainedModel & { sessions?: Record<string, Session> }).sessions ?? {}
  const sessionKeys = Object.keys(sessions)
  const session = sessions['model']
  if (session === undefined) {
    throw new Error(`拿不到底层 ORT session（sessions keys: ${sessionKeys.join(', ') || '空'}）`)
  }

  // transformers.js Tensor → ORT Tensor：直接用公开的 ort_tensor
  const toOrt = (tensor: unknown): OrtTensor => {
    const ortTensor = (tensor as { ort_tensor?: OrtTensor }).ort_tensor
    if (ortTensor === undefined) throw new Error('transformers.js Tensor 上没有 ort_tensor')
    return ortTensor
  }
  /** 零图占位：复用现有 ort_tensor 的构造器，确保与 transformers.js 用的是同一份 ORT */
  const newOrtTensor = (proto: OrtTensor, data: Float32Array, dims: number[]): OrtTensor =>
    new proto.constructor('float32', data, dims)

  // 真实样例图（从清单里挑一张 dog-snow）+ 两条真实文本
  const manifestResponse = await fetch('/samples/manifest.json')
  const samples = (await manifestResponse.json()) as ReadonlyArray<{ file: string }>
  const sample = samples.find((entry) => entry.file.startsWith('dog-snow')) ?? samples[0]
  if (sample === undefined) throw new Error('样例清单为空')
  const image = await RawImage.fromBlob(await (await fetch(`/samples/${sample.file}`)).blob())
  const imageInputs = await processor(image)

  const zeroPixelValues = () =>
    newOrtTensor(toOrt(imageInputs.pixel_values), new Float32Array(IMAGE_PIXELS), [1, 3, 224, 224])
  const textFeeds = (text: string) => {
    const encoded = tokenizer([text], { padding: true, truncation: true })
    return { input_ids: toOrt(encoded.input_ids), attention_mask: toOrt(encoded.attention_mask) }
  }
  const feedsBothTowers = { pixel_values: toOrt(imageInputs.pixel_values), ...textFeeds('') }

  // 2) 全输出 run（transformers.js 现状）vs 指定输出列表 run（方案 C 的赌注）
  render({ phase: 'measure', runs: RUNS })
  const fullImageMs = await medianMs(() => session.run(feedsBothTowers), RUNS)
  const fullOutputs = await session.run(feedsBothTowers)
  const prunedImageMs = await medianMs(() => session.run(feedsBothTowers, ['image_embeds']), RUNS)
  const prunedImageOutputs = await session.run(feedsBothTowers, ['image_embeds'])

  // 文本塔：两条不同文本 + 零图占位
  const textA = await session.run({ ...textFeeds('雪地里的狗'), pixel_values: zeroPixelValues() }, [
    'text_embeds',
  ])
  const prunedTextMs = await medianMs(
    () =>
      session.run({ ...textFeeds('湖面上的天鹅'), pixel_values: zeroPixelValues() }, [
        'text_embeds',
      ]),
    RUNS,
  )

  // 3) 只喂单侧输入 + 指定输出：ORT 的图输入校验是否仍然拦截
  let omitOtherInputs: { ok: boolean; error?: string }
  try {
    await session.run({ pixel_values: toOrt(imageInputs.pixel_values) }, ['image_embeds'])
    omitOtherInputs = { ok: true }
  } catch (error) {
    omitOtherInputs = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  // 4) 一致性：剪枝输出 vs 全量输出（余弦 ≈ 1）；两条不同文本的向量必须不同
  const fullVector = fullOutputs['image_embeds']?.data
  const prunedVector = prunedImageOutputs['image_embeds']?.data
  const textAData = textA['text_embeds']?.data
  const textB = await session.run(
    { ...textFeeds('湖面上的天鹅'), pixel_values: zeroPixelValues() },
    ['text_embeds'],
  )
  const identicalText =
    textAData === undefined ||
    Array.from<number>(textB['text_embeds']?.data ?? []).every(
      (value, index) => value === textAData[index],
    )

  render({
    model: MODEL_ID,
    dtype: DTYPE,
    sample: sample.file,
    sessionKeys,
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    fullImageMs,
    prunedImageMs,
    prunedSpeedup: Math.round((fullImageMs / prunedImageMs) * 10) / 10,
    prunedTextMs,
    omitOtherInputs,
    imageEmbedsCosine: Math.round(cosine(fullVector ?? [], prunedVector ?? []) * 10000) / 10000,
    textSmokeDifferentVectors: !identicalText,
    runs: RUNS,
  })
}

await main().catch((error: unknown) => {
  // spike 页必须把异常显示出来：runner 只看 #out 与就绪字段，静默抛错会白等到超时
  render({
    phase: 'error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.split('\n').slice(0, 4).join(' | ') : undefined,
  })
})
