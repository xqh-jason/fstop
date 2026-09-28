/**
 * 把「扫描计划」落成 SQL —— `src/core/` 手写区（docs/DESIGN.md 的执行侧）。
 *
 * `incremental-scan.ts` 只做判断（纯函数），这里负责**把判断写进库**。
 * 两者分开是为了：判断的全部边界都能用单测覆盖，而写库这层只处理 SQL 与事务。
 *
 * 几条必须写下来才不会再踩的规则：
 *
 * 1. **整个 apply 在一个事务里**。中途抛错就整体回滚——半应用的状态会让「哪些照片入库了」
 *    变得不可知，而增量扫描的前提正是「库 = 磁盘的快照」。
 * 2. **移动分两步**（先改成临时路径、再改成目标路径）。否则 `a → b`、`b → c` 这种链式改名
 *    会在第一步就撞上 `UNIQUE(root_id, rel_path)`。同一次扫描里两条记录互换名字同理。
 * 3. **内容变了不删向量、只把任务打回 pending**：`embeddings` 的 `(model_id, matrix_offset)`
 *    是固定槽位，删了要重新分配；同一个模型同维度下直接覆盖同一槽位即可。
 * 4. **照片消失 ≠ 任务失败**：消失的照片把 `pending`/`running` 的任务记为 `skipped` 并写明
 *    原因 `photo-missing`，这样照片回来时（restore）只重排**因消失而跳过**的任务，
 *    不会去重试那些「格式不支持」而跳过的任务。
 */

import { type JobKind, type QueueDatabase, enqueueJobs } from './index-queue'
import type { ScanPlan } from './incremental-scan'
import { extensionOf } from './photo-files'

/** 任务因「照片从磁盘消失」被跳过的标记（与「格式不支持」区分开） */
export const MISSING_PHOTO_REASON = 'photo-missing'

export interface ApplyScanOptions {
  readonly rootId: number
  /** epoch ms，显式传入便于测试 */
  readonly now: number
  /** 入库时要排哪些任务，默认只排嵌入 */
  readonly kinds?: readonly JobKind[]
}

export interface ApplyScanResult {
  readonly inserted: number
  readonly moved: number
  readonly restored: number
  readonly reindexed: number
  readonly markedDeleted: number
  readonly unchanged: number
  /** 因照片消失而被记为 skipped 的任务数 */
  readonly cancelledJobs: number
}

export function applyScanPlan(
  db: QueueDatabase & { exec(sql: string): void },
  plan: ScanPlan,
  options: ApplyScanOptions,
): ApplyScanResult {
  const { rootId, now } = options
  const kinds = options.kinds ?? (['embed'] as const)

  db.exec('BEGIN')
  try {
    const insertPhoto = db.prepare(
      `INSERT INTO photos (root_id, rel_path, ext, size, mtime, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    let inserted = 0
    for (const entry of plan.inserts) {
      const result = insertPhoto.run(
        rootId,
        entry.relPath,
        extensionOf(entry.relPath),
        entry.size,
        entry.mtime,
        entry.contentHash,
      ) as { lastInsertRowid?: number | bigint } | undefined
      const photoId = Number(result?.lastInsertRowid ?? 0)
      if (photoId > 0) {
        enqueueJobs(db, [photoId], kinds, now)
        inserted += 1
      }
    }

    // 规则 2：链式改名先全部挪到临时路径，再落到目标路径
    const parkPath = db.prepare(`UPDATE photos SET rel_path = '__moving__' || id WHERE id = ?`)
    const landPath = db.prepare(`UPDATE photos SET rel_path = ? WHERE id = ?`)
    for (const move of plan.moves) parkPath.run(move.id)
    for (const move of plan.moves) landPath.run(move.entry.relPath, move.id)

    const updatePhoto = db.prepare(
      `UPDATE photos SET rel_path = ?, size = ?, mtime = ?, content_hash = ?, deleted_at = NULL WHERE id = ?`,
    )
    const rearmJob = db.prepare(
      `UPDATE jobs SET status = 'pending', attempts = 0, last_error = NULL, updated_at = ?
       WHERE photo_id = ? AND kind = ?`,
    )
    const rearmMissingJob = db.prepare(
      `UPDATE jobs SET status = 'pending', attempts = 0, last_error = NULL, updated_at = ?
       WHERE photo_id = ? AND kind = ? AND status = 'skipped' AND last_error = ?`,
    )

    let restored = 0
    for (const restore of plan.restores) {
      updatePhoto.run(
        restore.entry.relPath,
        restore.entry.size,
        restore.entry.mtime,
        restore.entry.contentHash,
        restore.id,
      )
      // 因消失而跳过的任务要重排；已经 done 的不动（内容没变就没什么可重算的）
      for (const kind of kinds) rearmMissingJob.run(now, restore.id, kind, MISSING_PHOTO_REASON)
      if (restore.reindex) {
        for (const kind of kinds) rearmJob.run(now, restore.id, kind)
        enqueueJobs(db, [restore.id], kinds, now)
      }
      restored += 1
    }

    const touchPhoto = db.prepare(
      `UPDATE photos SET size = ?, mtime = ?, content_hash = ? WHERE id = ?`,
    )
    let reindexed = 0
    for (const action of plan.reindex) {
      touchPhoto.run(action.entry.size, action.entry.mtime, action.entry.contentHash, action.id)
      // 规则 3：不删 embeddings（槽位固定），只把任务打回 pending 让嵌入侧覆盖同一槽位
      for (const kind of kinds) rearmJob.run(now, action.id, kind)
      enqueueJobs(db, [action.id], kinds, now)
      reindexed += 1
    }

    const markDeleted = db.prepare(`UPDATE photos SET deleted_at = ? WHERE id = ?`)
    const cancelJob = db.prepare(
      `UPDATE jobs SET status = 'skipped', last_error = ?, updated_at = ?
       WHERE photo_id = ? AND kind = ? AND status IN ('pending', 'running')`,
    )
    let cancelledJobs = 0
    for (const photoId of plan.deleted) {
      markDeleted.run(now, photoId)
      for (const kind of kinds) {
        const result = cancelJob.run(MISSING_PHOTO_REASON, now, photoId, kind) as
          { changes?: number } | undefined
        if (result?.changes !== undefined && result.changes > 0) cancelledJobs += 1
      }
    }

    db.exec('COMMIT')
    return {
      inserted,
      moved: plan.moves.length,
      restored,
      reindexed,
      markedDeleted: plan.deleted.length,
      unchanged: plan.unchanged.length,
      cancelledJobs,
    }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
