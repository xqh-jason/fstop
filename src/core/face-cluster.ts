/**
 * 人脸聚类与「合并 / 拆分」（M2 P1）—— 纯逻辑，可单测。
 *
 * 目标体验：「找出我和家人的合照」→ 自动把同一张脸聚成一组，用户给它命名；
 * 聚错了要能**合并两组**、**把某几张脸拆出去**。合并/拆分是必然被抱怨的功能（docs/DESIGN.md §M2），
 * 所以这里不是只做聚类了事。
 *
 * 算法：**全链约束的贪心 + 迭代精化**。
 * 1. 逐条分配：候选簇按质心相似度降序试，**且要求与簇内每个成员都 ≥ 阈值**（全链），
 *    都不满足就开新簇；
 * 2. 精化：把所有项按同一规则重新分配，直到没有成员变动或到轮数上限。
 *
 * 为什么必须是全链而不是「只看质心」（实测踩过的坑）：两张**互不相似**的脸（余弦≈0）
 * 组成的簇，其质心与这两张脸都约 **0.707** 相似 —— 于是阈值 0.45 之下，簇会像雪球一样
 * 把每一个脸都吞进来（「奥巴马和拜登合成一组」就是这么来的）。全链约束把这条路堵死：
 * 新成员必须与簇内**每个**成员都像，中点效应不再成立。
 *
 * 阈值口径：人脸向量（ArcFace 系）同人余弦通常 ≥ 0.5，陌生人 ≤ 0.1；默认取 **0.45**：
 * 宁可多分几组（用户合并一次就行），也不要错把两个人合成一组（用户会以为软件乱认人）。
 */

export interface FaceVector {
  readonly faceId: number
  /** L2 归一化后的人脸向量（识别模型输出必须归一化，否则「余弦」就不是余弦） */
  readonly vector: Float32Array
}

export interface FaceCluster {
  /** 簇内人脸 id，按与质心的相似度降序（第一个最适合做封面） */
  readonly faceIds: number[]
  /** 质心（已归一化），供合并/续聚类复用 */
  readonly centroid: Float32Array
}

export const DEFAULT_FACE_THRESHOLD = 0.45

/** 余弦相似度（输入已归一化则等于点积；这里不假设，避免调用方忘了归一化时静默出错） */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`向量维度不一致：${a.length} vs ${b.length}`)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    dot += left * right
    normA += left * left
    normB += right * right
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function normalizeVector(vector: Float32Array): Float32Array {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  if (norm === 0) throw new Error('人脸向量为零向量：模型输出异常')
  const normalized = new Float32Array(vector.length)
  for (let index = 0; index < vector.length; index += 1)
    normalized[index] = (vector[index] ?? 0) / norm
  return normalized
}

function centroidOf(vectors: readonly Float32Array[]): Float32Array {
  const dimension = (vectors[0] as Float32Array).length
  const sum = new Float32Array(dimension)
  for (const vector of vectors) {
    for (let index = 0; index < dimension; index += 1) {
      sum[index] = (sum[index] ?? 0) + (vector[index] ?? 0)
    }
  }
  return normalizeVector(sum)
}

/**
 * 聚类。返回的簇按大小降序（大簇更像「常出现的人」，用户先看到）。
 * `maxRounds` 是精化的上限：正常几轮就收敛，给上限是为了防抖（两组质心来回抢同一张脸）。
 */
export function clusterFaces(
  faces: readonly FaceVector[],
  threshold: number = DEFAULT_FACE_THRESHOLD,
  maxRounds = 8,
): FaceCluster[] {
  if (threshold <= 0 || threshold > 1) {
    throw new Error(`聚类阈值必须在 (0, 1]，实际为 ${String(threshold)}`)
  }
  if (faces.length === 0) return []

  const vectors = faces.map((face) => normalizeVector(face.vector))
  const ids = faces.map((face) => face.faceId)

  /** 每个簇的成员下标（全链约束要逐个比，不能只看质心） */
  let members: number[][] = []
  const centroids: Float32Array[] = []
  let assignment = new Array<number>(faces.length).fill(-1)

  /** 与簇内每个成员都 ≥ 阈值才允许并入（全链）；空簇恒真 */
  const fitsCluster = (index: number, cluster: number): boolean => {
    const vector = vectors[index] as Float32Array
    for (const member of members[cluster] ?? []) {
      if (member === index) continue
      if (cosineSimilarity(vector, vectors[member] as Float32Array) < threshold) return false
    }
    return true
  }

  /** 按质心相似度降序挑第一个满足全链的簇；都不满足返回 -1 */
  const bestClusterFor = (index: number): number => {
    const vector = vectors[index] as Float32Array
    const order = centroids
      .map((centroid, cluster) => ({ cluster, score: cosineSimilarity(vector, centroid) }))
      .sort((a, b) => b.score - a.score)
    for (const candidate of order) {
      if (candidate.score < threshold) break // 质心都不够像，后面的更不像
      if (fitsCluster(index, candidate.cluster)) return candidate.cluster
    }
    return -1
  }

  const rebuild = (): void => {
    members = centroids.map(() => [])
    for (let index = 0; index < vectors.length; index += 1) {
      ;(members[assignment[index] as number] as number[]).push(index)
    }
    for (let cluster = 0; cluster < centroids.length; cluster += 1) {
      const list = members[cluster] as number[]
      // 空簇：质心置 0（相似度恒 0 < 阈值），不重排索引
      centroids[cluster] =
        list.length === 0
          ? new Float32Array((vectors[0] as Float32Array).length)
          : centroidOf(list.map((index) => vectors[index] as Float32Array))
    }
  }

  // ——— 1. 贪心建簇 ———
  for (let index = 0; index < vectors.length; index += 1) {
    const cluster = bestClusterFor(index)
    if (cluster === -1) {
      centroids.push((vectors[index] as Float32Array).slice())
      members.push([index])
      assignment[index] = centroids.length - 1
    } else {
      assignment[index] = cluster
      ;(members[cluster] as number[]).push(index)
      centroids[cluster] = centroidOf(
        (members[cluster] as number[]).map((i) => vectors[i] as Float32Array),
      )
    }
  }

  // ——— 2. 迭代精化（消掉输入顺序依赖）———
  for (let round = 0; round < maxRounds; round += 1) {
    const next = assignment.slice()
    let changed = false
    for (let index = 0; index < vectors.length; index += 1) {
      // 找目标簇时先把自己从成员表里摘掉：否则「与每个成员都像」会拿自己跟自己比（恒真），
      // 而且原簇质心也把自己算了进去
      const current = next[index] as number
      const saved = members
      members = members.map((list) => list.filter((member) => member !== index))
      const target = bestClusterFor(index)
      members = saved
      if (target !== -1 && target !== current) {
        next[index] = target
        changed = true
      }
    }
    assignment = next
    rebuild()
    if (!changed) break
  }

  // ——— 3. 收尾：丢掉空簇、按与质心相似度排成员、按大小降序排簇 ———
  const clusters: FaceCluster[] = []
  for (let cluster = 0; cluster < centroids.length; cluster += 1) {
    const list = (members[cluster] ?? []).slice().sort((a, b) => a - b)
    if (list.length === 0) continue
    const centroid = centroidOf(list.map((index) => vectors[index] as Float32Array))
    const ordered = list
      .map((index) => ({
        faceId: ids[index] as number,
        score: cosineSimilarity(vectors[index] as Float32Array, centroid),
      }))
      .sort((a, b) => b.score - a.score)
      .map((item) => item.faceId)
    clusters.push({ faceIds: ordered, centroid })
  }
  return clusters.sort((a, b) => b.faceIds.length - a.faceIds.length)
}

/**
 * 合并两组：返回合并后的成员与质心。
 * 界面上「把这两个人合成一个人」就该是这一步 —— 只是重算质心，不重新跑聚类。
 */
export function mergeClusters(
  left: { readonly faceIds: readonly number[]; readonly centroid: Float32Array },
  right: { readonly faceIds: readonly number[]; readonly centroid: Float32Array },
): FaceCluster {
  const totalLeft = left.faceIds.length
  const totalRight = right.faceIds.length
  if (totalLeft === 0) return { faceIds: [...right.faceIds], centroid: right.centroid.slice() }
  if (totalRight === 0) return { faceIds: [...left.faceIds], centroid: left.centroid.slice() }
  // 质心按成员数加权再归一化（不能把两个质心简单平均：人脸数不同的两组权重不同）
  const dimension = left.centroid.length
  const blended = new Float32Array(dimension)
  for (let index = 0; index < dimension; index += 1) {
    blended[index] =
      ((left.centroid[index] ?? 0) * totalLeft + (right.centroid[index] ?? 0) * totalRight) /
      (totalLeft + totalRight)
  }
  return {
    faceIds: [...left.faceIds, ...right.faceIds],
    centroid: normalizeVector(blended),
  }
}

/**
 * 拆分：把 `moveFaceIds` 从原来的簇里拿出来，重新聚类。
 * 语义上「拆出去的那几张」是不是还要细分成几组由调用方决定 —— 这里如实返回数组，
 * 不假装知道用户想要几组。
 */
export function splitCluster(
  cluster: { readonly faceIds: readonly number[]; readonly centroid: Float32Array },
  moveFaceIds: readonly number[],
  vectors: ReadonlyMap<number, Float32Array>,
  threshold: number = DEFAULT_FACE_THRESHOLD,
): { remaining: FaceCluster | null; moved: FaceCluster[] } {
  const moveSet = new Set(moveFaceIds)
  const remainingIds = cluster.faceIds.filter((id) => !moveSet.has(id))
  const movedIds = cluster.faceIds.filter((id) => moveSet.has(id))
  if (movedIds.length === 0) {
    return { remaining: clusterWithCentroid(cluster.faceIds, vectors, cluster.centroid), moved: [] }
  }
  return {
    remaining: remainingIds.length === 0 ? null : clusterWithCentroid(remainingIds, vectors, null),
    moved: clusterFaces(
      movedIds.map((faceId) => ({ faceId, vector: requireVector(vectors, faceId) })),
      threshold,
    ),
  }
}

function requireVector(vectors: ReadonlyMap<number, Float32Array>, faceId: number): Float32Array {
  const vector = vectors.get(faceId)
  if (vector === undefined) throw new Error(`缺少人脸 ${String(faceId)} 的向量`)
  return vector
}

function clusterWithCentroid(
  faceIds: readonly number[],
  vectors: ReadonlyMap<number, Float32Array>,
  centroid: Float32Array | null,
): FaceCluster {
  if (centroid !== null) return { faceIds: [...faceIds], centroid: centroid.slice() }
  return {
    faceIds: [...faceIds],
    centroid: centroidOf(faceIds.map((faceId) => requireVector(vectors, faceId))),
  }
}
