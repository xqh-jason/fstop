/**
 * 确定性合成语料 —— 项目计划 §九 M0 交付物 1。
 *
 * 为什么必须是合成的：开源项目发布的性能数字必须可复现，而私人照片库无法公开。
 * 任何人 `pnpm bench` 都应得到同一批语料，从而得到可比较的 photos/s。
 *
 * 确定性边界（必须说清，否则「可复现」是假话）：
 * - 像素内容由 `seed` 完全决定，分辨率序列也固定；
 * - **JPEG 字节由浏览器编码器产出**，不同浏览器/版本的字节数会有差异，
 *   因此基准结果必须同时记录浏览器版本，跨浏览器对比要看 photos/s 而不是字节数。
 *
 * 分辨率构成刻意贴近真实相机与手机：12 MP 是基准，另有 24 MP 与低分辨率档，
 * 因为解码耗时几乎只由像素数决定（§八 的 60 ms/张预算就是按 12 MP 拆的）。
 */

export interface CorpusVariant {
  readonly width: number
  readonly height: number
  /** 该档在语料中的占比，全部档位之和为 1 */
  readonly share: number
}

export interface CorpusSpec {
  readonly count: number
  readonly seed: number
  readonly variants: readonly CorpusVariant[]
  /** JPEG 质量。过高会把合成噪声压成巨大文件，偏离真实相机 JPEG */
  readonly quality: number
}

export const DEFAULT_CORPUS: CorpusSpec = {
  count: 1000,
  seed: 20260923,
  variants: [
    { width: 4032, height: 3024, share: 0.6 }, // 12 MP，手机主力
    { width: 4000, height: 3000, share: 0.2 }, // 12 MP，相机主力
    { width: 6000, height: 4000, share: 0.1 }, // 24 MP
    { width: 2048, height: 1536, share: 0.05 }, // 3 MP，旧图
    { width: 800, height: 600, share: 0.05 }, // 缩略图级
  ],
  quality: 0.85,
}

/** mulberry32：小、快、可播种，跨实现确定 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function pickVariant(spec: CorpusSpec, random: () => number): CorpusVariant {
  const roll = random()
  let cumulative = 0
  for (const variant of spec.variants) {
    cumulative += variant.share
    if (roll <= cumulative) return variant
  }
  return spec.variants[spec.variants.length - 1]
}

/**
 * 画一张「像照片」的图：低频色块 + 结构线条 + 少量噪声。
 * 刻意不做纯噪声：纯噪声在 q=0.85 下会产出远超真实照片的字节数，把基准带偏。
 */
function paint(canvas: OffscreenCanvas, random: () => number): void {
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('OffscreenCanvas 2d context 不可用')
  const { width, height } = canvas

  const hue = Math.floor(random() * 360)
  const gradient = context.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, `hsl(${hue} 45% 62%)`)
  gradient.addColorStop(1, `hsl(${(hue + 60) % 360} 40% 22%)`)
  context.fillStyle = gradient
  context.fillRect(0, 0, width, height)

  context.globalAlpha = 0.55
  const shapes = 24 + Math.floor(random() * 40)
  for (let index = 0; index < shapes; index += 1) {
    const shapeHue = (hue + Math.floor(random() * 120) - 60 + 360) % 360
    context.fillStyle = `hsl(${shapeHue} ${20 + random() * 60}% ${10 + random() * 70}%)`
    const size = (0.02 + random() * 0.12) * Math.min(width, height)
    const x = random() * width
    const y = random() * height
    if (random() < 0.5) {
      context.beginPath()
      context.arc(x, y, size / 2, 0, Math.PI * 2)
      context.fill()
    } else {
      context.save()
      context.translate(x, y)
      context.rotate(random() * Math.PI)
      context.fillRect(-size / 2, -size / 6, size, size / 3)
      context.restore()
    }
  }

  // 少量高频细节：模拟树叶/织物，但面积小到不会把文件撑爆
  const noise = context.getImageData(0, 0, Math.min(width, 512), Math.min(height, 512))
  for (let index = 0; index < noise.data.length; index += 4) {
    const delta = (random() - 0.5) * 24
    noise.data[index] = Math.max(0, Math.min(255, (noise.data[index] ?? 0) + delta))
    noise.data[index + 1] = Math.max(0, Math.min(255, (noise.data[index + 1] ?? 0) + delta))
    noise.data[index + 2] = Math.max(0, Math.min(255, (noise.data[index + 2] ?? 0) + delta))
  }
  context.putImageData(noise, 0, 0)
  context.globalAlpha = 1
}

export interface CorpusFile {
  readonly name: string
  readonly blob: Blob
  readonly width: number
  readonly height: number
}

/** 语料落到哪里；浏览器里是 OPFS，Node 里可以是内存或用例收集器 */
export interface CorpusSink {
  write(file: CorpusFile): Promise<void>
}

/**
 * 逐张生成并交给 sink。返回统计信息而非所有字节——1000 张 12 MP 的字节量不能留在内存里。
 */
export async function generateCorpus(
  sink: CorpusSink,
  spec: CorpusSpec = DEFAULT_CORPUS,
  onProgress?: (done: number, total: number) => void,
): Promise<{ count: number; bytes: number; milliseconds: number }> {
  const random = createRandom(spec.seed)
  const started = performance.now()
  let bytes = 0

  for (let index = 0; index < spec.count; index += 1) {
    const variant = pickVariant(spec, random)
    const canvas = new OffscreenCanvas(variant.width, variant.height)
    paint(canvas, random)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: spec.quality })
    bytes += blob.size
    await sink.write({
      name: `IMG_${String(index).padStart(5, '0')}.jpg`,
      blob,
      width: variant.width,
      height: variant.height,
    })
    onProgress?.(index + 1, spec.count)
  }

  return { count: spec.count, bytes, milliseconds: performance.now() - started }
}
