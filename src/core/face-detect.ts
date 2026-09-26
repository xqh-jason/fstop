/**
 * 人脸检测后处理（SCRFD 系）—— 纯函数，可单测。
 *
 * 模型规格（实测 `immich-app/scrfd_34g_gnkps/detection/model.onnx`，本地用 `bench/face-model-probe.py` 读出）：
 * - 输入 `input.1` `[1,3,640,640]` float32
 * - 输出三档 stride 各一组：`score_{8,16,32}` `[N,1]`、`bbox_{8,16,32}` `[N,4]`、`kps_{8,16,32}` `[N,10]`
 *   N = (640/stride)² × **2 anchors**（12800 / 3200 / 800 —— 2 个 anchor 是 34g 这档的数量）
 * - `bbox` 是**到 anchor 中心的距离**（ltrb，未乘 stride），`kps` 是 5 个点的 (dx,dy)
 *
 * 为什么这些放在 `src/core/`：它们是纯数学（anchor 网格、距离解码、NMS、坐标还原），
 * 一旦写进 Worker 就只能靠真浏览器验证；放这里有单测钉住，Worker 只管喂张量。
 */

export interface Letterbox {
  /** 输入像素 → 原图坐标的换算比例（`原图 = 输入 / scale`） */
  readonly scale: number
  /** 缩放后左上角贴到 (0,0)，这里的 pad 恒为 0；保留字段是为了让坐标换算函数通用 */
  readonly padX: number
  readonly padY: number
  /** 送进网络的方形边长（640） */
  readonly inputSize: number
  /** 缩放后真实内容尺寸（未 pad 的部分） */
  readonly contentWidth: number
  readonly contentHeight: number
}

export interface FaceBox {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

export interface FaceDetection {
  readonly box: FaceBox
  readonly score: number
  /** 5 个关键点（原图坐标），顺序：左眼、右眼、鼻尖、左嘴角、右嘴角（insightface 约定） */
  readonly landmarks: readonly { x: number; y: number }[]
}

export interface DetectionInput {
  readonly imageWidth: number
  readonly imageHeight: number
  /** 各 stride 的原始输出 */
  readonly strides: readonly number[]
  readonly scores: readonly Float32Array[]
  readonly boxes: readonly Float32Array[]
  readonly keypoints: readonly Float32Array[]
}

/** 1. 等比缩放到方形输入（不 pad 内容，左上对齐）—— 与 insightface 的 det_scale 口径一致 */
export function letterbox(imageWidth: number, imageHeight: number, inputSize: number): Letterbox {
  if (imageWidth <= 0 || imageHeight <= 0) throw new Error('图像尺寸必须为正')
  const scale = Math.min(inputSize / imageWidth, inputSize / imageHeight)
  return {
    scale,
    padX: 0,
    padY: 0,
    inputSize,
    contentWidth: Math.max(1, Math.round(imageWidth * scale)),
    contentHeight: Math.max(1, Math.round(imageHeight * scale)),
  }
}

/** 输入侧坐标 → 原图坐标 */
export function toOriginal(value: number, scale: number, pad: number): number {
  return (value - pad) / scale
}

/** anchor 中心网格：每个位置 `anchorsPerLocation` 个 anchor，先按 y 后按 x（行优先） */
export function anchorCenters(
  stride: number,
  inputSize: number,
  anchorsPerLocation: number,
): { x: number; y: number }[] {
  const side = Math.floor(inputSize / stride)
  const centers: { x: number; y: number }[] = []
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      for (let anchor = 0; anchor < anchorsPerLocation; anchor += 1) {
        centers.push({ x: column * stride, y: row * stride })
      }
    }
  }
  return centers
}

/**
 * 解码：把三档 stride 的输出变成原图坐标下的检测框 + 关键点，再做 NMS。
 * 距离是 anchor 相对值，**必须乘 stride** 才是输入像素（漏乘会得到一堆挤在左上角的小框）。
 */
export function decodeDetections(
  input: DetectionInput,
  box: Letterbox,
  options: { scoreThreshold: number; iouThreshold: number; anchorsPerLocation?: number },
): FaceDetection[] {
  const anchorsPerLocation = options.anchorsPerLocation ?? 2
  const candidates: FaceDetection[] = []

  for (let level = 0; level < input.strides.length; level += 1) {
    const stride = input.strides[level] as number
    const scores = input.scores[level]
    const distances = input.boxes[level]
    const keypoints = input.keypoints[level]
    if (scores === undefined || distances === undefined) continue
    const centers = anchorCenters(stride, box.inputSize, anchorsPerLocation)
    const count = Math.min(scores.length, centers.length)

    for (let index = 0; index < count; index += 1) {
      const score = scores[index] ?? 0
      if (score < options.scoreThreshold) continue
      const center = centers[index] as { x: number; y: number }
      const base = index * 4
      const left = (distances[base] ?? 0) * stride
      const top = (distances[base + 1] ?? 0) * stride
      const right = (distances[base + 2] ?? 0) * stride
      const bottom = (distances[base + 3] ?? 0) * stride
      const toX = (value: number): number => toOriginal(value, box.scale, box.padX)
      const toY = (value: number): number => toOriginal(value, box.scale, box.padY)
      const landmarks: { x: number; y: number }[] = []
      if (keypoints !== undefined) {
        const keypointBase = index * 10
        for (let point = 0; point < 5; point += 1) {
          landmarks.push({
            x: toX(center.x + (keypoints[keypointBase + point * 2] ?? 0) * stride),
            y: toY(center.y + (keypoints[keypointBase + point * 2 + 1] ?? 0) * stride),
          })
        }
      }
      candidates.push({
        box: {
          x1: toX(center.x - left),
          y1: toY(center.y - top),
          x2: toX(center.x + right),
          y2: toY(center.y + bottom),
        },
        score,
        landmarks,
      })
    }
  }

  return nms(candidates, options.iouThreshold)
}

/** 面积（负宽高按 0 处理，避免脏框把 IoU 算成负数） */
export function area(box: FaceBox): number {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1)
}

export function iou(a: FaceBox, b: FaceBox): number {
  const left = Math.max(a.x1, b.x1)
  const top = Math.max(a.y1, b.y1)
  const right = Math.min(a.x2, b.x2)
  const bottom = Math.min(a.y2, b.y2)
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
  if (intersection === 0) return 0
  const union = area(a) + area(b) - intersection
  return union <= 0 ? 0 : intersection / union
}

/** 贪心 NMS：分数降序保留，抑制与已保留框 IoU 超阈值的候选 */
export function nms(detections: readonly FaceDetection[], iouThreshold: number): FaceDetection[] {
  const sorted = detections.slice().sort((a, b) => b.score - a.score)
  const kept: FaceDetection[] = []
  for (const candidate of sorted) {
    if (kept.some((existing) => iou(existing.box, candidate.box) > iouThreshold)) continue
    kept.push(candidate)
  }
  return kept
}

/** 裁掉越界部分并向下取整到像素（喂给画布用；宽高不足 1 像素的丢弃） */
export function clampToImage(
  box: FaceBox,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; width: number; height: number } | null {
  const x1 = Math.max(0, Math.floor(box.x1))
  const y1 = Math.max(0, Math.floor(box.y1))
  const x2 = Math.min(imageWidth, Math.ceil(box.x2))
  const y2 = Math.min(imageHeight, Math.ceil(box.y2))
  const width = x2 - x1
  const height = y2 - y1
  if (width < 1 || height < 1) return null
  return { x: x1, y: y1, width, height }
}
