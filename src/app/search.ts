/**
 * 检索 —— 一句话找到照片（M1）。
 *
 * 路径：文本塔编码 query → 与 OPFS 矩阵里的图像向量算余弦 → 取 top-K → 回库里取路径与缩略图键。
 *
 * 两个刻意的选择：
 * - **向量在内存里遍历**：1 万 × 512 维的余弦排序约 10 MFLOP，毫秒级；把向量塞进 SQLite 只是
 *   给 BLOB 付 I/O 代价（§7.1 删掉 `sqlite-vec` 的理由）。
 * - **每次查询重读矩阵**：20 MB 的顺序读在本机是几十毫秒，换来的是「索引还在跑也能搜」——
 *   索引写矩阵、检索读矩阵，两边不需要同步任何内存状态（M1 要求「索引期间可检索」）。
 *   读到多少槽位就用多少，结果可能不全，界面据 `partial` 如实说明。
 *
 * 前提：向量已 L2 归一化（`EmbeddingProvider` 契约），所以余弦退化成点积。
 */

import type { DbService, SearchRow } from '../storage/db.worker'
import type { VectorMatrix } from '../storage/vector-matrix'
import type { EmbedService } from '../workers/embed.worker'

export interface SearchHit {
  readonly photoId: number
  readonly relPath: string
  readonly score: number
  readonly thumbKey: string | null
  readonly width: number | null
  readonly height: number | null
}

export interface SearchOutcome {
  readonly hits: readonly SearchHit[]
  readonly query: string
  /** 库里有多少张已有向量 */
  readonly indexed: number
  /** 矩阵里实际参与排序多少条（< indexed 说明索引还在跑，结果不全） */
  readonly ranked: number
  readonly partial: boolean
  readonly elapsedMs: number
}

export interface SearchOptions {
  readonly db: DbService
  readonly embed: EmbedService
  readonly vectors: VectorMatrix
  readonly query: string
  readonly topK?: number
}

export async function searchPhotos(options: SearchOptions): Promise<SearchOutcome> {
  const started = performance.now()
  const topK = options.topK ?? 24
  const query = options.query.trim()
  const elapsed = (): number => Math.round(performance.now() - started)
  if (query === '') {
    return { hits: [], query, indexed: 0, ranked: 0, partial: false, elapsedMs: 0 }
  }

  const rows = await options.db.searchRows()
  if (rows.length === 0) {
    return { hits: [], query, indexed: 0, ranked: 0, partial: false, elapsedMs: elapsed() }
  }

  const vector = (await options.embed.embedText(query)) as Float32Array
  const dim = vector.length
  const matrix = await options.vectors.snapshot()
  const slots = Math.floor(matrix.length / dim)

  const scored: { row: SearchRow; score: number }[] = []
  for (const row of rows) {
    // 槽位超出矩阵可读范围 = 这条向量还没落盘（索引进行中），跳过
    if (row.matrixOffset >= slots) continue
    const base = row.matrixOffset * dim
    let dot = 0
    for (let column = 0; column < dim; column += 1) {
      dot += (matrix[base + column] ?? 0) * (vector[column] ?? 0)
    }
    scored.push({ row, score: dot })
  }

  scored.sort((a, b) => b.score - a.score)
  const hits: SearchHit[] = scored.slice(0, topK).map(({ row, score }) => ({
    photoId: row.photoId,
    relPath: row.relPath,
    score,
    thumbKey: row.thumbKey,
    width: row.width,
    height: row.height,
  }))

  return {
    hits,
    query,
    indexed: rows.length,
    ranked: scored.length,
    partial: scored.length < rows.length,
    elapsedMs: elapsed(),
  }
}
