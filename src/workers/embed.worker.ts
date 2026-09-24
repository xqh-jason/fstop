/**
 * 推理 Worker —— 全应用**只有一个**实例（§7.4 拓扑决策）。
 *
 * 为什么必须单实例：多实例意味着多份权重各自解析（内存峰值冲穿 1.5 GB 红线），
 * 且多个 GPU 会话互相争用队列，合并吞吐反而更低。CPU 侧的活（解码、缩略图、入库）
 * 才用多 worker 并行；GPU 侧串行。
 *
 * ⚠ M0 实测发现（会改变 §7.2 的默认模型选型）：
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
  modelSpec,
} from '../storage/models'

/** transformers.js 的张量最小形状；这里只用到 `dims` 与 `data` */
interface TensorLike {
  readonly dims: readonly number[]
  readonly data: Float32Array
}

export interface EmbedWorkerOptions {
  readonly modelId?: string
  readonly dtype?: Dtype
  readonly device?: 'webgpu' | 'wasm'
}

export interface EmbedInitResult {
  readonly modelId: string
  readonly dim: number
  readonly loadMs: number
  readonly warmupMs: number
  /** true = 单文件双塔，每次调用都会把另一塔也算一遍 */
  readonly dualTower: boolean
}

export interface EmbedService {
  init(options: EmbedWorkerOptions): Promise<EmbedInitResult>
  embedImage(bitmap: ImageBitmap): Promise<Float32Array>
  embedText(text: string): Promise<Float32Array>
}

/** 输出名不一致（`image_embeds` / `text_embeds` / `pooler_output`），按优先级取第一个命中的 */
const EMBEDDING_KEYS = ['image_embeds', 'text_embeds', 'pooler_output', 'embeddings'] as const

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
  readonly embedImage: (bitmap: ImageBitmap) => Promise<Float32Array>
  readonly embedText: (text: string) => Promise<Float32Array>
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
   * `EmbeddingProvider` 的契约是 `ImageBitmap`（§7.5，也是 Worker 间唯一可转移的图像载体），
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
    return {
      loadMs,
      dualTower: false,
      embedImage: async (bitmap) =>
        assertDim(
          normalize(firstEmbedding(await callVision(await prepare(toRawImage(bitmap)))).data),
        ),
      embedText: async (input) =>
        assertDim(
          normalize(
            firstEmbedding(await callText(encode([input], { padding: true, truncation: true })))
              .data,
          ),
        ),
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
    return assertDim(normalize(firstEmbedding(outputs).data))
  }
  const callText = async (text: string, fill: boolean): Promise<Float32Array> => {
    const inputs = encode([text], { padding: true, truncation: true })
    const outputs = await run(fill ? { ...inputs, pixel_values: placeholderImage() } : inputs)
    return assertDim(normalize(firstEmbedding(outputs).data))
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
    embedImage: (bitmap) => callImage(bitmap, dualTower),
    embedText: (text) => callText(text, dualTower),
  }
}

let service: Promise<LoadedModel> | null = null

Comlink.expose({
  async init(options: EmbedWorkerOptions): Promise<EmbedInitResult> {
    const instance = await (service ??= load(options))
    const started = performance.now()
    await instance.embedText('预热')
    return {
      modelId: options.modelId ?? DEFAULT_MODEL_ID,
      dim: modelSpec(options.modelId ?? DEFAULT_MODEL_ID).dim,
      loadMs: instance.loadMs,
      warmupMs: Math.round(performance.now() - started),
      dualTower: instance.dualTower,
    }
  },
  async embedImage(bitmap: ImageBitmap) {
    return (await (service ??= load({}))).embedImage(bitmap)
  },
  async embedText(text: string) {
    return (await (service ??= load({}))).embedText(text)
  },
} satisfies EmbedService)
