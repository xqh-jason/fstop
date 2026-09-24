/**
 * 模型目录与运行时配置。
 *
 * **本文件是全项目唯一允许发起网络请求的模块**（见 `scripts/check-egress.mjs` 白名单与计划 §11.4）。
 * 注意一句实话：实际的 HTTP 请求由 `@huggingface/transformers` 内部发起，这里只负责
 * 「允许谁、从哪里、用什么 dtype」的声明的唯一入口。真正把「零外发」变成事实的是
 * M1 的运行时请求日志断言，静态检查只是第一道闸。
 *
 * 体积数字是 2026-09-23 从 HF API（`?blobs=true`）实测的确切字节数，不是估算：
 * Chinese-CLIP ViT-B/16 是**单文件双塔**模型（一个 ONNX 里同时有图像塔与文本塔），
 * 因此不存在「vision 一个档、text 一个档」的说法——两个塔共用一个文件、一个档位。
 */

import { env } from '@huggingface/transformers'

/** 只列出会被显式指定、且经过体积实测的档位 */
export type Dtype = 'q4f16' | 'fp16' | 'fp32'

export interface ModelFile {
  readonly file: string
  readonly bytes: number
}

export interface ModelSpec {
  /** HF 仓库 id，同时是 `EmbeddingProvider.modelId` 与 `embeddings.model_id` */
  readonly id: string
  /** 向量空间标识：不同 space 的向量不可混用，各自一个 OPFS 矩阵 */
  readonly space: string
  readonly dim: number
  readonly license: string
  /**
   * 权重文件的塔结构：
   * - `split`：vision 与 text 各有独立 ONNX，可分别加载，**单塔推理不白算另一塔**
   * - `single-file`：两个塔在同一张 ONNX 图里，ORT 会计算全部输出 → 每次调用都白算另一塔
   *   （M0 实测：只喂一侧输入直接报 `Missing the following inputs`）
   */
  readonly towers: 'split' | 'single-file'
  readonly dtypes: Readonly<Record<Dtype, readonly ModelFile[]>>
}

export const MODEL_CATALOG: readonly ModelSpec[] = [
  {
    id: 'Xenova/chinese-clip-vit-base-patch16',
    space: 'chinese-clip-vit-b16',
    dim: 512,
    license: '模型卡未声明 license → 不再分发，仅脚本拉取（见 NOTICE）',
    towers: 'single-file',
    dtypes: {
      q4f16: [{ file: 'onnx/model_q4f16.onnx', bytes: 131794439 }],
      fp16: [{ file: 'onnx/model_fp16.onnx', bytes: 377377730 }],
      fp32: [{ file: 'onnx/model.onnx', bytes: 753665706 }],
    },
  },
  {
    id: 'Xenova/clip-vit-base-patch32',
    space: 'clip-vit-b32',
    dim: 512,
    license: 'MIT',
    towers: 'split',
    dtypes: {
      q4f16: [
        { file: 'onnx/vision_model_q4f16.onnx', bytes: 53267374 },
        { file: 'onnx/text_model_q4f16.onnx', bytes: 72531963 },
      ],
      fp16: [
        { file: 'onnx/vision_model_fp16.onnx', bytes: 176080659 },
        { file: 'onnx/text_model_fp16.onnx', bytes: 127339794 },
      ],
      fp32: [
        { file: 'onnx/vision_model.onnx', bytes: 351685709 },
        { file: 'onnx/text_model.onnx', bytes: 254058553 },
      ],
    },
  },
]

export const DEFAULT_MODEL_ID = 'Xenova/chinese-clip-vit-base-patch16'
export const DEFAULT_DTYPE: Dtype = 'q4f16'
export const FALLBACK_MODEL_ID = 'Xenova/clip-vit-base-patch32'

export function modelSpec(id: string = DEFAULT_MODEL_ID): ModelSpec {
  const spec = MODEL_CATALOG.find((candidate) => candidate.id === id)
  if (spec === undefined) throw new Error(`未知模型：${id}`)
  return spec
}

/** 首启下载量必须在界面上明示，这个函数就是那个数字的来源 */
export function modelBytes(id: string, dtype: Dtype): number {
  return modelSpec(id).dtypes[dtype].reduce((total, file) => total + file.bytes, 0)
}

export interface ModelRuntimeOptions {
  /** 自托管 / 镜像时改这里（§7.2 把权重同源化是让「只有一个 origin」成立的手段） */
  readonly remoteHost?: string
  readonly allowRemoteModels?: boolean
  readonly useBrowserCache?: boolean
}

/**
 * 装配推理运行时。必须在**任何**模型加载之前调用一次，否则会落到默认值：
 * WebGPU 下默认 `fp32` —— 对 Chinese-CLIP 就是 753.7 MB，而不是 131.8 MB。
 */
export function configureModelRuntime(options: ModelRuntimeOptions = {}): void {
  env.allowLocalModels = false
  env.allowRemoteModels = options.allowRemoteModels ?? true
  env.useBrowserCache = options.useBrowserCache ?? true
  if (options.remoteHost !== undefined) {
    env.remoteHost = options.remoteHost
  }
}
