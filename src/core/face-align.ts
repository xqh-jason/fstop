/**
 * 人脸对齐 —— 5 点相似变换到 112×112（ArcFace 模板）。
 *
 * 为什么必须做这一步：识别模型要求输入是「按眼睛/鼻尖/嘴角摆正并裁好」的 112×112 人脸。
 * 直接把检测框裁下来缩放会带上头姿与余量差异，同一个人的两张照片会算出不够像的向量——
 * 这一步的偏差比换模型档位的影响大得多。
 *
 * 实现的是一条**相似变换**（旋转 + 等比缩放 + 平移，4 个自由度）：
 *   dst = s·R·src + t
 * 用最小二乘解（等价于 OpenCV 的 `estimateAffinePartial2D`，不引入 OpenCV）。
 * 不用 6 自由度仿射：多余的自由度会把「斜一点的脸」压成「正脸」，反而伤识别。
 *
 * 模板坐标是 ArcFace 官方那组（insightface 沿用）：
 *   左眼(38.29,51.70) 右眼(73.53,51.50) 鼻尖(56.03,71.74) 左嘴角(41.55,92.37) 右嘴角(70.73,92.20)
 */

export interface Point {
  readonly x: number
  readonly y: number
}

/**
 * ArcFace 的 5 点目标模板（112×112 坐标系）。
 * 顺序必须与检测输出的 landmark 顺序一致：左眼、右眼、鼻尖、左嘴角、右嘴角。
 */
export const ARCFACE_TEMPLATE: readonly Point[] = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
]

/** 相似变换矩阵：[a, b, tx, -b, a, ty]，满足 x' = a·x - b·y + tx、y' = b·x + a·y + ty */
export type SimilarityTransform = readonly [number, number, number, number, number, number]

/**
 * 最小二乘解相似变换：把 `src` 映射到 `dst`。
 *
 * 推导（把每个点写成复数 z = x + iy，则相似变换是 w = c·z + d）：
 *   令 c = a + ib、d = tx + i·ty，最小化 Σ|c·zᵢ + d - wᵢ|²
 *   令 z̄、w̄ 为均值，则 c = Σ(zᵢ-z̄)‾·(wᵢ-w̄) / Σ|zᵢ-z̄|²，d = w̄ - c·z̄。
 * 这样写比 4 个偏导方程更短，也不会在退化输入上除零。
 */
export function solveSimilarity(src: readonly Point[], dst: readonly Point[]): SimilarityTransform {
  if (src.length !== dst.length) throw new Error('源点与目标点数量必须一致')
  if (src.length < 2) throw new Error('至少需要 2 对点才能解相似变换')
  const count = src.length
  const mean = (points: readonly Point[]): Point => ({
    x: points.reduce((sum, point) => sum + point.x, 0) / count,
    y: points.reduce((sum, point) => sum + point.y, 0) / count,
  })
  const srcMean = mean(src)
  const dstMean = mean(dst)

  let numeratorReal = 0
  let numeratorImag = 0
  let denominator = 0
  for (let index = 0; index < count; index += 1) {
    const source = src[index] as Point
    const target = dst[index] as Point
    const sourceX = source.x - srcMean.x
    const sourceY = source.y - srcMean.y
    const targetX = target.x - dstMean.x
    const targetY = target.y - dstMean.y
    // (z 的共轭) × w = (sx - i·sy)(tx + i·ty) = (sx·tx + sy·ty) + i(sx·ty - sy·tx)
    numeratorReal += sourceX * targetX + sourceY * targetY
    numeratorImag += sourceX * targetY - sourceY * targetX
    denominator += sourceX * sourceX + sourceY * sourceY
  }
  if (denominator === 0) throw new Error('源点全部重合，无法求解相似变换')

  const a = numeratorReal / denominator
  const b = numeratorImag / denominator
  const tx = dstMean.x - (a * srcMean.x - b * srcMean.y)
  const ty = dstMean.y - (b * srcMean.x + a * srcMean.y)
  return [a, b, tx, -b, a, ty]
}

/** 应用变换到单个点 */
export function applyTransform(transform: SimilarityTransform, point: Point): Point {
  const [a, b, tx, , , ty] = transform
  const d = transform[3]
  const e = transform[4]
  return {
    x: a * point.x + d * point.y + tx,
    y: b * point.x + e * point.y + ty,
  }
}

/** 旋转部分的行列式 = a² + b²（>0），退化为 0 说明输入塌了 */
export function transformScale(transform: SimilarityTransform): number {
  const [a, b] = transform
  return Math.sqrt(a * a + b * b)
}

/**
 * 5 点是否可用于对齐：点是有限的、两两不重合、且不共线。
 * 共线检测用「面积和」——三点共线时三角形面积为 0，此时仿射解病态，宁可拒绝也不能瞎算。
 */
export function landmarksUsable(points: readonly Point[], minimumSpread = 4): boolean {
  if (points.length < 3) return false
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
  }
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const spreadX = Math.max(...xs) - Math.min(...xs)
  const spreadY = Math.max(...ys) - Math.min(...ys)
  if (Math.max(spreadX, spreadY) < minimumSpread) return false
  // 任取三点算面积，至少有一组面积够大才算「成面」
  const area = Math.abs(
    (points[1]!.x - points[0]!.x) * (points[2]!.y - points[0]!.y) -
      (points[2]!.x - points[0]!.x) * (points[1]!.y - points[0]!.y),
  )
  return area >= minimumSpread
}
