import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KnownPhoto, ScanEntry } from '../../src/core/incremental-scan'
import { planScan } from '../../src/core/incremental-scan'
import { applyScanPlan, MISSING_PHOTO_REASON } from '../../src/core/scan-apply'
import { SCHEMA_DDL_V1 } from '../../src/core/model'

let db: DatabaseSync
let rootId: number

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_DDL_V1) db.exec(statement)
  db.prepare(
    `INSERT INTO roots (handle_key, label, permission_state) VALUES ('photos', '照片', 'granted')`,
  ).run()
  rootId = Number(
    (db.prepare(`SELECT id FROM roots WHERE handle_key = 'photos'`).get() as { id: number }).id,
  )
})

afterEach(() => {
  db.close()
})

function entry(relPath: string, contentHash: string, size = 1000): ScanEntry {
  return { relPath, size, mtime: 1_700_000_000_000, contentHash }
}

function apply(entries: readonly ScanEntry[], now = 5000) {
  const known = db
    .prepare(
      `SELECT id, rel_path AS relPath, content_hash AS contentHash, deleted_at AS deletedAt FROM photos`,
    )
    .all() as unknown as KnownPhoto[]
  const plan = planScan(entries, known)
  return { plan, result: applyScanPlan(db, plan, { rootId, now }) }
}

function photoRows() {
  return db
    .prepare(
      `SELECT id, rel_path AS relPath, content_hash AS contentHash, deleted_at AS deletedAt FROM photos ORDER BY id`,
    )
    .all() as unknown as {
    id: number
    relPath: string
    contentHash: string
    deletedAt: number | null
  }[]
}

function jobRows() {
  return db
    .prepare(
      `SELECT photo_id AS photoId, kind, status, attempts, last_error AS lastError FROM jobs ORDER BY photo_id, kind`,
    )
    .all() as unknown as {
    photoId: number
    kind: string
    status: string
    attempts: number
    lastError: string | null
  }[]
}

describe('applyScanPlan：入库与任务', () => {
  it('新照片入库并排一条 embed 任务', () => {
    const { result } = apply([entry('a.jpg', 'h1'), entry('b.png', 'h2')])
    expect(result.inserted).toBe(2)
    expect(photoRows().map((row) => row.relPath)).toEqual(['a.jpg', 'b.png'])
    expect(jobRows()).toEqual([
      { photoId: 1, kind: 'embed', status: 'pending', attempts: 0, lastError: null },
      { photoId: 2, kind: 'embed', status: 'pending', attempts: 0, lastError: null },
    ])
    // ext 从路径推出来（界面按扩展名分组要用）
    const exts = db.prepare(`SELECT ext FROM photos ORDER BY id`).all() as unknown as {
      ext: string
    }[]
    expect(exts.map((row) => row.ext)).toEqual(['jpg', 'png'])
  })

  it('同一份扫描跑第二次：全是 unchanged，不重复排任务', () => {
    apply([entry('a.jpg', 'h1')])
    const { plan, result } = apply([entry('a.jpg', 'h1')])
    expect(plan.unchanged).toHaveLength(1)
    expect(result.inserted).toBe(0)
    expect(jobRows()).toHaveLength(1)
  })

  it('移动只改路径：不重排任务、不标记删除', () => {
    apply([entry('2024/a.jpg', 'h1')])
    const { result } = apply([entry('2025/a.jpg', 'h1')])
    expect(result.moved).toBe(1)
    expect(result.markedDeleted).toBe(0)
    expect(photoRows()[0]!.relPath).toBe('2025/a.jpg')
    expect(jobRows()).toHaveLength(1)
  })

  it('链式改名 a→b、b→c 不会撞 UNIQUE(root_id, rel_path)（两步法）', () => {
    apply([entry('a.jpg', 'h1'), entry('b.jpg', 'h2')])
    // 手工构造链式移动：planScan 对「目标路径已存在」的情况会判成 reindex（同路径优先），
    // 所以这里直接压 apply 的两步法——一次性落到目标路径会撞唯一约束
    const rows = photoRows()
    const chain = {
      inserts: [],
      reindex: [],
      moves: [
        { id: rows[0]!.id, entry: entry('b.jpg', 'h1'), from: 'a.jpg' },
        { id: rows[1]!.id, entry: entry('c.jpg', 'h2'), from: 'b.jpg' },
      ],
      restores: [],
      unchanged: [],
      deleted: [],
    }
    const result = applyScanPlan(db, chain, { rootId, now: 6000 })
    expect(result.moved).toBe(2)
    expect(
      photoRows()
        .map((row) => `${row.relPath}:${row.contentHash}`)
        .sort(),
    ).toEqual(['b.jpg:h1', 'c.jpg:h2'])
  })

  it('planScan 对「目标路径已存在」判成 reindex 而不是移动（同路径优先）', () => {
    apply([entry('a.jpg', 'h1'), entry('b.jpg', 'h2')])
    const { plan, result } = apply([entry('b.jpg', 'h1'), entry('c.jpg', 'h2')])
    expect(plan.moves).toHaveLength(0)
    expect(result.reindexed).toBe(1)
    expect(result.inserted).toBe(1)
  })

  it('两条记录互换路径（内容也跟着换）不会撞唯一约束', () => {
    apply([entry('a.jpg', 'h1'), entry('b.jpg', 'h2')])
    // 手工构造互换计划：planScan 一般会判成 reindex，这里专门压 apply 的健壮性
    const rows = photoRows()
    const swap = {
      inserts: [],
      reindex: [],
      moves: [
        { id: rows[0]!.id, entry: entry('b.jpg', 'h1'), from: 'a.jpg' },
        { id: rows[1]!.id, entry: entry('a.jpg', 'h2'), from: 'b.jpg' },
      ],
      restores: [],
      unchanged: [],
      deleted: [],
    }
    const result = applyScanPlan(db, swap, { rootId, now: 6000 })
    expect(result.moved).toBe(2)
    expect(
      photoRows()
        .map((row) => `${row.relPath}:${row.contentHash}`)
        .sort(),
    ).toEqual(['a.jpg:h2', 'b.jpg:h1'])
  })
})

describe('applyScanPlan：内容变化与消失/恢复', () => {
  it('内容变了：任务打回 pending、attempts 归零，但**不删** embeddings 行（槽位固定）', () => {
    apply([entry('a.jpg', 'h1')])
    db.prepare(
      `INSERT INTO embeddings (photo_id, model_id, dim, matrix_offset) VALUES (1, 'chinese-clip-vit-b16', 512, 0)`,
    ).run()
    db.prepare(`UPDATE jobs SET status = 'done', attempts = 2 WHERE photo_id = 1`).run()

    const { result } = apply([entry('a.jpg', 'h2')])
    expect(result.reindexed).toBe(1)
    expect(jobRows()[0]).toMatchObject({ status: 'pending', attempts: 0, lastError: null })
    const embeddings = db.prepare(`SELECT COUNT(*) AS n FROM embeddings`).get() as { n: number }
    expect(embeddings.n).toBe(1)
    expect(photoRows()[0]!.contentHash).toBe('h2')
  })

  it('照片消失：标记 deleted_at、任务转 skipped 且写明原因，记录不物理删', () => {
    apply([entry('a.jpg', 'h1'), entry('b.jpg', 'h2')])
    const { result } = apply([entry('a.jpg', 'h1')], 7000)
    expect(result.markedDeleted).toBe(1)
    expect(result.cancelledJobs).toBe(1)
    const gone = photoRows().find((row) => row.relPath === 'b.jpg')!
    expect(gone.deletedAt).toBe(7000)
    const cancelled = jobRows().find((row) => row.photoId === gone.id)!
    expect(cancelled).toMatchObject({ status: 'skipped', lastError: MISSING_PHOTO_REASON })
  })

  it('照片回来：清掉 deleted_at，并只重排「因消失而跳过」的任务', () => {
    apply([entry('a.jpg', 'h1'), entry('b.jpg', 'h2'), entry('c.jpg', 'h3')])
    // c 的任务是「格式不支持」而跳过的——照片回来时**不该**被重排
    db.prepare(
      `UPDATE jobs SET status = 'skipped', last_error = 'unsupported-format' WHERE photo_id = (SELECT id FROM photos WHERE rel_path = 'c.jpg')`,
    ).run()
    apply([entry('a.jpg', 'h1')], 7000) // b、c 消失
    expect(jobRows().filter((row) => row.status === 'skipped')).toHaveLength(2)

    const { result } = apply(
      [entry('a.jpg', 'h1'), entry('b.jpg', 'h2'), entry('c.jpg', 'h3')],
      8000,
    )
    expect(result.restored).toBe(2)
    const byPath = new Map(photoRows().map((row) => [row.relPath, row]))
    expect(byPath.get('b.jpg')!.deletedAt).toBeNull()
    expect(byPath.get('c.jpg')!.deletedAt).toBeNull()

    const jobs = jobRows()
    const bJob = jobs.find((row) => row.photoId === byPath.get('b.jpg')!.id)!
    const cJob = jobs.find((row) => row.photoId === byPath.get('c.jpg')!.id)!
    expect(bJob).toMatchObject({ status: 'pending', lastError: null })
    expect(cJob).toMatchObject({ status: 'skipped', lastError: 'unsupported-format' })
  })

  it('照片在别处回来（换路径 + 内容没变）：清 deleted_at 并更新路径', () => {
    apply([entry('a.jpg', 'h1'), entry('b.jpg', 'h2')])
    apply([entry('a.jpg', 'h1')], 7000) // b 消失（a 还在，避免触发「空扫描拒绝全删」）
    const { result } = apply([entry('a.jpg', 'h1'), entry('新目录/b.jpg', 'h2')], 8000)
    expect(result.restored).toBe(1)
    const restored = photoRows().find((row) => row.relPath === '新目录/b.jpg')!
    expect(restored).toMatchObject({ contentHash: 'h2', deletedAt: null })
  })
})

describe('applyScanPlan：事务与安全', () => {
  it('中途失败整体回滚，不留半应用状态', () => {
    apply([entry('a.jpg', 'h1')])
    // 构造一条会撞 UNIQUE(root_id, rel_path) 的插入（新照片的路径与已有记录相同）
    const broken = {
      inserts: [entry('a.jpg', 'h9'), entry('b.jpg', 'h10')],
      reindex: [],
      moves: [],
      restores: [],
      unchanged: [],
      deleted: [],
    }
    expect(() => applyScanPlan(db, broken, { rootId, now: 9000 })).toThrow()
    // 第一条插入就已经失败 → 第二条也不该入库；已有一条记录保持原样
    expect(photoRows().map((row) => row.relPath)).toEqual(['a.jpg'])
    expect(photoRows()[0]!.contentHash).toBe('h1')
    expect(jobRows()).toHaveLength(1)
  })

  it('kinds 可扩展：排 face/ocr 时一并入队', () => {
    applyScanPlan(db, planScan([entry('a.jpg', 'h1')], []), {
      rootId,
      now: 1000,
      kinds: ['embed', 'face'],
    })
    expect(
      jobRows()
        .map((row) => row.kind)
        .sort(),
    ).toEqual(['embed', 'face'])
  })
})
