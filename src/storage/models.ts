/**
 * 模型目录与运行时配置。
 *
 * **本文件是全项目唯一允许发起网络请求的模块**（见 `scripts/check-egress.mjs` 白名单与 docs/DESIGN.md）。
 * 注意一句实话：实际的 HTTP 请求由 `@huggingface/transformers` 内部发起，这里只负责
 * 「允许谁、从哪里、用什么 dtype」的声明的唯一入口。真正把「零外发」变成事实的是
 * M1 的运行时请求日志断言，静态检查只是第一道闸。
 *
 * 体积数字是 2026-09-23 从 HF API（`?blobs=true`）实测的确切字节数，不是估算：
 * Chinese-CLIP ViT-B/16 是**单文件双塔**模型（一个 ONNX 里同时有图像塔与文本塔），
 * 因此不存在「vision 一个档、text 一个档」的说法——两个塔共用一个文件、一个档位。
 */

import { env } from '@huggingface/transformers'
// ORT 的 wasm 运行时（vite 产出同源静态资源 URL）。**必须在任何模型加载前钉到本机**：
// transformers.js 的默认值是把 `wasmPaths` 指向 jsdelivr CDN（其 dist 里的 `initOrtEnv`），
// 冷缓存时那一发 25.6 MB 的请求就把「零外发」破了——实测在基准 profile 的 CacheStorage 里
// 翻出了 `cdn.jsdelivr.net/npm/onnxruntime-web@…/ort-wasm-simd-threaded.asyncify.wasm` 的条目。
// 缓存热时它不会再发请求（走 Cache API），所以只有冷启动才看得见，静态扫描更看不见。
import onnxWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'

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
  /** 自托管 / 镜像时改这里（docs/DESIGN.md 把权重同源化是让「只有一个 origin」成立的手段） */
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
  // 把 ORT 的 wasm 运行时钉到本机资源（见文件头注释）。这里改的是 ORT 自己的 env 对象
  // （transformers.js 的 `env.backends.onnx` 是它的引用），所以**必须先于任何模型加载**。
  const ortWasm = env.backends.onnx.wasm
  if (ortWasm === undefined) {
    // 显式报错而不是静默跳过：跳过就等于回落到 CDN 默认值，那正是这里要杜绝的行为
    throw new Error('ORT 的 wasm 后端不可用，无法把 wasmPaths 钉到本机资源')
  }
  ortWasm.wasmPaths = { wasm: onnxWasmUrl }
}

// ── 人脸模型（M2） ────────────────────────────────────────────────────────────
//
// 规格由 `bench/face-model-probe.py` 从权重文件实测读出（不是照着别人文档抄的）：
// - 检测 `immich-app/scrfd_34g_gnkps/detection/model.onnx`，MIT，39.4 MB
//   输入 `input.1` [1,3,640,640]；输出三档 stride（8/16/32）各一组
//   `score_{s}` [N,1] + `bbox_{s}` [N,4] + `kps_{s}` [N,10]，N = (640/s)² × 2 个 anchor
// - 识别 `immich-app/antelopev2/recognition/model.onnx`（glintr100/r100 重导出），
//   **非商用**（insightface 的 license，见 NOTICE §3），260.7 MB
//   输入 `input.1` [None,3,112,112]；输出 [1,512]（未归一化，需 L2 归一化）
//
// 为什么不做成本地派生产物：这两个权重的输入尺寸与我们的用法一致（640 检测、112 对齐识别），
// 不需要图手术；直接按 model origin 拉取即可，也就不存在「派生产物分发」的 license 问题。
export interface FaceDetectorSpec {
  readonly modelId: string
  readonly url: string
  readonly bytes: number
  readonly license: string
  /** 送进网络的方形边长 */
  readonly inputSize: number
  readonly strides: readonly number[]
  readonly anchorsPerLocation: number
  readonly scoreThreshold: number
  readonly iouThreshold: number
}

export interface FaceRecognizerSpec {
  readonly modelId: string
  readonly url: string
  readonly bytes: number
  readonly license: string
  readonly inputSize: number
  readonly dim: number
}

export const FACE_MODEL_HOST = 'https://huggingface.co'

export const FACE_DETECTOR: FaceDetectorSpec = {
  modelId: 'immich-app/scrfd_34g_gnkps',
  url: `${FACE_MODEL_HOST}/immich-app/scrfd_34g_gnkps/resolve/main/detection/model.onnx`,
  bytes: 39424525,
  license: 'MIT',
  inputSize: 640,
  strides: [8, 16, 32],
  anchorsPerLocation: 2,
  scoreThreshold: 0.5,
  iouThreshold: 0.4,
}

export const FACE_RECOGNIZER: FaceRecognizerSpec = {
  modelId: 'immich-app/antelopev2',
  url: `${FACE_MODEL_HOST}/immich-app/antelopev2/resolve/main/recognition/model.onnx`,
  bytes: 260665334,
  license: '非商用（insightface antelopev2）—— 见 NOTICE §3',
  inputSize: 112,
  dim: 512,
}

// ── 派生产物（图手术导出的单塔） ───────────────────────────────────────────────
//
// 背景（docs/DESIGN.md）：`Xenova/chinese-clip-vit-base-patch16` 是**单文件双塔**，
// 且视觉塔的分辨率被导出写死在 224²/197 token。`bench/export-towers.py` 用图手术切出
// 「视觉塔（任意分辨率）+ 文本塔」两个独立 ONNX，192² 档把 1 万张外推推进 10 分钟冲刺线，
// 而质量损失在 783 张 / 106 条 query 上测不出来。
//
// **这些派生产物是权重**（源权重的改写版），源模型模型卡未声明 license
// → 一律**不进仓库**（见 NOTICE §1）。所以这里是「探测本地是否已生成」，
// 探测不到就回落到原生双塔路径——没跑过生成脚本的用户照样能用，只是慢一些。

/**
 * 派生权重目录（`public/models/derived/`，已 gitignore，由生成脚本写入；见 `docs/DESIGN.md`）。
 *
 * 跟着构建 base 走：部署在子路径下时写死 `/models/...` 会探测失败，
 * 而探不到派生权重只会退化为原版双塔（更慢但不报错），属于最难察觉的一类回归。
 */
export const DERIVED_MODEL_BASE = `${import.meta.env.BASE_URL}models/derived`

export interface DerivedTowerFile {
  readonly file: string
  readonly bytes: number
  readonly sha256?: string
}

export interface DerivedTowerPlan {
  readonly base: string
  readonly modelId?: string
  readonly dtype: string
  /** 视觉塔分辨率（= 输入边长；token 数 = (resolution/16)² + 1） */
  readonly resolution: number
  readonly tokens: number
  readonly vision: DerivedTowerFile
  readonly text: DerivedTowerFile
  readonly source?: { readonly file?: string; readonly sha256?: string }
}

interface DerivedManifest {
  readonly model?: string
  readonly dtype?: string
  readonly vision?: {
    file?: string
    resolution?: number
    tokens?: number
    bytes?: number
    sha256?: string
  }
  readonly text?: { file?: string; bytes?: number; sha256?: string }
  readonly source?: { file?: string; sha256?: string }
}

/**
 * 探测本地派生产物。**这是全项目第二处、也是最后一处允许发请求的地方**（同在本文件内，
 * 白名单 `src/storage/models.ts` 不变）——请求的是**同源静态文件**，不是外发。
 *
 * 探测失败一律返回 `null`（不抛）：派生产物是可选加速路径，缺失不是错误。
 */
export async function discoverDerivedTowers(
  options: { base?: string; resolution?: number; modelId?: string } = {},
): Promise<DerivedTowerPlan | null> {
  const base = options.base ?? DERIVED_MODEL_BASE
  let manifest: DerivedManifest
  try {
    const response = await fetch(`${base}/manifest.json`, { cache: 'no-store' })
    if (!response.ok) return null
    manifest = (await response.json()) as DerivedManifest
  } catch {
    return null
  }
  const vision = manifest.vision
  const text = manifest.text
  const resolution = vision?.resolution
  const tokens = vision?.tokens
  if (
    typeof vision?.file !== 'string' ||
    typeof text?.file !== 'string' ||
    typeof resolution !== 'number' ||
    typeof tokens !== 'number' ||
    typeof vision.bytes !== 'number' ||
    typeof text.bytes !== 'number'
  ) {
    return null
  }
  // 指定了分辨率就必须匹配（避免拿 160² 的产物当 192² 用）
  if (options.resolution !== undefined && options.resolution !== resolution) return null
  // 指定了模型就必须匹配（切出来的塔只对源模型成立，不能塞给另一个模型）
  if (options.modelId !== undefined && manifest.model !== options.modelId) return null
  return {
    base,
    modelId: manifest.model,
    dtype: manifest.dtype ?? DEFAULT_DTYPE,
    resolution,
    tokens,
    vision: { file: vision.file, bytes: vision.bytes, sha256: vision.sha256 },
    text: { file: text.file, bytes: text.bytes, sha256: text.sha256 },
    source: manifest.source,
  }
}
