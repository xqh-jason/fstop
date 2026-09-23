import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../../src/core/model'
import { MIGRATIONS, applyMigrations, type Migration } from '../../src/storage/migrations'

let db: DatabaseSync

function insertRoot(handleKey = 'photos'): number {
  db.prepare(
    `INSERT INTO roots (handle_key, label, permission_state) VALUES (?, ?, 'granted')`,
  ).run(handleKey, '照片')
  const row = db.prepare('SELECT id FROM roots WHERE handle_key = ?').get(handleKey)
  return Number(row?.id)
}

function insertPhoto(rootId: number, relPath = '2024/a.jpg'): number {
  db.prepare(
    `INSERT INTO photos (root_id, rel_path, ext, size, mtime, content_hash)
     VALUES (?, ?, 'jpg', 1024, 1700000000000, 'hash-1')`,
  ).run(rootId, relPath)
  const row = db
    .prepare('SELECT id FROM photos WHERE root_id = ? AND rel_path = ?')
    .get(rootId, relPath)
  return Number(row?.id)
}

function tableNames(): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
  return rows.map((row) => String(row.name))
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  // 打开方必须开启外部键约束（见 src/core/model.ts 的约定）
  db.exec('PRAGMA foreign_keys = ON')
})

afterEach(() => {
  db.close()
})

describe('schema v1 的真实执行结果', () => {
  beforeEach(() => {
    applyMigrations(db, 0)
  })

  it('建出 §7.6 定义的全部七张表', () => {
    expect(tableNames()).toEqual([
      'clusters',
      'embeddings',
      'faces',
      'jobs',
      'meta',
      'photos',
      'roots',
    ])
  })

  it('meta 恒为单行且记录当前 schema 版本', () => {
    expect(db.prepare('SELECT schema_version FROM meta').get()?.schema_version).toBe(SCHEMA_VERSION)
    expect(() =>
      db.exec(`INSERT INTO meta (id, schema_version, created_at) VALUES (2, 1, 0)`),
    ).toThrow()
  })

  it('photos 以 (root_id, rel_path) 为身份，同一张照片不会插入两次', () => {
    const rootId = insertRoot()
    insertPhoto(rootId)
    expect(() => insertPhoto(rootId)).toThrow()
  })

  it('photos 拒绝越界的 EXIF 方向，允许缺省', () => {
    const rootId = insertRoot()
    const photoId = insertPhoto(rootId)
    expect(() => db.exec(`UPDATE photos SET exif_orientation = 9 WHERE id = ${photoId}`)).toThrow()
    db.exec(`UPDATE photos SET exif_orientation = 6 WHERE id = ${photoId}`)
    expect(db.prepare('SELECT exif_orientation FROM photos').get()?.exif_orientation).toBe(6)
  })

  it('删除根目录会级联清掉照片与其任务', () => {
    const rootId = insertRoot()
    const photoId = insertPhoto(rootId)
    db.prepare(
      `INSERT INTO jobs (photo_id, kind, status, attempts, updated_at) VALUES (?, 'embed', 'pending', 0, 1)`,
    ).run(photoId)

    db.prepare('DELETE FROM roots WHERE id = ?').run(rootId)

    expect(db.prepare('SELECT count(*) AS n FROM photos').get()?.n).toBe(0)
    expect(db.prepare('SELECT count(*) AS n FROM jobs').get()?.n).toBe(0)
  })

  it('jobs 每个 (photo, kind) 只有一行，状态受 CHECK 约束', () => {
    const photoId = insertPhoto(insertRoot())
    const insertJob = db.prepare(
      `INSERT INTO jobs (photo_id, kind, status, attempts, updated_at) VALUES (?, 'embed', ?, 0, 1)`,
    )
    insertJob.run(photoId, 'pending')
    expect(() => insertJob.run(photoId, 'pending')).toThrow()
    expect(() => insertJob.run(photoId, 'bogus')).toThrow()
  })

  it('embeddings 用槽位而非向量本体，且不同模型的向量空间互不干扰', () => {
    const photoId = insertPhoto(insertRoot())
    const insert = db.prepare(
      `INSERT INTO embeddings (photo_id, model_id, dim, matrix_offset) VALUES (?, ?, 512, ?)`,
    )
    insert.run(photoId, 'Xenova/chinese-clip-vit-base-patch16', 0)
    // 同一模型同一照片只有一行
    expect(() => insert.run(photoId, 'Xenova/chinese-clip-vit-base-patch16', 1)).toThrow()
    // 同一模型的同一槽位不能被两张照片占用
    const otherPhotoId = insertPhoto(insertRoot('photos-2'), '2024/b.jpg')
    expect(() => insert.run(otherPhotoId, 'Xenova/chinese-clip-vit-base-patch16', 0)).toThrow()
    // 另一套模型（另一个向量空间）可以从槽位 0 重新开始
    insert.run(photoId, 'Xenova/clip-vit-base-patch32', 0)
    expect(db.prepare('SELECT count(*) AS n FROM embeddings').get()?.n).toBe(2)
  })

  it('faces 与 clusters 互相引用，删除人脸会解绑封面而不是删掉人物', () => {
    const photoId = insertPhoto(insertRoot())
    db.prepare(
      `INSERT INTO faces (photo_id, model_id, x1, y1, x2, y2, matrix_offset)
       VALUES (?, 'immich-app/antelopev2', 0.1, 0.1, 0.4, 0.4, 0)`,
    ).run(photoId)
    const faceId = Number(db.prepare('SELECT id FROM faces').get()?.id)

    db.prepare(`INSERT INTO clusters (name, cover_face_id) VALUES ('妈妈', ?)`).run(faceId)
    const clusterId = Number(db.prepare('SELECT id FROM clusters').get()?.id)
    db.prepare('UPDATE faces SET cluster_id = ? WHERE id = ?').run(clusterId, faceId)

    db.prepare('DELETE FROM faces WHERE id = ?').run(faceId)

    const cluster = db.prepare('SELECT name, cover_face_id FROM clusters').get()
    expect(cluster?.name).toBe('妈妈')
    expect(cluster?.cover_face_id).toBe(null)
  })
})

describe('迁移的事务边界', () => {
  const brokenChain: readonly Migration[] = [
    {
      version: 1,
      statements: [
        `CREATE TABLE meta (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           schema_version INTEGER NOT NULL,
           created_at INTEGER NOT NULL
         )`,
        'INSERT INTO meta (id, schema_version, created_at) VALUES (1, 0, 0)',
        'CREATE TABLE kept (a INTEGER)',
      ],
    },
    { version: 2, statements: ['CREATE TABLE dropped (a INTEGER)', 'THIS IS NOT SQL'] },
    { version: 3, statements: ['CREATE TABLE never (a INTEGER)'] },
  ]

  it('某个迁移失败时，该迁移整体回滚且后续迁移不再执行', () => {
    expect(() => applyMigrations(db, 0, brokenChain)).toThrow()

    expect(tableNames()).toEqual(['kept', 'meta'])
    expect(db.prepare('SELECT schema_version FROM meta').get()?.schema_version).toBe(1)
  })

  it('已迁移到当前版本的数据库重放时是空操作', () => {
    applyMigrations(db, 0)
    expect(applyMigrations(db, SCHEMA_VERSION)).toBe(SCHEMA_VERSION)
    expect(tableNames()).toContain('photos')
  })
})

describe('迁移链的内容', () => {
  it('只有 v1，且与代码期望的 schema 版本一致', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1])
    expect(SCHEMA_VERSION).toBe(1)
  })
})
