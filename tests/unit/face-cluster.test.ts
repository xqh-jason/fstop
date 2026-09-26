import { describe, expect, it } from 'vitest'
import {
  clusterFaces,
  cosineSimilarity,
  DEFAULT_FACE_THRESHOLD,
  mergeClusters,
  normalizeVector,
  splitCluster,
  type FaceVector,
} from '../../src/core/face-cluster'

/**
 * 造一个 512 维单位向量：`base` 决定「是谁」，`jitter` 决定「这张照片抖多少」。
 *
 * 噪声用哈希式伪随机而不是 `sin(index * 1.7 + faceId)`：后者在 faceId 只差几的时候
 * 相位几乎对齐，两张同人照片的噪声会算出**负相关**（实测把同一个人拆成了两组），
 * 这属于测试数据自己制造的假故障。
 */
function face(faceId: number, base: number[], jitter = 0): FaceVector {
  const vector = new Float32Array(512)
  for (let index = 0; index < base.length; index += 1) vector[index] = base[index] ?? 0
  for (let index = base.length; index < 512; index += 1) {
    if (jitter === 0) continue
    vector[index] = hashNoise(index, faceId) * jitter
  }
  return { faceId, vector }
}

/** 确定性噪声源：同一 (dim, faceId) 恒得同一个值，-1..1 之间 */
function hashNoise(dim: number, faceId: number): number {
  const value = Math.sin(dim * 12.9898 + faceId * 78.233) * 43758.5453
  return (value - Math.floor(value)) * 2 - 1
}

const ALICE = [1, 0, 0, 0]
const BOB = [0, 1, 0, 0]
const CAROL = [0, 0, 1, 0]

describe('cosineSimilarity / normalizeVector', () => {
  it('同向 = 1、正交 = 0、反向 = -1', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([2, 0, 0])
    const c = new Float32Array([0, 1, 0])
    const d = new Float32Array([-3, 0, 0])
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6)
    expect(cosineSimilarity(a, c)).toBeCloseTo(0, 6)
    expect(cosineSimilarity(a, d)).toBeCloseTo(-1, 6)
  })

  it('维度不一致直接报错（不截断成「看起来正常」的相似度）', () => {
    expect(() => cosineSimilarity(new Float32Array(3), new Float32Array(4))).toThrow()
  })

  it('归一化后模长为 1；零向量报错', () => {
    const normalized = normalizeVector(new Float32Array([3, 4, 0]))
    expect(normalized[0]).toBeCloseTo(0.6, 6)
    expect(normalized[1]).toBeCloseTo(0.8, 6)
    expect(() => normalizeVector(new Float32Array([0, 0, 0]))).toThrow()
  })
})

describe('clusterFaces', () => {
  it('三个人各若干张 → 三组，人数与组数相等', () => {
    const faces = [
      face(1, ALICE),
      face(2, ALICE, 0.05),
      face(3, BOB),
      face(4, BOB, 0.05),
      face(5, CAROL),
      face(6, CAROL, 0.05),
    ]
    const clusters = clusterFaces(faces, DEFAULT_FACE_THRESHOLD)
    expect(clusters).toHaveLength(3)
    for (const cluster of clusters) expect(cluster.faceIds).toHaveLength(2)
  })

  it('结果与输入顺序无关（贪心建簇的顺序依赖被精化步骤消掉）', () => {
    const faces = [
      face(1, ALICE),
      face(2, BOB, 0.05),
      face(3, ALICE, 0.02),
      face(4, CAROL),
      face(5, BOB, 0.03),
      face(6, ALICE, 0.04),
      face(7, CAROL, 0.02),
    ]
    const grouping = (input: FaceVector[]): string[] =>
      clusterFaces(input, DEFAULT_FACE_THRESHOLD)
        .map((cluster) =>
          cluster.faceIds
            .slice()
            .sort((a, b) => a - b)
            .join(','),
        )
        .sort()
    const forward = grouping(faces)
    const backward = grouping(faces.slice().reverse())
    const shuffled = grouping([
      faces[3]!,
      faces[0]!,
      faces[6]!,
      faces[2]!,
      faces[5]!,
      faces[1]!,
      faces[4]!,
    ])
    expect(forward).toEqual(backward)
    expect(forward).toEqual(shuffled)
    expect(forward).toHaveLength(3)
  })

  it('阈值放宽会把不该合的人合起来（说明阈值真的在起作用，不是摆设）', () => {
    const faces = [face(1, [1, 0, 0, 0]), face(2, [0.8, 0.6, 0, 0]), face(3, [0, 1, 0, 0])]
    // 1 与 0.8,0.6 相似度 0.8；与第三个 0
    expect(clusterFaces(faces, 0.7)).toHaveLength(2)
    expect(clusterFaces(faces, 0.9)).toHaveLength(3)
  })

  it('聚类前先归一化：同一方向的向量不管模长都是同一个人', () => {
    const short = new Float32Array(512)
    short[0] = 0.01
    const long = new Float32Array(512)
    long[0] = 99
    const clusters = clusterFaces(
      [
        { faceId: 1, vector: short },
        { faceId: 2, vector: long },
      ],
      DEFAULT_FACE_THRESHOLD,
    )
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.faceIds).toHaveLength(2)
  })

  it('空输入、阈值越界的行为明确', () => {
    expect(clusterFaces([])).toEqual([])
    expect(() => clusterFaces([face(1, ALICE)], 0)).toThrow()
    expect(() => clusterFaces([face(1, ALICE)], 1.2)).toThrow()
  })

  it('簇内第一个成员是最像质心的（做封面用）', () => {
    const faces = [face(1, ALICE, 0.05), face(2, ALICE, 0.001), face(3, ALICE, 0.001)]
    const cluster = clusterFaces(faces, DEFAULT_FACE_THRESHOLD)[0]!
    expect(cluster.faceIds).toHaveLength(3)
    expect(cluster.faceIds[0]).not.toBe(1)
  })

  it('大簇排前面（常出现的人先看到）', () => {
    const faces = [
      face(1, ALICE),
      face(2, BOB),
      face(3, BOB, 0.02),
      face(4, BOB, 0.03),
      face(5, CAROL),
      face(6, CAROL, 0.02),
    ]
    const clusters = clusterFaces(faces, DEFAULT_FACE_THRESHOLD)
    expect(clusters[0]?.faceIds).toHaveLength(3)
    expect(clusters[1]?.faceIds).toHaveLength(2)
  })

  it('400 张脸的冒烟：不误合、不炸（质心精化不会指数级变慢）', () => {
    const faces: FaceVector[] = []
    for (let person = 0; person < 40; person += 1) {
      const base = new Array<number>(512).fill(0)
      base[person] = 1
      for (let shot = 0; shot < 10; shot += 1) faces.push(face(person * 10 + shot, base, 0.02))
    }
    const start = Date.now()
    const clusters = clusterFaces(faces, DEFAULT_FACE_THRESHOLD)
    const elapsed = Date.now() - start
    expect(clusters).toHaveLength(40)
    expect(clusters.every((cluster) => cluster.faceIds.length === 10)).toBe(true)
    expect(elapsed).toBeLessThan(4000)
  })
})

describe('mergeClusters', () => {
  it('成员相加、质心按人数加权（不是简单平均）', () => {
    const left = { faceIds: [1, 2, 3], centroid: normalizeVector(new Float32Array([3, 0, 0, 0])) }
    const right = { faceIds: [4], centroid: normalizeVector(new Float32Array([0, 1, 0, 0])) }
    const merged = mergeClusters(left, right)
    expect(merged.faceIds).toEqual([1, 2, 3, 4])
    // 权重 3:1 → x 分量 0.75、y 分量 0.25
    expect(merged.centroid[0]).toBeCloseTo(0.75 / Math.hypot(0.75, 0.25), 5)
    expect(merged.centroid[1]).toBeCloseTo(0.25 / Math.hypot(0.75, 0.25), 5)
  })

  it('一侧为空时返回另一侧（界面误操作不该丢数据）', () => {
    const left = { faceIds: [1], centroid: normalizeVector(new Float32Array([1, 0])) }
    const empty = { faceIds: [], centroid: normalizeVector(new Float32Array([0, 1])) }
    expect(mergeClusters(empty, left).faceIds).toEqual([1])
    expect(mergeClusters(left, empty).faceIds).toEqual([1])
  })

  it('合并后质心落在两组之间，与两边都还算像', () => {
    const left = { faceIds: [1, 2], centroid: normalizeVector(new Float32Array([1, 0, 0])) }
    const right = { faceIds: [3, 4], centroid: normalizeVector(new Float32Array([0.94, 0.34, 0])) }
    const merged = mergeClusters(left, right)
    expect(cosineSimilarity(merged.centroid, left.centroid)).toBeGreaterThan(0.9)
    expect(cosineSimilarity(merged.centroid, right.centroid)).toBeGreaterThan(0.9)
  })
})

describe('splitCluster', () => {
  const vectors = new Map<number, Float32Array>([
    [1, face(1, ALICE).vector],
    [2, face(2, ALICE, 0.01).vector],
    [3, face(3, BOB).vector],
    [4, face(4, BOB, 0.01).vector],
  ])

  it('拆出去的是别人 → 剩余一组、拆出的成员自成一组', () => {
    const cluster = {
      faceIds: [1, 2, 3, 4],
      centroid: normalizeVector(new Float32Array([1, 1, 0, 0])),
    }
    const { remaining, moved } = splitCluster(cluster, [3, 4], vectors, DEFAULT_FACE_THRESHOLD)
    expect(remaining?.faceIds.sort()).toEqual([1, 2])
    expect(moved).toHaveLength(1)
    expect(moved[0]?.faceIds.sort()).toEqual([3, 4])
  })

  it('拆出去的其实是同一人 → 会重新合成一组（不假装知道用户想分几组）', () => {
    const cluster = {
      faceIds: [1, 2, 3, 4],
      centroid: normalizeVector(new Float32Array([1, 1, 0, 0])),
    }
    const { moved } = splitCluster(cluster, [2, 3], vectors, DEFAULT_FACE_THRESHOLD)
    // 2 属于 ALICE、3 属于 BOB：拆出来应该是两组，各一张
    expect(moved).toHaveLength(2)
    expect(moved.every((group) => group.faceIds.length === 1)).toBe(true)
  })

  it('只拆一张 → 拆出组只有那一张，剩余组质心重算', () => {
    const cluster = { faceIds: [1, 2], centroid: normalizeVector(new Float32Array([1, 0, 0, 0])) }
    const { remaining, moved } = splitCluster(cluster, [2], vectors, DEFAULT_FACE_THRESHOLD)
    expect(moved[0]?.faceIds).toEqual([2])
    expect(remaining?.faceIds).toEqual([1])
    expect(cosineSimilarity(remaining!.centroid, vectors.get(1)!)).toBeCloseTo(1, 5)
  })

  it('全部拆走时剩余为 null（界面据此删掉这一组，而不是留个空壳）', () => {
    const cluster = { faceIds: [1, 2], centroid: normalizeVector(new Float32Array([1, 0, 0, 0])) }
    const { remaining, moved } = splitCluster(cluster, [1, 2], vectors, DEFAULT_FACE_THRESHOLD)
    expect(remaining).toBeNull()
    expect(moved).toHaveLength(1)
  })

  it('拆了不属于本组的脸 → 原样返回（不抛错，不悄悄改数据）', () => {
    const cluster = { faceIds: [1, 2], centroid: normalizeVector(new Float32Array([1, 0, 0, 0])) }
    const { remaining, moved } = splitCluster(cluster, [99], vectors, DEFAULT_FACE_THRESHOLD)
    expect(moved).toEqual([])
    expect(remaining?.faceIds).toEqual([1, 2])
  })

  it('缺向量时报错（宁可炸也不能拿错向量算出错的组）', () => {
    const cluster = { faceIds: [1, 7], centroid: normalizeVector(new Float32Array([1, 0, 0, 0])) }
    expect(() => splitCluster(cluster, [7], vectors, DEFAULT_FACE_THRESHOLD)).toThrow()
  })
  it('两张互不相似的脸不会靠「质心中点」把第三张吞进来（回归：奥巴马与拜登曾被合成一组）', () => {
    // A 与 B 正交（余弦 0），二者构成的簇质心与 A、B 都约 0.707 相似 ——
    // 只看质心的旧实现会让阈值 0.45 之下的簇像雪球一样吞掉所有人
    const faces = [
      { faceId: 1, vector: new Float32Array([1, 0, 0, 0]) },
      { faceId: 2, vector: new Float32Array([0, 1, 0, 0]) },
      { faceId: 3, vector: new Float32Array([0, 0, 1, 0]) },
    ]
    const clusters = clusterFaces(faces, 0.45)
    expect(clusters).toHaveLength(3)
    expect(clusters.map((cluster) => cluster.faceIds)).toEqual([[1], [2], [3]])
  })

  it('全链约束下同一个人仍能成组（新成员与簇内每个成员都够像）', () => {
    const same = [
      { faceId: 1, vector: normalizeVector(new Float32Array([1, 0.2, 0, 0])) },
      { faceId: 2, vector: normalizeVector(new Float32Array([1, 0.3, 0.1, 0])) },
      { faceId: 3, vector: normalizeVector(new Float32Array([1, 0.25, 0.05, 0])) },
    ]
    const clusters = clusterFaces(same, 0.45)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.faceIds.slice().sort((a, b) => a - b)).toEqual([1, 2, 3])
  })
})
