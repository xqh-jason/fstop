/**
 * 数据库 Worker —— `opfs-sahpool` VFS，**单实例**（§7.3）。
 *
 * 选 `opfs-sahpool` 换来「任何静态托管都能部署」（不需要 COOP/COEP 响应头），
 * 代价是：同一 origin 的第二个实例会初始化失败，且不支持多连接。
 * 因此数据库只在这一个 Worker 里打开，标签页选主的责任在调用方（M1 用 Web Locks）。
 *
 * 迁移由 `src/storage/migrations.ts` 驱动，这里只负责「读版本、开事务、执行、写回版本」。
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import * as Comlink from 'comlink'
import { FRESH_DB_VERSION } from '../core/model'
import {
  type JobKind,
  type QueueDatabase,
  type QueueStatement,
  claimBatch,
  completeJob,
  enqueueJobs,
  failJob,
  progressOf,
  requeueRunning,
  skipJob,
} from '../core/index-queue'
import { type KnownPhoto, type ScanPlan } from '../core/incremental-scan'
import { applyScanPlan } from '../core/scan-apply'
import { applyMigrations } from '../storage/migrations'
import type { SchemaExecutor } from '../storage/migrations'

export interface PhotoWrite {
  readonly relPath: string
  readonly ext: string
  readonly size: number
  readonly mtime: number
  readonly contentHash: string
  readonly width: number
  readonly height: number
  readonly thumbKey: string
  readonly modelId: string
  readonly dim: number
  readonly matrixOffset: number
}

export interface DbOpenOptions {
  /** VFS 的 OPFS 目录名。不同目录 = 不同实例，可用于隔离测试（§7.3） */
  readonly directory?: string
}

export interface DbService {
  open(
    rootHandleKey: string,
    options?: DbOpenOptions,
  ): Promise<{
    schemaVersion: number
    applied: number
    rootId: number
  }>
  /** 一次 16–32 张，摊薄 postMessage 开销（§7.7） */
  writeBatch(rows: readonly PhotoWrite[]): Promise<void>
  stats(): Promise<{ photos: number; embeddings: number; jobs: number }>

  // ——— M1：队列驱动（状态机在 src/core/index-queue.ts，这里只做 SQL 适配）———

  /** 扫描器需要的「库里已知的照片」快照（判定用） */
  knownPhotos(): Promise<readonly KnownPhoto[]>
  /** 把一次扫描的计划落库（事务在 core 里）；返回各类计数 */
  applyScan(plan: ScanPlan, now: number): Promise<ReturnType<typeof applyScanPlan>>
  /** 领一批待办任务（pending → running），返回任务 + 照片信息 */
  claimJobs(kind: JobKind, limit: number, now: number): Promise<readonly ClaimedJob[]>
  completeJob(jobId: number, now: number): Promise<void>
  /** 失败一次：未到上限回 pending，到了转 failed（返回最终状态） */
  failJob(jobId: number, error: string, now: number): Promise<string>
  /** 跳过（不支持格式等），**不是失败** */
  skipJob(jobId: number, reason: string, now: number): Promise<void>
  /** 索引进度（只读 DB，不存内存计数） */
  progress(): Promise<ReturnType<typeof progressOf>>
  /** 崩溃恢复：把上次没跑完的 running 任务打回 pending（启动时调一次） */
  requeueRunning(now: number): Promise<number>
  /** 检索要用的行：活着且已有向量的照片 */
  searchRows(): Promise<readonly SearchRow[]>

  // ——— M2：人脸（一张照片 0..N 张脸，向量与照片向量分开存）———

  /** 登记人脸任务：给「还没有 face 任务」的活照片插 pending（重复调用不会重复插） */
  enqueueFaceJobs(now: number): Promise<number>
  /** 人脸任务的进度（与照片嵌入的进度分开数） */
  faceProgress(): Promise<ReturnType<typeof progressOf>>
  /** 写入一张照片的人脸：先删旧记录（重算语义），再插新行；返回新的 faceId（按入参顺序） */
  writeFaces(rows: readonly FaceWrite[]): Promise<readonly number[]>
  /** 全部人脸（含所属照片与分组），供界面与聚类用 */
  listFaces(): Promise<readonly FaceRow[]>
  /** 全部人脸分组 */
  listClusters(): Promise<readonly ClusterRow[]>
  /** 批量改人脸所属分组（聚类结果落库 / 拆分） */
  setFaceClusters(updates: readonly { faceId: number; clusterId: number | null }[]): Promise<void>
  /** 新建分组（返回新 id） */
  createCluster(name: string | null): Promise<number>
  renameCluster(clusterId: number, name: string | null): Promise<void>
  deleteCluster(clusterId: number): Promise<void>
  /** 设置分组封面（必须是该组成员；传 null 清空） */
  setClusterCover(clusterId: number, faceId: number | null): Promise<void>
  /** 人脸总数（0 = 还没跑过人脸识别，界面据此区分「没跑」与「跑完没人脸」） */
  countFaces(): Promise<number>
}

export interface SearchRow {
  readonly photoId: number
  readonly relPath: string
  readonly matrixOffset: number
  readonly thumbKey: string | null
  readonly width: number | null
  readonly height: number | null
  /** EXIF 拍摄时间（可能没有——不是所有照片都带 EXIF） */
  readonly takenAt: number | null
  /** 文件修改时间（总是有；「按时间」在缺 EXIF 时退回它） */
  readonly mtime: number | null
}

/** 一条领出来的任务：任务本身 + 处理它需要的照片信息 */
export interface ClaimedJob {
  readonly jobId: number
  readonly photoId: number
  readonly relPath: string
  readonly size: number
  readonly mtime: number
  readonly contentHash: string
  readonly attempts: number
  /** 已有向量槽位；null = 这张照片还没算过（重算时必须写回同一槽位） */
  readonly matrixOffset: number | null
}

/** 一条要领出来的人脸记录（重算时先按 photo 删旧行，所以不需要 offset 回写语义） */
export interface FaceWrite {
  readonly relPath: string
  readonly modelId: string
  readonly dim: number
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly matrixOffset: number
}

export interface FaceRow {
  readonly faceId: number
  readonly photoId: number
  readonly relPath: string
  readonly thumbKey: string | null
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly clusterId: number | null
  readonly matrixOffset: number
  readonly width: number | null
  readonly height: number | null
}

export interface ClusterRow {
  readonly clusterId: number
  readonly name: string | null
  readonly coverFaceId: number | null
  readonly faceIds: readonly number[]
}

interface StatementRunner {
  exec(sql: string): void
}

async function createService(options: DbOpenOptions = {}): Promise<DbService> {
  const sqlite3 = await sqlite3InitModule()
  // directory 必须自定义：默认目录名由 name 推导，而 SAH pool 的目录不允许被别的 VFS 复用
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: 'fstop',
    directory: options.directory ?? '.fstop-vfs',
  })
  const db = new pool.OpfsSAHPoolDb('/fstop.sqlite3')
  db.exec('PRAGMA foreign_keys = ON')

  const executor: SchemaExecutor & StatementRunner = { exec: (sql) => db.exec(sql) }
  const queue = queueAdapter(db as unknown as SqliteOo)
  let rootId = 0

  return {
    async open(handleKey) {
      const current = readSchemaVersion(db)
      const applied = applyMigrations(executor, current) - current
      db.exec({
        sql: `INSERT INTO roots (handle_key, label, permission_state) VALUES (?, ?, 'granted')
              ON CONFLICT (handle_key) DO NOTHING`,
        bind: [handleKey, handleKey],
      })
      rootId = Number(db.selectValue('SELECT id FROM roots WHERE handle_key = ?', [handleKey]))
      return { schemaVersion: readSchemaVersion(db), applied, rootId }
    },

    async writeBatch(rows) {
      if (rows.length === 0) return
      db.exec('BEGIN')
      try {
        for (const row of rows) {
          db.exec({
            sql: `INSERT INTO photos
                    (root_id, rel_path, ext, size, mtime, content_hash, width, height, thumb_key)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (root_id, rel_path) DO UPDATE SET
                    size = excluded.size, mtime = excluded.mtime, content_hash = excluded.content_hash,
                    width = excluded.width, height = excluded.height, thumb_key = excluded.thumb_key,
                    deleted_at = NULL`,
            bind: [
              rootId,
              row.relPath,
              row.ext,
              row.size,
              row.mtime,
              row.contentHash,
              row.width,
              row.height,
              row.thumbKey,
            ],
          })
          const photoId = Number(
            db.selectValue('SELECT id FROM photos WHERE root_id = ? AND rel_path = ?', [
              rootId,
              row.relPath,
            ]),
          )
          db.exec({
            sql: `INSERT INTO embeddings (photo_id, model_id, dim, matrix_offset) VALUES (?, ?, ?, ?)
                  ON CONFLICT (photo_id, model_id) DO UPDATE SET
                    dim = excluded.dim, matrix_offset = excluded.matrix_offset`,
            bind: [photoId, row.modelId, row.dim, row.matrixOffset],
          })
          db.exec({
            sql: `INSERT INTO jobs (photo_id, kind, status, attempts, updated_at) VALUES (?, 'embed', 'done', 1, ?)
                  ON CONFLICT (photo_id, kind) DO UPDATE SET status = 'done', attempts = 1, updated_at = excluded.updated_at`,
            bind: [photoId, Date.now()],
          })
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    async stats() {
      return {
        photos: Number(db.selectValue('SELECT count(*) FROM photos')),
        embeddings: Number(db.selectValue('SELECT count(*) FROM embeddings')),
        jobs: Number(db.selectValue('SELECT count(*) FROM jobs')),
      }
    },

    async knownPhotos() {
      return queue
        .prepare(
          `SELECT id, rel_path AS relPath, content_hash AS contentHash, deleted_at AS deletedAt
           FROM photos WHERE root_id = ?`,
        )
        .all(rootId) as readonly KnownPhoto[]
    },

    async applyScan(plan, now) {
      return applyScanPlan(queue, plan, { rootId, now })
    },

    async claimJobs(kind, limit, now) {
      const claimed = claimBatch(queue, { kind, limit, now })
      const rows: ClaimedJob[] = []
      for (const job of claimed) {
        const photo = queue
          .prepare(
            `SELECT rel_path AS relPath, size, mtime, content_hash AS contentHash,
                    (SELECT matrix_offset FROM embeddings WHERE embeddings.photo_id = photos.id
                     ORDER BY matrix_offset LIMIT 1) AS matrixOffset
             FROM photos WHERE id = ?`,
          )
          .get(job.photo_id) as
          | {
              relPath: string
              size: number
              mtime: number
              contentHash: string
              matrixOffset: number | null
            }
          | undefined
        if (photo === undefined) continue // 照片在领出后被删（ON DELETE CASCADE 会带走任务，这里只是兜底）
        rows.push({
          jobId: job.id,
          photoId: job.photo_id,
          relPath: photo.relPath,
          size: photo.size,
          mtime: photo.mtime,
          contentHash: photo.contentHash,
          attempts: job.attempts,
          matrixOffset: photo.matrixOffset === null ? null : Number(photo.matrixOffset),
        })
      }
      return rows
    },

    async completeJob(jobId, now) {
      completeJob(queue, jobId, now)
    },

    async failJob(jobId, error, now) {
      return failJob(queue, jobId, error, now)
    },

    async skipJob(jobId, reason, now) {
      skipJob(queue, jobId, reason, now)
    },

    async progress() {
      // M1 只排 embed 一种任务；等 face/ocr 接上时这里改成按 kind 汇总
      return progressOf(queue, 'embed')
    },

    async requeueRunning(now) {
      return requeueRunning(queue, now)
    },

    async searchRows() {
      return queue
        .prepare(
          `SELECT p.id AS photoId, p.rel_path AS relPath, e.matrix_offset AS matrixOffset,
                  p.thumb_key AS thumbKey, p.width AS width, p.height AS height,
                  p.taken_at AS takenAt, p.mtime AS mtime
           FROM photos p JOIN embeddings e ON e.photo_id = p.id
           WHERE p.deleted_at IS NULL
           ORDER BY e.matrix_offset`,
        )
        .all() as readonly SearchRow[]
    },

    // ——— M2：人脸 ———

    async enqueueFaceJobs(now) {
      // 只给「活照片」登记；`INSERT OR IGNORE` 让重复点击不会重置已完成的任务。
      // 想重算的人脸用「重跑」按钮走 requeueRunning / 显式重置，不靠重复登记。
      const photoIds = queue
        .prepare(`SELECT id AS photoId FROM photos WHERE deleted_at IS NULL`)
        .all() as readonly { photoId: number }[]
      return enqueueJobs(
        queue,
        photoIds.map((row) => row.photoId),
        ['face'],
        now,
      )
    },

    async faceProgress() {
      return progressOf(queue, 'face')
    },

    async writeFaces(rows) {
      if (rows.length === 0) return []
      const faceIds: number[] = []
      // 同一张照片**先删一次、再整批插入**。
      // 反面教训（实测踩过）：把 DELETE 放进逐行循环里，同一张照片的第 2 张脸会把刚插进去的
      // 第 1 张脸删掉 —— 一张 3 张脸的照片库里只剩 1 张，而且不报错（静默丢数据）。
      const byPhoto = new Map<string, typeof rows>()
      for (const row of rows) {
        const list = byPhoto.get(row.relPath) ?? []
        byPhoto.set(row.relPath, [...list, row])
      }
      db.exec('BEGIN')
      try {
        for (const [relPath, group] of byPhoto) {
          const photoId = Number(
            db.selectValue('SELECT id FROM photos WHERE rel_path = ? AND deleted_at IS NULL', [
              relPath,
            ]),
          )
          if (!Number.isFinite(photoId)) throw new Error(`人脸写入失败：照片不在库里 ${relPath}`)
          if (group.length === 0) continue
          db.exec({
            sql: `DELETE FROM faces WHERE photo_id = ? AND model_id = ?`,
            bind: [photoId, group[0]!.modelId],
          })
          for (const row of group) {
            db.exec({
              sql: `INSERT INTO faces (photo_id, model_id, x1, y1, x2, y2, cluster_id, matrix_offset)
                    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
              bind: [photoId, row.modelId, row.x1, row.y1, row.x2, row.y2, row.matrixOffset],
            })
            faceIds.push(Number(db.selectValue('SELECT last_insert_rowid()')))
          }
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return faceIds
    },

    async listFaces() {
      return queue
        .prepare(
          `SELECT f.id AS faceId, f.photo_id AS photoId, p.rel_path AS relPath,
                  p.thumb_key AS thumbKey, p.width AS width, p.height AS height,
                  f.x1 AS x1, f.y1 AS y1, f.x2 AS x2, f.y2 AS y2,
                  f.cluster_id AS clusterId, f.matrix_offset AS matrixOffset
           FROM faces f JOIN photos p ON p.id = f.photo_id
           WHERE p.deleted_at IS NULL
           ORDER BY f.id`,
        )
        .all() as readonly FaceRow[]
    },

    async listClusters() {
      const clusterRows = queue
        .prepare(
          `SELECT id AS clusterId, name AS name, cover_face_id AS coverFaceId FROM clusters ORDER BY id`,
        )
        .all() as readonly { clusterId: number; name: string | null; coverFaceId: number | null }[]
      const memberRows = queue
        .prepare(
          `SELECT cluster_id AS clusterId, id AS faceId FROM faces WHERE cluster_id IS NOT NULL ORDER BY id`,
        )
        .all() as readonly { clusterId: number; faceId: number }[]
      const members = new Map<number, number[]>()
      for (const row of memberRows) {
        const list = members.get(row.clusterId)
        if (list === undefined) members.set(row.clusterId, [row.faceId])
        else list.push(row.faceId)
      }
      return clusterRows.map((row) => ({
        clusterId: row.clusterId,
        name: row.name,
        coverFaceId: row.coverFaceId,
        faceIds: members.get(row.clusterId) ?? [],
      }))
    },

    async setFaceClusters(updates) {
      if (updates.length === 0) return
      db.exec('BEGIN')
      try {
        for (const update of updates) {
          db.exec({
            sql: `UPDATE faces SET cluster_id = ? WHERE id = ?`,
            bind: [update.clusterId, update.faceId],
          })
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    async createCluster(name) {
      db.exec({ sql: `INSERT INTO clusters (name, cover_face_id) VALUES (?, NULL)`, bind: [name] })
      return Number(db.selectValue('SELECT last_insert_rowid()'))
    },

    async renameCluster(clusterId, name) {
      db.exec({ sql: `UPDATE clusters SET name = ? WHERE id = ?`, bind: [name, clusterId] })
    },

    async deleteCluster(clusterId) {
      // faces.cluster_id 是 ON DELETE SET NULL：删组不删脸（脸的照片还该在「未分组」里找得到）
      db.exec({ sql: `DELETE FROM clusters WHERE id = ?`, bind: [clusterId] })
    },

    async setClusterCover(clusterId, faceId) {
      if (faceId !== null) {
        const owner = Number(db.selectValue('SELECT cluster_id FROM faces WHERE id = ?', [faceId]))
        if (owner !== clusterId) throw new Error('封面必须来自本组（否则界面会显示别人的脸）')
      }
      db.exec({
        sql: `UPDATE clusters SET cover_face_id = ? WHERE id = ?`,
        bind: [faceId, clusterId],
      })
    },

    async countFaces() {
      return Number(db.selectValue('SELECT count(*) FROM faces'))
    },
  }
}

/**
 * 把 sqlite-wasm 的 OO 接口适配成 `src/core/` 期望的 `prepare/run/all/get`。
 *
 * 为什么需要适配：`src/core/` 的状态机要能在 node 里用 `node:sqlite` 跑单测，
 * 所以它只依赖一个窄接口。适配层是**唯一**需要浏览器才能验证的部分，故意写薄。
 *
 * 列名交给 sqlite-wasm 自己解析（`selectObjects`）——**不要**从 SQL 文本里抠列名：
 * `src/core/` 里有 `SELECT *`，文本推断在那里必然出错。
 */
function queueAdapter(db: SqliteOo): QueueDatabase & { exec(sql: string): void } {
  return {
    exec: (sql) => db.exec(sql),
    prepare(sql): QueueStatement {
      return {
        run(...params: readonly unknown[]) {
          db.exec({ sql, bind: params })
          return {
            changes: Number(db.selectValue('SELECT changes()')),
            lastInsertRowid: Number(db.selectValue('SELECT last_insert_rowid()')),
          }
        },
        all(...params: readonly unknown[]) {
          return (db.selectObjects(sql, params) ?? []) as readonly unknown[]
        },
        get(...params: readonly unknown[]) {
          return db.selectObject(sql, params)
        },
      }
    },
  }
}

interface SqliteOo {
  exec(sql: unknown): unknown
  selectValue(sql: string, bind?: readonly unknown[]): unknown
  selectObject(sql: string, bind?: readonly unknown[]): unknown
  selectObjects(sql: string, bind?: readonly unknown[]): readonly unknown[]
}

function readSchemaVersion(db: { selectValue(sql: string): unknown }): number {
  try {
    const value = db.selectValue('SELECT schema_version FROM meta')
    return typeof value === 'number' ? value : FRESH_DB_VERSION
  } catch {
    // 还没有 meta 表 = 全新数据库
    return FRESH_DB_VERSION
  }
}

let service: Promise<DbService> | null = null

Comlink.expose({
  async open(handleKey: string, options?: DbOpenOptions) {
    return (service ??= createService(options ?? {})).then((instance) => instance.open(handleKey))
  },
  async writeBatch(rows: readonly PhotoWrite[]) {
    return (service ??= createService({})).then((instance) => instance.writeBatch(rows))
  },
  async stats() {
    return (service ??= createService({})).then((instance) => instance.stats())
  },
  async knownPhotos() {
    return (service ??= createService({})).then((instance) => instance.knownPhotos())
  },
  async applyScan(plan: ScanPlan, now: number) {
    return (service ??= createService({})).then((instance) => instance.applyScan(plan, now))
  },
  async claimJobs(kind: JobKind, limit: number, now: number) {
    return (service ??= createService({})).then((instance) => instance.claimJobs(kind, limit, now))
  },
  async completeJob(jobId: number, now: number) {
    return (service ??= createService({})).then((instance) => instance.completeJob(jobId, now))
  },
  async failJob(jobId: number, error: string, now: number) {
    return (service ??= createService({})).then((instance) => instance.failJob(jobId, error, now))
  },
  async skipJob(jobId: number, reason: string, now: number) {
    return (service ??= createService({})).then((instance) => instance.skipJob(jobId, reason, now))
  },
  async progress() {
    return (service ??= createService({})).then((instance) => instance.progress())
  },
  async requeueRunning(now: number) {
    return (service ??= createService({})).then((instance) => instance.requeueRunning(now))
  },
  async searchRows() {
    return (service ??= createService({})).then((instance) => instance.searchRows())
  },
  async enqueueFaceJobs(now: number) {
    return (service ??= createService({})).then((instance) => instance.enqueueFaceJobs(now))
  },
  async faceProgress() {
    return (service ??= createService({})).then((instance) => instance.faceProgress())
  },
  async writeFaces(rows: readonly FaceWrite[]) {
    return (service ??= createService({})).then((instance) => instance.writeFaces(rows))
  },
  async listFaces() {
    return (service ??= createService({})).then((instance) => instance.listFaces())
  },
  async listClusters() {
    return (service ??= createService({})).then((instance) => instance.listClusters())
  },
  async setFaceClusters(updates: readonly { faceId: number; clusterId: number | null }[]) {
    return (service ??= createService({})).then((instance) => instance.setFaceClusters(updates))
  },
  async createCluster(name: string | null) {
    return (service ??= createService({})).then((instance) => instance.createCluster(name))
  },
  async renameCluster(clusterId: number, name: string | null) {
    return (service ??= createService({})).then((instance) =>
      instance.renameCluster(clusterId, name),
    )
  },
  async deleteCluster(clusterId: number) {
    return (service ??= createService({})).then((instance) => instance.deleteCluster(clusterId))
  },
  async setClusterCover(clusterId: number, faceId: number | null) {
    return (service ??= createService({})).then((instance) =>
      instance.setClusterCover(clusterId, faceId),
    )
  },
  async countFaces() {
    return (service ??= createService({})).then((instance) => instance.countFaces())
  },
} satisfies DbService)
