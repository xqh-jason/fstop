/**
 * 派生单塔的加载与推理 —— `bench/export-towers.py` 切出来的 ONNX 不在任何 HF 仓库里，
 * transformers.js 的模型类也认不出它们（`chinese_clip` 只有整模型），所以这一路直接建 ORT 会话。
 *
 * 三条设计约束（都是踩过的）：
 * 1. **ORT 的 wasm 运行时必须指向本机资源**：`onnxruntime-web` 的默认 `wasmPaths` 是
 *    jsdelivr CDN。裸用会引入外发请求，而「除模型权重外零出站」是项目的硬承诺。
 *    这里用 vite 的 `?url` 把 jsep 版 wasm/mjs 变成同源静态资源；
 *    基准驱动器的运行时零外发断言（`bench/runner.mjs`）会盯住这一点。
 * 2. **文本塔懒加载**：视觉塔 47.5 MB 是索引必需的，文本塔 77.9 MB 只有第一次文本查询才用得上。
 *    首启就拉 125 MB 没有道理——M1 的产品目标是「先能搜图，文本查询按需就绪」。
 * 3. **只在派生路径里加载 ORT**：`import()` 动态引入，走原生双塔路径的用户不会为它付出体积。
 */

import type { DerivedTowerPlan } from '../storage/models'
import { toPixelValues } from './embed-preprocess'
// ORT 装载与类型声明都在共享模块里：人脸 Worker 也走同一条路径（红线：同一语义不写两份）
import { loadOrt, type OrtSession } from './ort-runtime'

export interface DerivedRuntime {
  readonly resolution: number
  /** 视觉塔会话创建耗时（ms） */
  readonly visionLoadMs: number
  embedImage(bitmap: ImageBitmap): Promise<Float32Array>
  embedText(text: string): Promise<Float32Array>
  /** 文本塔是否已经就位（懒加载前为 false） */
  textReady(): boolean
}

export interface DerivedRuntimeOptions {
  /** 文本侧的分词器由调用方注入（它来自 HF 仓库的 tokenizer 文件，与权重档位无关） */
  readonly encode: (text: string) => Record<string, unknown>
  readonly executionProviders?: readonly string[]
}

/** 归一化（与双塔路径同一套契约：L2 单位向量，零向量直接报错） */
function normalize(vector: Float32Array): Float32Array {
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

/** 把 tokenizer 输出转成 ORT 要的 int64 张量（transformers.js 的 `.ort_tensor` 就是它） */
function int64Tensor(value: unknown): unknown {
  const tensor = value as { ort_tensor?: unknown } | undefined
  if (tensor?.ort_tensor !== undefined) return tensor.ort_tensor
  throw new Error('tokenizer 没有产出 ort_tensor（transformers.js 版本变了？）')
}

export async function createDerivedRuntime(
  plan: DerivedTowerPlan,
  options: DerivedRuntimeOptions,
): Promise<DerivedRuntime> {
  const providers = options.executionProviders ?? ['webgpu']
  const ort = await loadOrt()
  const visionStarted = performance.now()
  const vision = await ort.InferenceSession.create(`${plan.base}/${plan.vision.file}`, {
    executionProviders: providers,
  })
  const visionLoadMs = Math.round(performance.now() - visionStarted)

  // 文本塔懒加载：第一次 embedText 才建会话（77.9 MB 不该在首启就下）
  let text: Promise<OrtSession> | null = null
  const textSession = (): Promise<OrtSession> => {
    text ??= ort.InferenceSession.create(`${plan.base}/${plan.text.file}`, {
      executionProviders: providers,
    })
    return text
  }

  const embedImage = async (bitmap: ImageBitmap): Promise<Float32Array> => {
    const pixels = await toPixelValues(bitmap, plan.resolution)
    const outputs = await vision.run({
      pixel_values: new ort.Tensor('float32', pixels, [1, 3, plan.resolution, plan.resolution]),
    })
    const embedding = outputs['image_embeds']
    if (embedding === undefined) {
      throw new Error(`视觉塔没有输出 image_embeds，实际输出：${Object.keys(outputs).join(', ')}`)
    }
    return normalize(embedding.data)
  }

  const embedText = async (input: string): Promise<Float32Array> => {
    const session = await textSession()
    const encoded = options.encode(input)
    const outputs = await session.run({
      input_ids: int64Tensor(encoded['input_ids']),
      attention_mask: int64Tensor(encoded['attention_mask']),
    })
    const embedding = outputs['text_embeds']
    if (embedding === undefined) {
      throw new Error(`文本塔没有输出 text_embeds，实际输出：${Object.keys(outputs).join(', ')}`)
    }
    return normalize(embedding.data)
  }

  return {
    resolution: plan.resolution,
    visionLoadMs,
    embedImage,
    embedText,
    textReady: () => text !== null,
  }
}
