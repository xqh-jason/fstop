/**
 * EmbeddingProvider —— 推理后端的唯一抽象。见 docs/DESIGN.md
 *
 * 实现：
 * - `TransformersProvider`（workers/，M0）：transformers.js + WebGPU，`dtype` 必须显式指定
 * - `WasmFallbackProvider`：WebGPU 不可用时的降级路径
 * - 未来的 CoreML / 原生后端（M4）：换实现而不是重写
 *
 * 契约：
 * - 向量必须是 **L2 归一化** 的、长度为 `dim` 的 `Float32Array`：检索层在扁平矩阵上做点积，
 *   归一化后点积即余弦相似度（自实现向量检索）。
 * - `modelId` 是 `embeddings.model_id` 与 OPFS 向量矩阵的键。**不同 `modelId` 的向量不得混用**，
 *   原版 CLIP 与 Chinese-CLIP 的图像侧不在同一向量空间。
 * - `embedImage` 收到的 `ImageBitmap` 必须是**已应用 EXIF 方向**的，否则向量与缩略图都会错。
 * - 应用内同时只有一个 provider 实例（独占 GPU、权重只有一份，docs/DESIGN.md），因此不要求线程安全。
 */

export interface EmbeddingProvider {
  /** 例如 `Xenova/chinese-clip-vit-base-patch16`；同时也是向量空间的标识 */
  readonly modelId: string
  /** 向量维度，例如 ViT-B/32 与 Chinese-CLIP ViT-B/16 均为 512 */
  readonly dim: number

  embedImage(bitmap: ImageBitmap): Promise<Float32Array>

  embedText(text: string): Promise<Float32Array>

  /**
   * 着色器编译等一次性预热，冷启 1–3 s。
   * 必须前置到模型加载阶段，否则性能指标会被误判（预算「热会话」的定义）。
   */
  warmup(): Promise<void>
}
