/**
 * 检索结果排序（M2）—— 「按相似度」与「按时间」两种看法。
 *
 * 为什么是纯函数：排序规则会被 UI（切换排序）、未来的 CLI/导出共用，
 * 放在 `src/core/` 才能被单测钉住（项目红线：同一语义不允许两份实现）。
 *
 * 三条刻意的规则：
 * 1. **时间优先用 `takenAt`（EXIF 拍摄时间），缺失才退回 `mtime`（文件修改时间）**——
 *    用户说的「按时间」几乎总是指「什么时候拍的」，而 `mtime` 会被复制/同步/导出改名刷新，
 *    是它自己都不是的「时间」。但**不假装有**：两者都没有就排到末尾并在界面标注，
 *    不要塞一个「1970」进去骗排序。
 * 2. **相似度是第一排序键的兜底**：时间相同时用它做 tiebreaker，避免同秒照片顺序随机
 *    （sqlite 返回顺序在重建索引后会变，顺序抖动会让用户以为结果变了）。
 * 3. **稳定排序**：同键元素保持输入顺序（Array.prototype.sort 在 ES2019 起保证稳定）。
 */

import type { SearchHit } from '../app/search'

export type ResultOrder = 'similarity' | 'newest' | 'oldest'

export const RESULT_ORDER_LABELS: Readonly<Record<ResultOrder, string>> = {
  similarity: '按相似度',
  newest: '按时间（新→旧）',
  oldest: '按时间（旧→新）',
}

/** 排序需要的照片时间：优先拍摄时间，其次文件修改时间（都可能没有） */
export interface TimedHit {
  readonly takenAt: number | null
  readonly mtime: number | null
}

/**
 * 取「有效时间」：`takenAt` 优先，缺失用 `mtime`；都没有返回 null。
 * 不做任何假值填充（见文件头第 1 条）。
 */
export function effectiveTime(hit: TimedHit): number | null {
  if (hit.takenAt !== null && Number.isFinite(hit.takenAt)) return hit.takenAt
  if (hit.mtime !== null && Number.isFinite(hit.mtime)) return hit.mtime
  return null
}

/**
 * 按给定模式重排检索结果，返回新数组（不改动输入）。
 * `similarity` 模式原样返回（检索层已按分数降序），保证「不切排序时行为完全不变」。
 */
export function orderResults<T extends TimedHit & SearchHit>(
  hits: readonly T[],
  order: ResultOrder,
): T[] {
  if (order === 'similarity') return hits.slice()
  const direction = order === 'newest' ? -1 : 1
  return hits.slice().sort((a, b) => {
    const timeA = effectiveTime(a)
    const timeB = effectiveTime(b)
    // 无时间的排在最后（两种方向都是最后：它们是「不知道」的那一类）
    if (timeA === null && timeB === null) return b.score - a.score
    if (timeA === null) return 1
    if (timeB === null) return -1
    if (timeA !== timeB) return (timeA - timeB) * direction
    return b.score - a.score
  })
}

/** 这批结果里有多少条完全不知道时间（界面要如实说明，而不是假装都按时间排了） */
export function countUnknownTime(hits: readonly TimedHit[]): number {
  return hits.reduce((count, hit) => count + (effectiveTime(hit) === null ? 1 : 0), 0)
}
