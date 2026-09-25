/**
 * 相似图分组 —— 用已存在的视觉向量做贪心聚类（M2 第一项的纯逻辑部分）。
 *
 * 为什么不建新索引：CLIP 视觉向量本身就是「视觉相似度」的度量——两张图余弦越接近 1
 * 越相似。精确重复（同一文件复制/改尺寸）与 burst 连拍在这里天然落进同一组；
 * 相似度是**单模型内**的自相似，不涉及跨模型归因（项目红线）。
 *
 * 算法：**贪心单遍 + 阈值**。从每个未分组的照片出发，把所有与它余弦 ≥ `threshold`
 * 的未分组照片吸进同一组；整组标记已分组，再换下一个未分组的照片做种子重复。
 * 不是全局最优（最优解是 O(n²) 全对比 + 连通分量），但差别只在阈值边界的抖动，
 * 且贪心有一条可解释的保证：**每个成员都与本组种子 ≥ 阈值相似** —— 对用户说话时
 * 「这一组为什么在一起」有明确答案。成本与检索层同款（1 万 × 512 余弦一遍 ≈ 5 MFLOP），
 * 分组不额外算向量。O(n²) 的内对比只发生在组内（组通常很小），全库规模不可怕。
 */

export interface SimilarityGroup {
  /** 组代表 = 与组内其它成员平均相似度最高的照片（展示封面用） */
  readonly representativeId: number
  /** 组内全部照片的 photoId，按与代表的相似度降序（代表是第一个） */
  readonly memberIds: number[]
}

/** 相似度分组的输入：库内照片 + 它们的向量（顺序对应） */
export interface GroupingInput {
  readonly photoIds: readonly number[]
  /** 与 photoIds 一一对应的 L2 归一化向量（来自 `VectorMatrix.snapshot()` 按槽位切出） */
  readonly vectors: readonly Float32Array[]
}

export function groupSimilarPhotos(input: GroupingInput, threshold: number): SimilarityGroup[] {
  if (threshold <= 0 || threshold > 1) {
    throw new Error(`相似度阈值必须在 (0, 1]，实际为 ${String(threshold)}`)
  }
  const { photoIds, vectors } = input
  if (photoIds.length !== vectors.length) {
    throw new Error(
      `photoIds(${String(photoIds.length)}) 与 vectors(${String(vectors.length)}) 数量不一致`,
    )
  }
  const n = photoIds.length
  const assigned = new Array<boolean>(n).fill(false)
  const groups: SimilarityGroup[] = []

  for (let seed = 0; seed < n; seed += 1) {
    if (assigned[seed]) continue
    // 与种子相似度 ≥ 阈值（含种子自身，余弦=1）的全部未分组成员
    const members: number[] = []
    for (let other = seed; other < n; other += 1) {
      if (assigned[other]) continue
      if (cosine(vectors[seed] as Float32Array, vectors[other] as Float32Array) >= threshold) {
        members.push(other)
      }
    }
    for (const member of members) assigned[member] = true

    if (members.length <= 1) {
      groups.push({
        representativeId: photoIds[seed] as number,
        memberIds: [photoIds[seed] as number],
      })
      continue
    }

    // 代表 = 与组内其它成员平均相似度最高者（「拍得最典型」的做封面）
    let bestIndex = seed
    let bestAverage = -1
    for (const candidate of members) {
      let sum = 0
      for (const member of members) {
        if (member !== candidate) {
          sum += cosine(vectors[candidate] as Float32Array, vectors[member] as Float32Array)
        }
      }
      const average = sum / (members.length - 1)
      if (average > bestAverage) {
        bestAverage = average
        bestIndex = candidate
      }
    }

    const ordered = members
      .slice()
      .sort(
        (a, b) =>
          cosine(vectors[bestIndex] as Float32Array, vectors[b] as Float32Array) -
          cosine(vectors[bestIndex] as Float32Array, vectors[a] as Float32Array),
      )
    groups.push({
      representativeId: photoIds[bestIndex] as number,
      memberIds: ordered.map((index) => photoIds[index] as number),
    })
  }
  return groups
}

function cosine(a: Float32Array, b: Float32Array): number {
  // 调用方保证已 L2 归一化（EmbeddingProvider 的不变量），点积即余弦
  let dot = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += (a[index] ?? 0) * (b[index] ?? 0)
  }
  return dot
}
