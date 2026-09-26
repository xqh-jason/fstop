/**
 * ORT 运行时装载（共享）—— 人脸 Worker 与派生塔路径用**同一份**。
 *
 * 提取的理由是项目红线「同一语义不允许两份实现」：人脸模型走的是 `onnxruntime-web`
 * 直连（不是 transformers.js），如果各写一份 `loadOrt`，两个坑（wasm 必须同源、
 * `.bundle.` 构建配 asyncify wasm）就会各修一次、各踩一次。
 *
 * 两个坑的细节：
 * 1. `onnxruntime-web/webgpu` 导出的是 **`.bundle.` 构建**（内嵌 emscripten glue），
 *    它配的 wasm 是 **asyncify** 版；给 jsep 版、或者额外给 `mjs`（会让它去加载独立的
 *    glue 模块），都会在 `InferenceSession.create` 时报
 *    `no available backend found. ERR: [webgpu] TypeError: …webgpuInit is not a function`。
 *    正确做法与 transformers.js 一致：asyncify wasm + **不给 mjs**。
 * 2. 不给 `wasmPaths` 的话 ORT 会回落到 CDN（见 `src/storage/models.ts` 文件头注释）。
 */

export interface OrtTensor {
  readonly data: Float32Array
  readonly dims: readonly number[]
}

export interface OrtSession {
  run(
    feeds: Record<string, unknown>,
    fetches?: readonly string[],
  ): Promise<Record<string, OrtTensor>>
  release?: () => Promise<void>
}

export interface OrtModule {
  InferenceSession: { create(path: string, options?: Record<string, unknown>): Promise<OrtSession> }
  Tensor: new (type: string, data: Float32Array, dims: readonly number[]) => unknown
  env: { wasm: Record<string, unknown>; logLevel?: string }
}

let ortModule: Promise<OrtModule> | null = null

/** 动态加载 ORT 并把 wasm 运行时钉到同源资源上（只加载一次） */
export async function loadOrt(): Promise<OrtModule> {
  ortModule ??= (async () => {
    const [ort, wasm] = await Promise.all([
      import('onnxruntime-web/webgpu') as unknown as Promise<OrtModule>,
      import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'),
    ])
    ort.env.wasm['wasmPaths'] = { wasm: wasm.default }
    ort.env.wasm['proxy'] = false
    return ort
  })()
  return ortModule
}
