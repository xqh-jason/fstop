import { describe, expect, it } from 'vitest'
import {
  applyTransform,
  ARCFACE_TEMPLATE,
  landmarksUsable,
  solveSimilarity,
  transformScale,
} from '../../src/core/face-align'

describe('solveSimilarity', () => {
  it('目标 == 源时得到恒等变换', () => {
    const transform = solveSimilarity(ARCFACE_TEMPLATE, ARCFACE_TEMPLATE)
    expect(transform[0]).toBeCloseTo(1, 6)
    expect(transform[1]).toBeCloseTo(0, 6)
    expect(transform[2]).toBeCloseTo(0, 6)
    expect(transform[3]).toBeCloseTo(0, 6)
    expect(transform[4]).toBeCloseTo(1, 6)
    expect(transform[5]).toBeCloseTo(0, 6)
  })

  it('纯平移', () => {
    const moved = ARCFACE_TEMPLATE.map((point) => ({ x: point.x + 7, y: point.y - 3 }))
    const transform = solveSimilarity(ARCFACE_TEMPLATE, moved)
    expect(transform[2]).toBeCloseTo(7, 4)
    expect(transform[5]).toBeCloseTo(-3, 4)
    expect(transformScale(transform)).toBeCloseTo(1, 6)
  })

  it('纯缩放 2 倍', () => {
    const scaled = ARCFACE_TEMPLATE.map((point) => ({ x: point.x * 2, y: point.y * 2 }))
    const transform = solveSimilarity(ARCFACE_TEMPLATE, scaled)
    expect(transformScale(transform)).toBeCloseTo(2, 4)
    for (const point of ARCFACE_TEMPLATE) {
      const mapped = applyTransform(transform, point)
      expect(mapped.x).toBeCloseTo(point.x * 2, 3)
      expect(mapped.y).toBeCloseTo(point.y * 2, 3)
    }
  })

  it('绕原点旋转 90°：a≈0、b≈1', () => {
    const src = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ]
    const dst = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: -10, y: 0 },
    ]
    const transform = solveSimilarity(src, dst)
    expect(transform[0]).toBeCloseTo(0, 6)
    expect(transform[1]).toBeCloseTo(1, 6)
    expect(transformScale(transform)).toBeCloseTo(1, 6)
    for (let index = 0; index < src.length; index += 1) {
      const mapped = applyTransform(transform, src[index]!)
      expect(mapped.x).toBeCloseTo(dst[index]!.x, 6)
      expect(mapped.y).toBeCloseTo(dst[index]!.y, 6)
    }
  })

  it('点对数量不一致 / 少于两点 / 源点全重合都报错（不静默给个乱矩阵）', () => {
    expect(() => solveSimilarity(ARCFACE_TEMPLATE, ARCFACE_TEMPLATE.slice(0, 3))).toThrow()
    expect(() => solveSimilarity([{ x: 0, y: 0 }], [{ x: 0, y: 0 }])).toThrow()
    expect(() =>
      solveSimilarity(
        [
          { x: 5, y: 5 },
          { x: 5, y: 5 },
        ],
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      ),
    ).toThrow()
  })

  it('把真实检测点映射到模板：残差接近 0（说明解是真正的最小二乘）', () => {
    // 模拟一张「歪头 + 偏左 + 略小」的脸：模板先旋转 12°、缩 0.8、平移
    const angle = (12 * Math.PI) / 180
    const face = ARCFACE_TEMPLATE.map((point) => ({
      x: (point.x * Math.cos(angle) - point.y * Math.sin(angle)) * 0.8 + 120,
      y: (point.x * Math.sin(angle) + point.y * Math.cos(angle)) * 0.8 + 90,
    }))
    const transform = solveSimilarity(face, ARCFACE_TEMPLATE)
    expect(transformScale(transform)).toBeCloseTo(1 / 0.8, 4)
    for (let index = 0; index < face.length; index += 1) {
      const mapped = applyTransform(transform, face[index]!)
      expect(mapped.x).toBeCloseTo(ARCFACE_TEMPLATE[index]!.x, 3)
      expect(mapped.y).toBeCloseTo(ARCFACE_TEMPLATE[index]!.y, 3)
    }
  })
})

describe('landmarksUsable', () => {
  it('正常 5 点可用', () => {
    expect(landmarksUsable(ARCFACE_TEMPLATE)).toBe(true)
  })

  it('点数不足 / 含 NaN / 挤成一点 / 共线都拒收', () => {
    expect(
      landmarksUsable([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]),
    ).toBe(false)
    expect(
      landmarksUsable([
        { x: 0, y: 0 },
        { x: Number.NaN, y: 0 },
        { x: 0, y: 10 },
      ]),
    ).toBe(false)
    expect(
      landmarksUsable([
        { x: 5, y: 5 },
        { x: 5.5, y: 5 },
        { x: 5, y: 5.5 },
      ]),
    ).toBe(false)
    // 一条直线上的三点：面积 0
    expect(
      landmarksUsable([
        { x: 0, y: 0 },
        { x: 20, y: 20 },
        { x: 40, y: 40 },
      ]),
    ).toBe(false)
  })
})
