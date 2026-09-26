/**
 * 人脸链探针（基准页）—— 定位「检不出脸」到底是预处理、模型还是后处理的问题。
 *
 * 做法：拿同一张真人肖像，对**若干种预处理变体**各跑一次检测，打印每档 stride 的
 * 最大分数。哪种变体能把分数顶起来，哪种就是模型期望的输入口径 —— 比照文档猜可靠。
 *
 * 用法：先起 dev server，再 `node bench/face-probe.mjs`（PROBE_MODE=sweep|chain）
 */
import { FACE_DETECTOR, FACE_RECOGNIZER } from '../src/storage/models'
import { anchorCenters, decodeDetections } from '../src/core/face-detect'
import { detectorInput, FACE_DECODE_SIDE } from '../src/workers/face-preprocess'
import { decodePhoto, DEFAULT_DECODE_OPTIONS } from '../src/workers/decode'
import { loadOrt, type OrtSession } from '../src/workers/ort-runtime'

const out = document.querySelector('#out') as HTMLPreElement
const lines: string[] = []
function log(message: string): void {
  lines.push(message)
  out.textContent = lines.join('\n')
  console.log(message)
}

const params = new URLSearchParams(location.search)
const MODE = params.get('mode') ?? 'sweep'
const IMAGE = params.get('image') ?? 'obama-01.jpg'
const SIZE = FACE_DETECTOR.inputSize

/** 人脸的语料清单（文件名前缀 = 人物标签），pairwise 模式用 */
const CORPUS = [
  'obama-01.jpg',
  'obama-02.jpg',
  'obama-03.jpg',
  'obama-04.png',
  'biden-01.jpg',
  'biden-02.jpg',
  'biden-03.jpg',
]

async function loadImage(name: string): Promise<ImageBitmap> {
  const response = await fetch(`/bench/corpus-faces/${encodeURIComponent(name)}`)
  if (!response.ok) throw new Error(`语料取不到：${name}（${response.status}）`)
  return createImageBitmap(await response.blob())
}

/** 把位图等比缩放贴到 SIZE² 左上角，返回 RGBA（变体之间只差归一化，缩放口径完全一致） */
function letterboxRgba(bitmap: ImageBitmap): Uint8ClampedArray {
  const { box } = detectorInput(bitmap, SIZE)
  const canvas = new OffscreenCanvas(SIZE, SIZE)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new Error('OffscreenCanvas 不可用')
  context.clearRect(0, 0, SIZE, SIZE)
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, box.contentWidth, box.contentHeight)
  return context.getImageData(0, 0, SIZE, SIZE).data
}

type Variant = {
  name: string
  /** 像素 → 张量值 */
  value: (channel: number) => number
  /** 通道顺序 */
  order: 'rgb' | 'bgr'
}

const VARIANTS: Variant[] = [
  { name: '(v-127.5)/127.5 RGB', value: (v) => (v - 127.5) / 127.5, order: 'rgb' },
  { name: '(v-127.5)/128 RGB', value: (v) => (v - 127.5) / 128, order: 'rgb' },
  { name: 'v/255 RGB', value: (v) => v / 255, order: 'rgb' },
  { name: 'v/128 RGB', value: (v) => v / 128, order: 'rgb' },
  { name: 'v RGB（0..255）', value: (v) => v, order: 'rgb' },
  { name: '(v-127.5)/127.5 BGR', value: (v) => (v - 127.5) / 127.5, order: 'bgr' },
  { name: '(v-127.5)/128 BGR', value: (v) => (v - 127.5) / 128, order: 'bgr' },
]

function toChw(rgba: Uint8ClampedArray, variant: Variant): Float32Array {
  const area = SIZE * SIZE
  const data = new Float32Array(3 * area)
  for (let index = 0; index < area; index += 1) {
    const r = rgba[index * 4] ?? 0
    const g = rgba[index * 4 + 1] ?? 0
    const b = rgba[index * 4 + 2] ?? 0
    const channels = variant.order === 'rgb' ? [r, g, b] : [b, g, r]
    for (let channel = 0; channel < 3; channel += 1) {
      data[channel * area + index] = variant.value(channels[channel] as number)
    }
  }
  return data
}

function scoreStats(values: Float32Array): { max: number; over: number } {
  let max = -Infinity
  let over = 0
  for (const value of values) {
    if (value > max) max = value
    if (value > 0.5) over += 1
  }
  return { max, over }
}

async function sweep(
  detector: OrtSession,
  ort: Awaited<ReturnType<typeof loadOrt>>,
  bitmap: ImageBitmap,
): Promise<void> {
  const rgba = letterboxRgba(bitmap)
  log(
    `图片 ${IMAGE} ${String(bitmap.width)}×${String(bitmap.height)}（等比贴到 ${String(SIZE)}² 左上角）`,
  )
  log('变体扫描（看哪一档能把分数顶起来）：')
  for (const variant of VARIANTS) {
    const tensor = toChw(rgba, variant)
    const started = performance.now()
    const outputs = await detector.run({
      'input.1': new ort.Tensor('float32', tensor, [1, 3, SIZE, SIZE]),
    })
    const parts: string[] = []
    for (const stride of FACE_DETECTOR.strides) {
      const scores = outputs[`score_${String(stride)}`]?.data
      if (scores === undefined) {
        parts.push(`s${String(stride)}=缺失`)
        continue
      }
      const { max, over } = scoreStats(scores)
      parts.push(`s${String(stride)} max=${max.toFixed(4)} (>0.5:${String(over)})`)
    }
    log(
      `  ${variant.name.padEnd(22)} ${parts.join('  ')}  ${Math.round(performance.now() - started)} ms`,
    )
  }
}

async function chain(
  detector: OrtSession,
  ort: Awaited<ReturnType<typeof loadOrt>>,
  bitmap: ImageBitmap,
): Promise<void> {
  const { tensor, box } = detectorInput(bitmap, SIZE)
  const outputs = await detector.run({
    'input.1': new ort.Tensor('float32', tensor, [1, 3, SIZE, SIZE]),
  })
  log(
    `anchor 期望：${FACE_DETECTOR.strides.map((s) => `${String(s)}→${String(anchorCenters(s, SIZE, FACE_DETECTOR.anchorsPerLocation).length)}`).join(' ')}`,
  )
  const detections = decodeDetections(
    {
      imageWidth: bitmap.width,
      imageHeight: bitmap.height,
      strides: FACE_DETECTOR.strides,
      scores: FACE_DETECTOR.strides.map(
        (s) => outputs[`score_${String(s)}`]?.data ?? new Float32Array(0),
      ),
      boxes: FACE_DETECTOR.strides.map(
        (s) => outputs[`bbox_${String(s)}`]?.data ?? new Float32Array(0),
      ),
      keypoints: FACE_DETECTOR.strides.map(
        (s) => outputs[`kps_${String(s)}`]?.data ?? new Float32Array(0),
      ),
    },
    box,
    { scoreThreshold: FACE_DETECTOR.scoreThreshold, iouThreshold: FACE_DETECTOR.iouThreshold },
  )
  log(`解码后：${String(detections.length)} 张脸`)
  for (const face of detections) {
    log(
      `  框 (${face.box.x1.toFixed(0)},${face.box.y1.toFixed(0)})-(${face.box.x2.toFixed(0)},${face.box.y2.toFixed(0)}) 分数 ${face.score.toFixed(3)}`,
    )
  }
}

/**
 * pairwise：把语料里每张照片的人脸向量算出来，打印**带人物标签的两两余弦矩阵**。
 *
 * 为什么需要它：聚类阈值不能靠猜。只有看到「同人余弦」与「异人余弦」的实际分布，
 * 才知道阈值该落在哪里——以及这批语料本身是否可分（同一批官方肖像照里，
 * 不同人的余弦可能高到跟同人重叠，那就是语料太难的信号，不是算法的错）。
 */
async function pairwise(ort: Awaited<ReturnType<typeof loadOrt>>): Promise<void> {
  const detector = await ort.InferenceSession.create(FACE_DETECTOR.url, {
    executionProviders: ['webgpu'],
  })
  const recognizer = await ort.InferenceSession.create(FACE_RECOGNIZER.url, {
    executionProviders: ['webgpu'],
  })
  const { alignedInput } = await import('../src/workers/face-preprocess')

  const samples: {
    file: string
    person: string
    vector: Float32Array
    score: number
    x1: number
    y1: number
    x2: number
    y2: number
  }[] = []
  for (const file of CORPUS) {
    // 与流水线同一条解码路径（含人脸链自己的 embedSide），否则矩阵数字描述不了产品行为
    const response = await fetch(`/bench/corpus-faces/${encodeURIComponent(file)}`)
    const decoded = await decodePhoto(await response.blob(), {
      ...DEFAULT_DECODE_OPTIONS,
      embedSide: FACE_DECODE_SIDE,
    })
    const bitmap = decoded.bitmap
    const { tensor, box } = detectorInput(bitmap, SIZE)
    const outputs = await detector.run({
      'input.1': new ort.Tensor('float32', tensor, [1, 3, SIZE, SIZE]),
    })
    const detections = decodeDetections(
      {
        imageWidth: bitmap.width,
        imageHeight: bitmap.height,
        strides: FACE_DETECTOR.strides,
        scores: FACE_DETECTOR.strides.map(
          (s) => outputs[`score_${String(s)}`]?.data ?? new Float32Array(0),
        ),
        boxes: FACE_DETECTOR.strides.map(
          (s) => outputs[`bbox_${String(s)}`]?.data ?? new Float32Array(0),
        ),
        keypoints: FACE_DETECTOR.strides.map(
          (s) => outputs[`kps_${String(s)}`]?.data ?? new Float32Array(0),
        ),
      },
      box,
      { scoreThreshold: FACE_DETECTOR.scoreThreshold, iouThreshold: FACE_DETECTOR.iouThreshold },
    )
    // 与流水线一致：**每一张检出的脸都收**（产品把全部人脸写库，不是只取最高分那张）
    log(`${file}：检出 ${String(detections.length)} 张脸`)
    for (const detection of detections) {
      const input = alignedInput(bitmap, detection.landmarks, FACE_RECOGNIZER.inputSize)
      const result = await recognizer.run({
        'input.1': new ort.Tensor('float32', input, [
          1,
          3,
          FACE_RECOGNIZER.inputSize,
          FACE_RECOGNIZER.inputSize,
        ]),
      })
      const raw = Object.values(result)[0]?.data
      if (raw === undefined) continue
      let norm = 0
      for (const value of raw) norm += value * value
      const vector = new Float32Array(raw.length)
      for (let index = 0; index < raw.length; index += 1)
        vector[index] = (raw[index] ?? 0) / Math.sqrt(norm)
      samples.push({
        file,
        person: file.split('-')[0] as string,
        vector,
        score: detection.score,
        x1: detection.box.x1,
        y1: detection.box.y1,
        x2: detection.box.x2,
        y2: detection.box.y2,
      })
    }
  }

  const cosine = (a: Float32Array, b: Float32Array): number => {
    let dot = 0
    for (let index = 0; index < a.length; index += 1) dot += (a[index] ?? 0) * (b[index] ?? 0)
    return dot
  }

  log(`样本 ${String(samples.length)} 张：`)
  for (const [index, sample] of samples.entries()) {
    log(
      `  [${String(index)}] ${sample.file.padEnd(14)} ${sample.person.padEnd(6)} 检测分 ${sample.score.toFixed(3)} 框 ${String(Math.round(sample.x1))},${String(Math.round(sample.y1))}-${String(Math.round(sample.x2))},${String(Math.round(sample.y2))}`,
    )
  }
  log('\n余弦矩阵（行=列，同人应高、异人应低）：')
  log(`      ${samples.map((_, index) => String(index).padStart(6)).join('')}`)
  for (let row = 0; row < samples.length; row += 1) {
    const cells = samples.map((_, column) =>
      cosine(samples[row]!.vector, samples[column]!.vector).toFixed(3).padStart(6),
    )
    log(`  [${String(row)}] ${cells.join('')}  ${samples[row]!.person}`)
  }

  const same: number[] = []
  const cross: number[] = []
  for (let row = 0; row < samples.length; row += 1) {
    for (let column = row + 1; column < samples.length; column += 1) {
      const value = cosine(samples[row]!.vector, samples[column]!.vector)
      if (samples[row]!.person === samples[column]!.person) same.push(value)
      else cross.push(value)
    }
  }
  const describe = (values: number[]): string => {
    if (values.length === 0) return '（无）'
    const sorted = values.slice().sort((a, b) => a - b)
    return `n=${String(values.length)} min=${sorted[0]!.toFixed(3)} 中位=${sorted[Math.floor(sorted.length / 2)]!.toFixed(3)} max=${sorted[sorted.length - 1]!.toFixed(3)}`
  }
  log(`\n同人余弦：${describe(same)}`)
  log(`异人余弦：${describe(cross)}`)
  const sameMin = same.length > 0 ? Math.min(...same) : 0
  const crossMax = cross.length > 0 ? Math.max(...cross) : 0
  log(
    sameMin > crossMax
      ? `可分：同人最小 ${sameMin.toFixed(3)} > 异人最大 ${crossMax.toFixed(3)}，阈值取两者之间即可`
      : `**不可分**：同人最小 ${sameMin.toFixed(3)} ≤ 异人最大 ${crossMax.toFixed(3)}（这批语料里不同人的脸比同人还像）`,
  )

  // 用**产品自己的**聚类函数在探针数据上跑一遍：能复现出「混人」的组，说明问题在向量；
  // 复现不出来，说明问题在产品那条数据通路（写库/读矩阵的对应关系）
  const { clusterFaces, DEFAULT_FACE_THRESHOLD } = await import('../src/core/face-cluster')
  const clusters = clusterFaces(
    samples.map((sample, index) => ({ faceId: index, vector: sample.vector })),
    DEFAULT_FACE_THRESHOLD,
  )
  log(`\n产品聚类函数（阈值 ${DEFAULT_FACE_THRESHOLD}）在探针数据上的分组：`)
  for (const cluster of clusters) {
    const members = cluster.faceIds.map((id) => {
      const sample = samples[id]!
      return `${sample.file}[${sample.person}]`
    })
    const persons = [...new Set(cluster.faceIds.map((id) => samples[id]!.person))]
    log(
      `  ${String(cluster.faceIds.length)} 张：${members.join(' ')}${persons.length > 1 ? '  ← 混人' : ''}`,
    )
  }
}

async function main(): Promise<void> {
  log(`探针开始（mode=${MODE} image=${IMAGE}）`)
  const ort = await loadOrt()
  if (MODE === 'pairwise') {
    await pairwise(ort)
    document.body.dataset.probe = 'done'
    return
  }
  const bitmap = await loadImage(IMAGE)
  const started = performance.now()
  const detector = await ort.InferenceSession.create(FACE_DETECTOR.url, {
    executionProviders: ['webgpu'],
  })
  log(`检测会话就绪：${Math.round(performance.now() - started)} ms`)
  if (MODE === 'chain') await chain(detector, ort, bitmap)
  else await sweep(detector, ort, bitmap)
  document.body.dataset.probe = 'done'
}

main().catch((error: unknown) => {
  log(
    `探针异常：${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}`,
  )
  document.body.dataset.probe = 'failed'
})
