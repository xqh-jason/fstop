import { describe, expect, it } from 'vitest'
import {
  countUnknownTime,
  effectiveTime,
  orderResults,
  RESULT_ORDER_LABELS,
} from '../../src/core/result-order'
import type { ResultOrder } from '../../src/core/result-order'

interface Hit {
  photoId: number
  relPath: string
  score: number
  thumbKey: string | null
  width: number | null
  height: number | null
  takenAt: number | null
  mtime: number | null
}

function hit(photoId: number, score: number, takenAt: number | null, mtime: number | null): Hit {
  return {
    photoId,
    relPath: `p${String(photoId)}.jpg`,
    score,
    thumbKey: null,
    width: null,
    height: null,
    takenAt,
    mtime,
  }
}

const DAY = 86_400_000

describe('effectiveTime', () => {
  it('优先拍摄时间（EXIF）', () => {
    expect(effectiveTime({ takenAt: 100, mtime: 999 })).toBe(100)
  })

  it('缺拍摄时间时退回文件修改时间', () => {
    expect(effectiveTime({ takenAt: null, mtime: 999 })).toBe(999)
  })

  it('两者都缺返回 null（不编造时间）', () => {
    expect(effectiveTime({ takenAt: null, mtime: null })).toBeNull()
  })

  it('非法数值（NaN/Infinity）当作缺失', () => {
    expect(effectiveTime({ takenAt: Number.NaN, mtime: 5 })).toBe(5)
    expect(effectiveTime({ takenAt: null, mtime: Number.POSITIVE_INFINITY })).toBeNull()
  })
})

describe('orderResults', () => {
  // 输入按相似度降序（检索层的输出约定）
  const hits = [
    hit(1, 0.9, 3 * DAY, 10 * DAY),
    hit(2, 0.8, 1 * DAY, 11 * DAY),
    hit(3, 0.7, 5 * DAY, 12 * DAY),
  ]

  it('similarity 模式原样返回（不切换排序时行为完全不变）', () => {
    expect(orderResults(hits, 'similarity').map((h) => h.photoId)).toEqual([1, 2, 3])
  })

  it('newest 按时间降序', () => {
    expect(orderResults(hits, 'newest').map((h) => h.photoId)).toEqual([3, 1, 2])
  })

  it('oldest 按时间升序', () => {
    expect(orderResults(hits, 'oldest').map((h) => h.photoId)).toEqual([2, 1, 3])
  })

  it('时间之后仍用相似度做 tiebreaker（同秒照片顺序稳定）', () => {
    const same = [hit(1, 0.5, DAY, DAY), hit(2, 0.9, DAY, DAY), hit(3, 0.7, DAY, DAY)]
    expect(orderResults(same, 'newest').map((h) => h.photoId)).toEqual([2, 3, 1])
    expect(orderResults(same, 'oldest').map((h) => h.photoId)).toEqual([2, 3, 1])
  })

  it('缺时间的排最后（两个方向都是最后），内部仍按相似度', () => {
    const mixed = [hit(1, 0.9, null, null), hit(2, 0.4, DAY, DAY), hit(3, 0.95, 2 * DAY, 2 * DAY)]
    expect(orderResults(mixed, 'newest').map((h) => h.photoId)).toEqual([3, 2, 1])
    expect(orderResults(mixed, 'oldest').map((h) => h.photoId)).toEqual([2, 3, 1])
  })

  it('缺 EXIF 时用文件时间参与排序（不是被丢掉）', () => {
    const mixed = [hit(1, 0.9, null, 7 * DAY), hit(2, 0.5, 3 * DAY, 3 * DAY)]
    expect(orderResults(mixed, 'newest').map((h) => h.photoId)).toEqual([1, 2])
  })

  it('不改动输入数组（纯函数）', () => {
    const input = [hit(1, 0.9, DAY, DAY), hit(2, 0.8, 2 * DAY, 2 * DAY)]
    const snapshot = input.map((h) => h.photoId)
    orderResults(input, 'oldest')
    expect(input.map((h) => h.photoId)).toEqual(snapshot)
  })

  it('空数组安全', () => {
    for (const order of ['similarity', 'newest', 'oldest'] as ResultOrder[]) {
      expect(orderResults([], order)).toEqual([])
    }
  })
})

describe('countUnknownTime', () => {
  it('数出完全没有时间的条目（界面要如实说明）', () => {
    expect(
      countUnknownTime([
        hit(1, 0.9, DAY, DAY),
        hit(2, 0.8, null, null),
        hit(3, 0.7, null, 4 * DAY),
      ]),
    ).toBe(1)
  })
})

describe('RESULT_ORDER_LABELS', () => {
  it('三种模式都有中文标签（UI 与文档共用同一份，不许另写）', () => {
    expect(Object.keys(RESULT_ORDER_LABELS).sort()).toEqual(['newest', 'oldest', 'similarity'])
    for (const label of Object.values(RESULT_ORDER_LABELS)) expect(label.length).toBeGreaterThan(0)
  })
})
