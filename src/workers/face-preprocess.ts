/**
 * 人脸预处理 —— 位图 → 张量（检测用整图 letterbox，识别用 5 点对齐裁切）。
 *
 * 提成独立模块的理由与 `embed-preprocess.ts` 一样：**探针与产品必须走同一份预处理**，
 * 否则「探针里检出 0 张脸」和「产品里检出 0 张脸」可能是两个不同的原因，
 * 而基准页测出来的数字也就不能描述产品路径。
 *
 * 归一化口径 `(v - 127.5) / 127.5`：直接套用 `rgbaToChw` 的 mean/std 参数，
 * 不另写一份换算式。
 */

import { letterbox, type Letterbox } from '../core/face-detect'
import { ARCFACE_TEMPLATE, solveSimilarity } from '../core/face-align'
import { rgbaToChw } from './embed-preprocess'

/**
 * SCRFD/ArcFace 的像素归一化 `(v - 127.5) / 127.5`。
 *
 * **注意 `rgbaToChw` 的口径**：它先把像素除以 255 变成 0..1，再套 mean/std，
 * 所以这里的 mean/std 是 **0.5**，不是 127.5 —— 写成 127.5 会让整张输入塌成常数 −1，
 * 模型输出全是噪声级分数（实测：max score 0.014，一张脸都检不出来）。
 * 预处理变体扫描见 `bench/face-probe.mjs`（`PROBE_MODE=sweep`），这条结论是扫出来的。
 */
export const FACE_MEAN = [0.5, 0.5, 0.5] as const
export const FACE_STD = [0.5, 0.5, 0.5] as const

/**
 * 人脸链的解码边长（`decodePhoto` 的 `embedSide`）。
 *
 * **不要沿用照片嵌入的 512**（实测踩过）：`embedSide: 512` 是给 CLIP 调优的值，人脸链复用它
 * 会把检测输入压到 512 —— 小脸直接检不到、对齐出的 112² 裁切也糊，聚类质量跟着崩。
 * 人脸这边取 **1280**：SCRFD 内部本来就缩到 640，给足源分辨率才有小脸召回；
 * 再大只是白花解码时间与内存（一张 1280 长边的位图约 4 MB，可接受）。
 */
export const FACE_DECODE_SIDE = 1280

export interface DetectorInput {
  readonly tensor: Float32Array
  readonly box: Letterbox
}

/**
 * 检测输入：等比缩放到 `inputSize²` 左上对齐（余下留 0）。
 *
 * 与 insightface 的 `det_scale` 同口径：先算 scale，再把内容画到全 0 画布的左上角。
 * 注意**不是**拉伸填满：拉伸会改变人脸长宽比，SCRFD 对小脸的召回会掉。
 */
export function detectorInput(bitmap: ImageBitmap, inputSize: number): DetectorInput {
  const box = letterbox(bitmap.width, bitmap.height, inputSize)
  const canvas = new OffscreenCanvas(inputSize, inputSize)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new Error('OffscreenCanvas 2d context 不可用')
  context.clearRect(0, 0, inputSize, inputSize)
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, box.contentWidth, box.contentHeight)
  const { data } = context.getImageData(0, 0, inputSize, inputSize)
  return { tensor: rgbaToChw(data, inputSize, FACE_MEAN, FACE_STD), box }
}

/**
 * 识别输入：按 5 点相似变换把脸摆正裁到 `size²`。
 * 用 `setTransform` 让浏览器做重采样（相似变换是仿射的特例，画布天然支持）。
 */
export function alignedInput(
  bitmap: ImageBitmap,
  landmarks: readonly { x: number; y: number }[],
  size: number,
): Float32Array {
  const transform = solveSimilarity(landmarks, ARCFACE_TEMPLATE)
  const canvas = new OffscreenCanvas(size, size)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new Error('OffscreenCanvas 2d context 不可用')
  // 相似变换矩阵 [a, b, tx, -b, a, ty] → CanvasRenderingContext2D 的 (a, b, c, d, e, f)
  const [a, b, tx, c, d, ty] = transform
  context.setTransform(a, b, c, d, tx, ty)
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0)
  context.setTransform(1, 0, 0, 1, 0, 0)
  const { data } = context.getImageData(0, 0, size, size)
  return rgbaToChw(data, size, FACE_MEAN, FACE_STD)
}
