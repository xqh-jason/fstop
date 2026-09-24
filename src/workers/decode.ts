/**
 * 解码路径：原图字节 → （EXIF 方向已应用的）缩略图 + 供推理使用的位图 + 原始尺寸。
 *
 * 三条与计划直接相关的约定：
 * 1. **EXIF 方向必须在生成缩略图与向量之前应用**（§7.6 第 4 条），否则两者都是错的：
 *    这里靠 `imageOrientation: 'from-image'` 在解码阶段就摆正。
 * 2. `width` / `height` 是**原图尺寸**（进 `photos` 表），不是降采样后的尺寸——
 *    因此先整帧解码一次再降采样，而不是用 `resizeWidth`（那样会把原尺寸丢掉）。
 * 3. 位图是稀缺资源：调用方拿到 `DecodedPhoto` 后必须 `close()`（`decodePhoto` 内部
 *    已经在返回前关掉了整帧位图），否则 1.5 GB 内存红线必失守（§八）。
 */

export interface DecodeOptions {
  /** 供 CLIP 用的最长边。CLIP 输入是 224，这里留出余量即可 */
  readonly embedSide: number
  /** 缩略图最长边 */
  readonly thumbSide: number
  readonly thumbQuality: number
}

export const DEFAULT_DECODE_OPTIONS: DecodeOptions = {
  embedSide: 512,
  thumbSide: 320,
  thumbQuality: 0.8,
}

export interface DecodedPhoto {
  /** 已摆正、已降采样，可直接喂给 `EmbeddingProvider.embedImage` */
  readonly bitmap: ImageBitmap
  readonly thumb: Blob
  /** 原图尺寸（已按 EXIF 方向纠正） */
  readonly width: number
  readonly height: number
}

function scaledSize(width: number, height: number, longestSide: number): [number, number] {
  const scale = Math.min(1, longestSide / Math.max(width, height))
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))]
}

export async function decodePhoto(
  blob: Blob,
  options: DecodeOptions = DEFAULT_DECODE_OPTIONS,
): Promise<DecodedPhoto> {
  const full = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  try {
    const width = full.width
    const height = full.height

    const [embedWidth, embedHeight] = scaledSize(width, height, options.embedSide)
    const embedCanvas = new OffscreenCanvas(embedWidth, embedHeight)
    const embedContext = embedCanvas.getContext('2d')
    if (embedContext === null) throw new Error('OffscreenCanvas 2d context 不可用')
    embedContext.drawImage(full, 0, 0, embedWidth, embedHeight)
    const bitmap = embedCanvas.transferToImageBitmap()

    const [thumbWidth, thumbHeight] = scaledSize(width, height, options.thumbSide)
    const thumbCanvas = new OffscreenCanvas(thumbWidth, thumbHeight)
    const thumbContext = thumbCanvas.getContext('2d')
    if (thumbContext === null) throw new Error('OffscreenCanvas 2d context 不可用')
    thumbContext.drawImage(full, 0, 0, thumbWidth, thumbHeight)
    const thumb = await thumbCanvas.convertToBlob({
      type: 'image/jpeg',
      quality: options.thumbQuality,
    })

    return { bitmap, thumb, width, height }
  } finally {
    full.close()
  }
}
