/**
 * 推理 Worker —— 全应用**只有一个**实例（docs/DESIGN.md 拓扑决策）。
 *
 * 为什么必须单实例：多实例意味着多份权重各自解析（内存峰值冲穿 1.5 GB 红线），
 * 且多个 GPU 会话互相争用队列，合并吞吐反而更低。CPU 侧的活（解码、缩略图、入库）
 * 才用多 worker 并行；GPU 侧串行。
 *
 * ⚠ M0 实测发现（会改变 docs/DESIGN.md 的默认模型选型）：
 * `Xenova/chinese-clip-vit-base-patch16` 是**单文件双塔**模型，其 ONNX 图把两个塔的输入
 * 都声明为必填——只喂 `pixel_values` 会报 `Missing the following inputs: input_ids`，
 * 只喂 `input_ids` 会报 `Missing the following inputs: pixel_values`。
 * ONNX Runtime 会计算图里声明的**全部**输出，所以无论索引还是查询，另一塔都会白算一遍。
 * 这里用「补齐另一塔的合法但无意义输入」把链路先跑通并**量出这份代价**，
 * 真正的解法（拆塔导出 / 直接用 ort 指定 fetch）留到 M1 决策。
 */

import {
  AutoModel,
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
  Tensor,
} from '@huggingface/transformers'
import * as Comlink from 'comlink'
import type { Dtype } from '../storage/models'
import {
  DEFAULT_DTYPE,
  DEFAULT_MODEL_ID,
  configureModelRuntime,
  discoverDerivedTowers,
  modelSpec,
} from '../storage/models'
import { createDerivedRuntime } from './embed-derived'

/** transformers.js 的张量最小形状；这里只用到 `dims` 与 `data` */
interface TensorLike {
  readonly dims: readonly number[]
  readonly data: Float32Array
}

export interface EmbedWorkerOptions {
  readonly modelId?: string
  readonly dtype?: Dtype
  readonly device?: 'webgpu' | 'wasm'
  /** 派生单塔（图手术导出）走的分辨率；给了就只认这一档，探测不到即回落原生双塔 */
  readonly derivedResolution?: number
  /** 显式关闭派生路径（基准里做 A/B 用） */
  readonly useDerived?: boolean
}

export interface EmbedInitResult {
  readonly modelId: string
  readonly dim: number
  readonly loadMs: number
  readonly warmupMs: number
  /** true = 单文件双塔，每次调用都会把另一塔也算一遍 */
  readonly dualTower: boolean
  /** 实际走的是哪条路径：派生单塔 / 原生单文件双塔 / 原生分塔 */
  readonly path: 'derived' | 'stock-dual' | 'stock-split'
  /** 派生路径的视觉塔分辨率（原生路径为 undefined） */
  readonly derivedResolution?: number
  /** 派生路径的下载体积（字节）：视觉塔常驻、文本塔懒加载，首启只付视觉塔 */
  readonly derivedBytes?: { readonly vision: number; readonly text: number }
  /** 派生路径探测/建会话失败的原因（**不静默**：回落了也要能看见为什么） */
  readonly derivedError?: string
}

export interface EmbedService {
  init(options: EmbedWorkerOptions): Promise<EmbedInitResult>
  embedImage(bitmap: ImageBitmap): Promise<Float32Array>
  embedText(text: string): Promise<Float32Array>
  /**
   * 显式预热文本侧。派生路径下文本塔是**懒加载**的（77.9 MB 不该在首启就下），
   * 所以 `init` 不会碰它；要在计时里排除建会话成本，就先调这个。
   * 返回文本侧预热耗时（ms）。
   */
  warmupText(): Promise<number>
}

/** 输出名不一致（`image_embeds` / `text_embeds` / `pooler_output`），按优先级取第一个命中的 */
const EMBEDDING_KEYS = ['image_embeds', 'text_embeds', 'pooler_output', 'embeddings'] as const

/**
 * 按模态选嵌入输出。
 *
 * ⚠ 这里的 preferred 不是装饰：双塔 ONNX 图（Chinese-CLIP）会同时输出 `image_embeds` 与
 * `text_embeds`，若只按 EMBEDDING_KEYS 优先级取，文本查询会**永远命中 image_embeds**——
 * 即「占位零图」的图像向量，所有 query 得到同一个常量向量、检索结果与文本完全无关
 * （M0 质量页首跑抓到的真 bug：23 条 query 排名逐位相同）。
 * 因此双塔路径必须显式指定模态；单塔/未知输出名才落回 firstEmbedding 的优先级兜底。
 */
function embeddingFor(
  outputs: Record<string, unknown>,
  preferred: 'image_embeds' | 'text_embeds',
): TensorLike {
  const preferredOutput = outputs[preferred]
  if (preferredOutput !== undefined && preferredOutput !== null) {
    return preferredOutput as TensorLike
  }
  return firstEmbedding(outputs)
}

/** 来自 `Xenova/chinese-clip-vit-base-patch16` 的 preprocessor_config.json（crop_size 224） */
const IMAGE_SIZE = 224

export function normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  if (norm === 0) throw new Error('嵌入向量为零向量：模型输出异常')
  const normalized = new Float32Array(vector.length)
  for (let index = 0; index < vector.length; index += 1) {
    normalized[index] = (vector[index] ?? 0) / norm
  }
  return normalized
}

export function firstEmbedding(outputs: Record<string, unknown>): TensorLike {
  for (const key of EMBEDDING_KEYS) {
    const candidate = outputs[key]
    if (candidate !== undefined && candidate !== null) return candidate as TensorLike
  }
  throw new Error(`模型输出里没有可识别的嵌入张量，实际输出：${Object.keys(outputs).join(', ')}`)
}

interface LoadedModel {
  readonly loadMs: number
  readonly dualTower: boolean
  readonly path: 'derived' | 'stock-dual' | 'stock-split'
  readonly derivedResolution?: number
  readonly derivedBytes?: { readonly vision: number; readonly text: number }
  readonly derivedError?: string
  /** 预热视觉侧：各路径按自己的输入尺寸造一张假图跑一次（把内核编译从计时里摘掉） */
  readonly warmupImage: () => Promise<void>
  /** 文本侧是否在 init 时一并预热（派生路径为 false：文本塔懒加载） */
  readonly warmupTextInInit: boolean
  readonly embedImage: (bitmap: ImageBitmap) => Promise<Float32Array>
  readonly embedText: (text: string) => Promise<Float32Array>
}

/** 造一张假图当预热输入（各路径的实际输入尺寸不同，由调用方决定边长） */
function blankBitmap(size: number): ImageBitmap {
  const canvas = new OffscreenCanvas(size, size)
  // 必须先拿到 2d context：没有 context 的 OffscreenCanvas 调 transferToImageBitmap 会抛
  // InvalidStateError（实测踩过：init 永远不 resolve，整轮基准卡在 load:models）
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('OffscreenCanvas 2d context 不可用')
  context.fillRect(0, 0, size, size)
  return canvas.transferToImageBitmap()
}

async function load(options: EmbedWorkerOptions): Promise<LoadedModel> {
  const modelId = options.modelId ?? DEFAULT_MODEL_ID
  const spec = modelSpec(modelId)
  const dtype = options.dtype ?? DEFAULT_DTYPE
  const device = options.device ?? 'webgpu'

  configureModelRuntime()
  const loadStarted = performance.now()

  // transformers.js 没有 ChineseCLIPProcessor（processing_auto 里没有 chinese_clip），
  // AutoProcessor 只会给出图像处理器，因此文本侧必须单独取 tokenizer。
  const processor = await AutoProcessor.from_pretrained(modelId)
  const tokenizer = await AutoTokenizer.from_pretrained(modelId)
  const prepare = processor as unknown as (images: unknown) => Promise<Record<string, unknown>>
  const encode = tokenizer as unknown as (
    text: string[],
    options: Record<string, unknown>,
  ) => Record<string, unknown>

  /**
   * `EmbeddingProvider` 的契约是 `ImageBitmap`（docs/DESIGN.md，也是 Worker 间唯一可转移的图像载体），
   * 但 transformers.js 的 `RawImage.read` 只接受 Blob / canvas / RawImage，不接受 ImageBitmap。
   * 这层转换（一次 drawImage + 一次 getImageData，512² ≈ 1 MB）是契约落地的必要成本，
   * 不是可以省掉的拷贝。
   */
  const toRawImage = (bitmap: ImageBitmap): RawImage => {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('OffscreenCanvas 2d context 不可用')
    context.drawImage(bitmap, 0, 0)
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    return new RawImage(data, bitmap.width, bitmap.height, 4)
  }

  const assertDim = (vector: Float32Array): Float32Array => {
    if (vector.length !== spec.dim) {
      throw new Error(`向量维度 ${vector.length} 与目录声明的 ${spec.dim} 不一致`)
    }
    return vector
  }

  // ── 优先走派生单塔（图手术导出，docs/DESIGN.md）──────────────────────────
  // 原生单文件双塔每次调用都要把另一塔也算一遍，且视觉塔分辨率被导出写死在 224²（197 token）。
  // 派生塔把 192² 档的 1 万张外推推进 10 分钟冲刺线，质量损失在 783 张 / 106 条 query 上测不出。
  // 探测不到就回落（可选加速路径，不是硬依赖），但**失败原因必须带出去**——静默回落是 M0 的教训。
  let derivedError: string | undefined
  if (options.useDerived !== false && spec.towers === 'single-file') {
    try {
      const plan = await discoverDerivedTowers(
        options.derivedResolution === undefined
          ? { modelId }
          : { modelId, resolution: options.derivedResolution },
      )
      if (plan === null) {
        derivedError =
          options.derivedResolution === undefined
            ? '本地没有派生产物（缺 /models/derived/manifest.json 或模型不匹配）'
            : `本地没有 ${options.derivedResolution}² 的派生产物`
      } else {
        // 分词器仍取自 HF 仓库：只有几 MB，且与权重档位无关（切塔不改词表）
        const tokenizer = await AutoTokenizer.from_pretrained(modelId)
        const encodeDerived = tokenizer as unknown as (text: string) => Record<string, unknown>
        const runtime = await createDerivedRuntime(plan, { encode: encodeDerived })
        const loadMs = Math.round(performance.now() - loadStarted)
        console.log(
          `[embed] 派生单塔就绪：${plan.resolution}²（${plan.vision.file}，视觉塔建会话 ${runtime.visionLoadMs} ms，文本塔懒加载）`,
        )
        const embedImage = async (bitmap: ImageBitmap): Promise<Float32Array> =>
          assertDim(await runtime.embedImage(bitmap))
        return {
          loadMs,
          dualTower: false,
          path: 'derived',
          derivedResolution: plan.resolution,
          derivedBytes: { vision: plan.vision.bytes, text: plan.text.bytes },
          warmupImage: async () => {
            await embedImage(blankBitmap(plan.resolution))
          },
          warmupTextInInit: false,
          embedImage,
          embedText: async (input) => assertDim(await runtime.embedText(input)),
        }
      }
    } catch (error) {
      derivedError = error instanceof Error ? error.message : String(error)
      console.warn(`[embed] 派生塔不可用，回落原生路径：${derivedError}`)
    }
  }

  // 分塔模型必须显式用任务专属类：`AutoModel` 与 `pipeline('feature-extraction')` 都会解析成
  // 双塔 `CLIPModel`（实测：文本调用报缺 `pixel_values`），单塔推理根本拿不到。
  if (spec.towers === 'split') {
    const vision = await CLIPVisionModelWithProjection.from_pretrained(modelId, { dtype, device })
    const text = await CLIPTextModelWithProjection.from_pretrained(modelId, { dtype, device })
    const loadMs = Math.round(performance.now() - loadStarted)
    const callVision = vision as unknown as (
      inputs: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>
    const callText = text as unknown as (
      inputs: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>
    const embedImage = async (bitmap: ImageBitmap): Promise<Float32Array> =>
      assertDim(
        normalize(
          embeddingFor(await callVision(await prepare(toRawImage(bitmap))), 'image_embeds').data,
        ),
      )
    const embedText = async (input: string): Promise<Float32Array> =>
      assertDim(
        normalize(
          embeddingFor(
            await callText(encode([input], { padding: true, truncation: true })),
            'text_embeds',
          ).data,
        ),
      )
    return {
      loadMs,
      dualTower: false,
      path: 'stock-split',
      derivedError,
      warmupImage: async () => {
        await embedImage(blankBitmap(IMAGE_SIZE))
      },
      warmupTextInInit: true,
      embedImage,
      embedText,
    }
  }

  const model = await AutoModel.from_pretrained(modelId, { dtype, device })
  const loadMs = Math.round(performance.now() - loadStarted)

  const run = model as unknown as (
    inputs: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>

  // 占位输入只建一次：602 KB 的零张量没必要每次调用都重新分配
  let imagePlaceholder: Tensor | null = null
  const placeholderImage = (): Tensor => {
    imagePlaceholder ??= new Tensor('float32', new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE), [
      1,
      3,
      IMAGE_SIZE,
      IMAGE_SIZE,
    ])
    return imagePlaceholder
  }
  const placeholderText = (): Record<string, unknown> =>
    encode([''], { padding: true, truncation: true })

  const callImage = async (bitmap: ImageBitmap, fill: boolean): Promise<Float32Array> => {
    const inputs = await prepare(toRawImage(bitmap))
    const outputs = await run(fill ? { ...inputs, ...placeholderText() } : inputs)
    return assertDim(normalize(embeddingFor(outputs, 'image_embeds').data))
  }
  const callText = async (text: string, fill: boolean): Promise<Float32Array> => {
    const inputs = encode([text], { padding: true, truncation: true })
    const outputs = await run(fill ? { ...inputs, pixel_values: placeholderImage() } : inputs)
    return assertDim(normalize(embeddingFor(outputs, 'text_embeds').data))
  }

  // 用一次最小调用判定是否为「单文件双塔」：报缺输入即说明另一塔也在图里
  let dualTower = false
  try {
    await callText('', false)
  } catch (error) {
    dualTower = /Missing the following inputs/.test(
      error instanceof Error ? error.message : String(error),
    )
    if (!dualTower) throw error
  }

  return {
    loadMs,
    dualTower,
    path: 'stock-dual',
    derivedError,
    warmupImage: async () => {
      await callImage(blankBitmap(IMAGE_SIZE), dualTower)
    },
    warmupTextInInit: true,
    embedImage: (bitmap) => callImage(bitmap, dualTower),
    embedText: (text) => callText(text, dualTower),
  }
}

let service: Promise<LoadedModel> | null = null

Comlink.expose({
  async init(options: EmbedWorkerOptions): Promise<EmbedInitResult> {
    const instance = await (service ??= load(options))
    const started = performance.now()
    // 视觉侧预热：各路径按自己的输入尺寸跑一张假图，把内核编译从首张照片的计时里摘掉。
    await instance.warmupImage()
    // 文本侧只在原生路径一并预热：派生路径的文本塔是懒加载的（77.9 MB），要预热请显式调 warmupText
    if (instance.warmupTextInInit) await instance.embedText('预热')
    return {
      modelId: options.modelId ?? DEFAULT_MODEL_ID,
      dim: modelSpec(options.modelId ?? DEFAULT_MODEL_ID).dim,
      loadMs: instance.loadMs,
      warmupMs: Math.round(performance.now() - started),
      dualTower: instance.dualTower,
      path: instance.path,
      derivedResolution: instance.derivedResolution,
      derivedBytes: instance.derivedBytes,
      derivedError: instance.derivedError,
    }
  },
  async embedImage(bitmap: ImageBitmap) {
    return (await (service ??= load({}))).embedImage(bitmap)
  },
  async embedText(text: string) {
    return (await (service ??= load({}))).embedText(text)
  },
  async warmupText(): Promise<number> {
    const instance = await (service ??= load({}))
    const started = performance.now()
    await instance.embedText('预热')
    return Math.round(performance.now() - started)
  },
} satisfies EmbedService)
