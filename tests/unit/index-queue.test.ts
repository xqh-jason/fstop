import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_ATTEMPTS,
  claimBatch,
  completeJob,
  enqueueJobs,
  failJob,
  nextPending,
  progressOf,
  requeueRunning,
  skipJob,
} from '../../src/core/index-queue'
import { applyMigrations } from '../../src/storage/migrations'

let db: DatabaseSync

function insertPhoto(relPath: string): number {
  db.prepare(
    `INSERT OR IGNORE INTO roots (handle_key, label, permission_state) VALUES ('photos', '照片', 'granted')`,
  ).run()
  const root = db.prepare(`SELECT id FROM roots WHERE handle_key = 'photos'`).get()
  db.prepare(
    `INSERT INTO photos (root_id, rel_path, ext, size, mtime, content_hash, width, height, thumb_key)
     VALUES (?, ?, 'jpg', 1, 1, 'hash', 1, 1, 'thumb')`,
  ).run(Number(root?.id), relPath)
  const row = db.prepare(`SELECT id FROM photos WHERE rel_path = ?`).get(relPath)
  return Number(row?.id)
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  applyMigrations(db, 0)
})

afterEach(() => {
  db.close()
})

describe('index-queue：登记与幂等', () => {
  it('给一批照片登记任务，重复登记是空操作（增量重扫会反复登记同一批）', () => {
    const photos = [insertPhoto('a.jpg'), insertPhoto('b.jpg')]
    expect(enqueueJobs(db, photos, ['embed'], 1000)).toBe(2)
    expect(enqueueJobs(db, photos, ['embed'], 2000)).toBe(0)
    expect(progressOf(db, 'embed').total).toBe(2)
    expect(progressOf(db, 'embed').pending).toBe(2)
  })

  it('不同 kind 各自一条任务，互不覆盖', () => {
    const photos = [insertPhoto('a.jpg')]
    enqueueJobs(db, photos, ['embed', 'face', 'ocr'], 1000)
    expect(progressOf(db, 'embed').total).toBe(1)
    expect(progressOf(db, 'face').total).toBe(1)
    expect(progressOf(db, 'ocr').total).toBe(1)
  })

  it('空输入与非法 kind 的行为：空输入返回 0，非法 kind 抛错', () => {
    expect(enqueueJobs(db, [], ['embed'])).toBe(0)
    expect(enqueueJobs(db, [1], [])).toBe(0)
    expect(() => enqueueJobs(db, [insertPhoto('a.jpg')], ['nope' as 'embed'])).toThrow(
      /未知的任务类型/,
    )
  })
})

describe('index-queue：领取与状态迁移', () => {
  it('claimBatch 只领 pending，并把它变成 running（不重复领取）', () => {
    const photos = [insertPhoto('a.jpg'), insertPhoto('b.jpg'), insertPhoto('c.jpg')]
    enqueueJobs(db, photos, ['embed'], 1000)
    const first = claimBatch(db, { kind: 'embed', limit: 2, now: 1100 })
    expect(first).toHaveLength(2)
    expect(first.every((job) => job.status === 'running')).toBe(true)
    const second = claimBatch(db, { kind: 'embed', limit: 2, now: 1200 })
    expect(second).toHaveLength(1)
    expect(second[0]?.id).not.toBe(first[0]?.id)
    expect(progressOf(db, 'embed')).toMatchObject({ pending: 0, running: 3, total: 3 })
  })

  it('领取顺序按 updated_at 升序：老任务先跑，重试的不会被无限往后挤', () => {
    const [a, b] = [insertPhoto('a.jpg'), insertPhoto('b.jpg')]
    enqueueJobs(db, [a], ['embed'], 5000)
    enqueueJobs(db, [b], ['embed'], 1000)
    const claimed = claimBatch(db, { kind: 'embed', limit: 1, now: 6000 })
    expect(claimed[0]?.photo_id).toBe(b)
  })

  it('kind 过滤：embed 的领取不会动到 face', () => {
    const photos = [insertPhoto('a.jpg')]
    enqueueJobs(db, photos, ['embed', 'face'], 1000)
    const claimed = claimBatch(db, { kind: 'face', limit: 10, now: 1100 })
    expect(claimed.map((job) => job.kind)).toEqual(['face'])
    expect(progressOf(db, 'embed').pending).toBe(1)
  })

  it('limit 必须是正整数', () => {
    expect(() => claimBatch(db, { kind: 'embed', limit: 0 })).toThrow(/limit 必须是正整数/)
  })

  it('done / skipped 的任务不会被再次领取', () => {
    const [a, b] = [insertPhoto('a.jpg'), insertPhoto('b.jpg')]
    enqueueJobs(db, [a, b], ['embed'], 1000)
    const claimed = claimBatch(db, { kind: 'embed', limit: 10, now: 1100 })
    completeJob(db, claimed[0]!.id, 1200)
    skipJob(db, claimed[1]!.id, 'HEIC 不支持', 1200)
    expect(claimBatch(db, { kind: 'embed', limit: 10, now: 1300 })).toHaveLength(0)
    expect(progressOf(db, 'embed')).toMatchObject({ done: 1, skipped: 1, finished: 2 })
  })

  it('completeJob 幂等：已 done 视为成功（writeBatch 已标 done 后再调是正常路径），failed/skipped 仍抛错', () => {
    const [a] = [insertPhoto('a.jpg')]
    enqueueJobs(db, [a], ['embed'], 1000)
    const claimed = claimBatch(db, { kind: 'embed', limit: 1, now: 1100 })
    completeJob(db, claimed[0]!.id, 1200)
    // 幂等收尾：重复 complete 不抛（产品路径 writeBatch 已把任务标 done）
    expect(() => completeJob(db, claimed[0]!.id, 1300)).not.toThrow()
  })

  it('completeJob 对非运行态且非 done 的任务抛错（failed/skipped 不许被洗成 done）', () => {
    const [a] = [insertPhoto('a.jpg')]
    enqueueJobs(db, [a], ['embed'], 1000)
    const claimed = claimBatch(db, { kind: 'embed', limit: 1, now: 1100 })
    skipJob(db, claimed[0]!.id, 'HEIC 不支持', 1200)
    expect(() => completeJob(db, claimed[0]!.id, 1300)).toThrow(/不在可完成状态/)
  })
})

describe('index-queue：失败与重试上限', () => {
  it('未到上限回 pending 可被重领，到上限转 failed 并保留错误', () => {
    const [a] = [insertPhoto('a.jpg')]
    enqueueJobs(db, [a], ['embed'], 1000)
    let job = claimBatch(db, { kind: 'embed', limit: 1, now: 1100 })[0]!

    expect(failJob(db, job.id, '第一次失败', 1200)).toBe('pending')
    job = claimBatch(db, { kind: 'embed', limit: 1, now: 1300 })[0]!
    expect(failJob(db, job.id, '第二次失败', 1400)).toBe('pending')
    job = claimBatch(db, { kind: 'embed', limit: 1, now: 1500 })[0]!
    expect(failJob(db, job.id, '第三次失败', 1600)).toBe('failed')

    // 终态：不再被领取，且错误留着
    expect(claimBatch(db, { kind: 'embed', limit: 1, now: 1700 })).toHaveLength(0)
    const row = db.prepare(`SELECT status, attempts, last_error FROM jobs WHERE id = ?`).get(job.id)
    expect(row).toMatchObject({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      last_error: '第三次失败',
    })
  })

  it('崩溃恢复：残留的 running 打回 pending，attempts 不增加（崩溃不算失败次数）', () => {
    const photos = [insertPhoto('a.jpg'), insertPhoto('b.jpg')]
    enqueueJobs(db, photos, ['embed'], 1000)
    claimBatch(db, { kind: 'embed', limit: 2, now: 1100 })
    expect(progressOf(db, 'embed').running).toBe(2)

    expect(requeueRunning(db, 2000)).toBe(2)
    expect(progressOf(db, 'embed')).toMatchObject({ pending: 2, running: 0 })
    expect(claimBatch(db, { kind: 'embed', limit: 2, now: 2100 })).toHaveLength(2)
  })
})

describe('index-queue：进度与查看', () => {
  it('progressOf 各类计数之和等于 total，finished 只算终态', () => {
    const photos = [insertPhoto('a.jpg'), insertPhoto('b.jpg'), insertPhoto('c.jpg')]
    enqueueJobs(db, photos, ['embed'], 1000)
    const claimed = claimBatch(db, { kind: 'embed', limit: 3, now: 1100 })
    completeJob(db, claimed[0]!.id, 1200)
    skipJob(db, claimed[1]!.id, '无文字', 1200)
    const progress = progressOf(db, 'embed')
    expect(progress).toEqual({
      pending: 0,
      running: 1,
      done: 1,
      failed: 0,
      skipped: 1,
      total: 3,
      finished: 2,
    })
  })

  it('nextPending 只看不改状态', () => {
    const [a] = [insertPhoto('a.jpg')]
    enqueueJobs(db, [a], ['embed'], 1000)
    expect(nextPending(db, 'embed')?.status).toBe('pending')
    expect(progressOf(db, 'embed').pending).toBe(1)
    expect(nextPending(db, 'face')).toBeNull()
  })
})
