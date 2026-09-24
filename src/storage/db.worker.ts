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
  }
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
} satisfies DbService)
