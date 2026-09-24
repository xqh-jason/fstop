/**
 * 图像预处理 —— 把 `ImageBitmap` 变成视觉塔要的 `pixel_values`（NCHW float32）。
 *
 * **为什么不能直接用 `AutoProcessor`**：`ChineseCLIPFeatureExtractor` 的
 * `preprocessor_config.json` 写死 `size 224×224` 且 `do_resize: true`
 * （注意 `do_center_crop: false` —— 它是**直接压扁到 224²，不裁切**），
 * 所以任何输入都会被重缩回 224²：想按 192² 跑导出的单塔，就必须自己产出张量。
 *
 * **为什么放在 `src/` 而不是 `bench/`**：基准页与产品 Worker 必须走**同一份**预处理，
 * 否则「基准测出来的质量/速度」描述的是另一条路径。M0 的实测记录 §9.9 就是这么测的
 * （当时基准页里有一份等价的私有实现），M1 把它提到产品侧共用。
 *
 * 与 processor 的已知差异：缩放滤波器。processor 用 `resample: 3`（双三次），
 * 这里用 `OffscreenCanvas.drawImage`（实现自选，Chromium 降采样质量良好）。
 * 这个差异会在基准里用「同一张图两条路径的向量余弦」验证（见 `bench/exported.ts`）。
 */

/** 来自 `Xenova/chinese-clip-vit-base-patch16` 的 `preprocessor_config.json` */
export const IMAGE_MEAN = [0.48145466, 0.4578275, 0.40821073] as const
export const IMAGE_STD = [0.26862954, 0.26130258, 0.27577711] as const
/** processor 的默认边长；导出塔的档位边长由调用方给 */
export const DEFAULT_IMAGE_SIZE = 224

/**
 * RGBA 像素 → NCHW float32（`rescale_factor = 1/255`，再按 mean/std 归一化）。
 * 纯函数：不碰 DOM，便于单测。
 */
export function rgbaToChw(
  rgba: Uint8ClampedArray | Uint8Array,
  size: number,
  mean: readonly number[] = IMAGE_MEAN,
  std: readonly number[] = IMAGE_STD,
): Float32Array {
  const area = size * size
  if (rgba.length < area * 4) {
    throw new Error(`像素数据不足：期望 ${area * 4} 字节，实际 ${rgba.length}`)
  }
  const data = new Float32Array(3 * area)
  for (let index = 0; index < area; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = (rgba[index * 4 + channel] ?? 0) / 255
      data[channel * area + index] = (value - (mean[channel] ?? 0)) / (std[channel] ?? 1)
    }
  }
  return data
}

/**
 * `ImageBitmap` → NCHW float32。按 `size × size` 直接缩放（与 processor 的
 * `do_resize` 同语义：压扁，不裁切）。
 */
export async function toPixelValues(
  bitmap: ImageBitmap,
  size: number = DEFAULT_IMAGE_SIZE,
): Promise<Float32Array> {
  const canvas = new OffscreenCanvas(size, size)
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('OffscreenCanvas 2d context 不可用')
  context.drawImage(bitmap, 0, 0, size, size)
  const { data } = context.getImageData(0, 0, size, size)
  return rgbaToChw(data, size)
}
