import { describe, expect, it } from 'vitest'
import { groupSimilarPhotos } from '../../src/core/similarity-group'
import type { GroupingInput } from '../../src/core/similarity-group'

/**
 * 构造低维向量做测试（512 维没必要）：v() 造一个单位向量，
 * angle(A, B) 让两组向量夹出指定的余弦值。
 */
function unit(...components: number[]): Float32Array {
  const vector = Float32Array.from(components)
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / norm
  }
  return vector
}

/** 在 2 个方向张成的平面上造一对余弦 ≈ cos 值的向量（都与 e0 夹同一角） */
function near(vector: Float32Array, cosine: number): Float32Array {
  // 需要 vector 的一个正交方向（对 unit 向量，交换前两维翻转一维即是）
  const ortho = unit(vector[1] ?? 0, -(vector[0] ?? 0), 0, 0)
  const out = new Float32Array(vector.length)
  const sin = Math.sqrt(Math.max(0, 1 - cosine * cosine))
  for (let index = 0; index < vector.length; index += 1) {
    out[index] = (vector[index] ?? 0) * cosine + (ortho[index] ?? 0) * sin
  }
  return out
}

const E0 = unit(1, 0, 0, 0)

function run(photoIds: number[], vectors: Float32Array[], threshold: number) {
  return groupSimilarPhotos({ photoIds, vectors } satisfies GroupingInput, threshold)
}

describe('groupSimilarPhotos', () => {
  it('两张几乎相同的向量 + 一张无关的 → 相同的落一组、单独的独自一组', () => {
    const vectors = [E0, near(E0, 0.98), unit(0, 0, 1, 0)]
    const groups = run([1, 2, 3], vectors, 0.9)
    expect(groups).toHaveLength(2)
    const pair = groups.find((group) => group.memberIds.length === 2)
    expect(pair?.memberIds).toEqual([1, 2])
    expect(groups.find((group) => group.memberIds.length === 1)?.memberIds).toEqual([3])
  })

  it('阈值之下各自成组（每张照片都出现在结果里，不多不少）', () => {
    const vectors = [E0, near(E0, 0.3), unit(0, 0, 1, 0), unit(0, 0, 0, 1)]
    const groups = run([10, 11, 12, 13], vectors, 0.9)
    const flattened = groups.flatMap((group) => group.memberIds)
    expect([...flattened].sort()).toEqual([10, 11, 12, 13])
    expect(groups.every((group) => group.memberIds.length === 1)).toBe(true)
  })

  it('代表是与组内其它成员平均相似度最高的那张（不是最早出现的）', () => {
    // A 与 B 夹角小、与 C 夹角大；B 居中 → 平均相似度最高的是 B，不是种子 A
    const a = near(E0, 0.95)
    const b = new Float32Array(4)
    {
      // b = 归一化(a + c) 的方向，使 cos(b,a) = cos(b,c) 且都较高
      const c1 = E0
      const sum = new Float32Array(4)
      for (let index = 0; index < 4; index += 1) {
        sum[index] = (a[index] ?? 0) + (c1[index] ?? 0)
      }
      b.set(unit(...sum))
    }
    // 验证 b 与两边等距（数值噪声内）
    const dot = (x: Float32Array, y: Float32Array) => {
      let s = 0
      for (let index = 0; index < 4; index += 1) s += (x[index] ?? 0) * (y[index] ?? 0)
      return s
    }
    const ba = dot(b, a)
    const bc = dot(b, E0)
    expect(Math.abs(ba - bc)).toBeLessThan(1e-6)

    const groups = run([100, 200, 300], [a, b, E0], 0.5)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.representativeId).toBe(200)
  })

  it('memberIds 按与代表的相似度降序，且代表是第一个', () => {
    const vectors = [E0, near(E0, 0.95), near(E0, 0.99)]
    const groups = run([1, 2, 3], vectors, 0.9)
    expect(groups[0]?.memberIds[0]).toBe(groups[0]?.representativeId)
    const [first, second] = groups[0]?.memberIds ?? []
    const vectorsById = new Map([
      [1, vectors[0] as Float32Array],
      [2, vectors[1] as Float32Array],
      [3, vectors[2] as Float32Array],
    ])
    const representative = vectorsById.get(groups[0]?.representativeId ?? 0) as Float32Array
    const score = (id: number | undefined) => {
      let s = 0
      for (let index = 0; index < 4; index += 1) {
        s += (representative[index] ?? 0) * (vectorsById.get(id ?? 0)?.[index] ?? 0)
      }
      return s
    }
    expect(score(first)).toBeGreaterThanOrEqual(score(second))
  })

  it('传递性不越界：A~B、B~C 相似但 A 与 C 低于阈值时，B 会把更近的一组开出来', () => {
    // 阈值 0.95：A 与 B 余弦 0.96（同组），C 与 B 只 0.9（不同组）。
    // 种子是 A，B 被吸走；C 与 A 只有 ~0.85 → C 单独一组，且**不会**因为「B~C 相似」被合并。
    const a = E0
    const b = near(E0, 0.96)
    const c = near(E0, 0.9)
    const groups = run([1, 2, 3], [a, b, c], 0.95)
    expect(groups.map((group) => group.memberIds.length).sort()).toEqual([1, 2])
    expect(groups.find((group) => group.memberIds.length === 2)?.memberIds).toEqual([1, 2])
  })

  it('空库返回空数组', () => {
    expect(run([], [], 0.9)).toEqual([])
  })

  it('阈值非法 (0 / >1) 拒绝', () => {
    expect(() => run([1], [E0], 0)).toThrow(/阈值/)
    expect(() => run([1], [E0], 1.2)).toThrow(/阈值/)
  })

  it('photoIds 与 vectors 数量不一致拒绝', () => {
    expect(() => run([1, 2], [E0], 0.9)).toThrow(/数量不一致/)
  })

  it('大量重复项在线性时间内聚成一组（冒烟：性能不退化）', () => {
    const count = 400
    const vectors = Array.from({ length: count }, () => near(E0, 0.97 + Math.random() * 0.02))
    const photoIds = Array.from({ length: count }, (_, index) => index + 1)
    const started = performance.now()
    const groups = run(photoIds, vectors, 0.9)
    const elapsed = performance.now() - started
    expect(groups).toHaveLength(1)
    expect(groups[0]?.memberIds).toHaveLength(count)
    expect(elapsed).toBeLessThan(2000) // O(n²) 也应该远小于这个数
  })
})
