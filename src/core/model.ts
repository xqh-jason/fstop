/**
 * 数据模型 —— 见 docs/Fstop-光圈-项目计划-v0.2.md §7.6
 *
 * 本文件是数据模型的唯一真相源：**DDL 与行类型必须成对修改**，
 * 任何新增列都要同时改这里、`migrations/` 与 §7.6 的表格。
 *
 * 约定：
 * - 所有时间戳都是 epoch 毫秒（INTEGER）。
 * - 打开数据库的一方必须 `PRAGMA foreign_keys = ON`（外部键约束依赖它才生效）。
 * - 不存任何原始图像字节，只存路径、元数据、缩略图键与向量槽位。
 */

/** 代码期望的 schema 版本。与 `src/storage/migrations.ts` 的迁移链末端必须一致。 */
export const SCHEMA_VERSION = 1

/** 全新数据库（尚无 meta 表）的版本号，迁移从它开始。 */
export const FRESH_DB_VERSION = 0

export type RootId = number
export type PhotoId = number
export type FaceId = number
export type ClusterId = number

/** `meta` 恒为单行：用 CHECK 约束杜绝第二行。 */
export interface MetaRow {
  readonly schema_version: number
  readonly created_at: number
}

export type PermissionState = 'granted' | 'prompt' | 'denied'

export interface RootRow {
  readonly id: RootId
  /**
   * IndexedDB 中 `FileSystemDirectoryHandle` 的键。
   * 句柄本身不可序列化进 SQLite，因此这里只存键，句柄留在 IDB。
   */
  readonly handle_key: string
  readonly label: string
  readonly permission_state: PermissionState
}

export interface PhotoRow {
  readonly id: PhotoId
  readonly root_id: RootId
  /** 相对根目录的 POSIX 路径，在根内唯一。移动/重命名靠它 + content_hash 识别 */
  readonly rel_path: string
  /** 小写、不含点；无扩展名时为空串 */
  readonly ext: string
  readonly size: number
  /** epoch ms */
  readonly mtime: number
  /** size + 首尾各 64 KB 的哈希。跨盘复制、备份恢复后 mtime 全变，身份只能靠它 */
  readonly content_hash: string
  /** EXIF 拍摄时间，epoch ms；缺失为 null */
  readonly taken_at: number | null
  /** EXIF Orientation 1–8。必须在生成缩略图与向量**之前**应用，否则两者都是错的 */
  readonly exif_orientation: number | null
  readonly width: number | null
  readonly height: number | null
  /** OPFS 缩略图缓存中的键；未生成为 null */
  readonly thumb_key: string | null
  /** 非 null 表示文件已从磁盘消失。行保留，用于去重与恢复 */
  readonly deleted_at: number | null
}

/** 一个 (photo, kind) 只允许一行任务：这是 `UNIQUE (photo_id, kind)` 的语义。 */
export type JobKind = 'embed' | 'face' | 'ocr'

/**
 * - `pending`  待做
 * - `running`  进行中。进程崩溃会留下这个状态，启动时必须重置为 `pending`
 * - `done`     完成
 * - `failed`   失败，可重试；`attempts` 记录已试次数
 * - `skipped`  永久跳过（不支持的格式等），不再重试
 */
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface JobRow {
  readonly id: number
  readonly photo_id: PhotoId
  readonly kind: JobKind
  readonly status: JobStatus
  readonly attempts: number
  readonly last_error: string | null
  /** epoch ms */
  readonly updated_at: number
}

/**
 * 向量本体不在这里：存在 OPFS 的扁平 `Float32Array` 矩阵里，这里只存槽位。
 * `model_id` 是 `EmbeddingProvider.modelId`——**不同模型的向量空间不可混用**，
 * 原版 CLIP 与 Chinese-CLIP 的图像侧不在同一空间，因此是两个 `model_id`、两个矩阵。
 */
export interface EmbeddingRow {
  readonly photo_id: PhotoId
  readonly model_id: string
  readonly dim: number
  /** 该 `model_id` 对应矩阵中的槽位下标 */
  readonly matrix_offset: number
}

/** 检测框归一化到 [0,1]，相对**已应用 EXIF 方向**的图像。 */
export interface FaceRow {
  readonly id: FaceId
  readonly photo_id: PhotoId
  /** 人脸模型 id，与 `embeddings.model_id` 同义 */
  readonly model_id: string
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly cluster_id: ClusterId | null
  readonly matrix_offset: number
}

export interface ClusterRow {
  readonly id: ClusterId
  readonly name: string | null
  readonly cover_face_id: FaceId | null
}

/**
 * v1 建表语句，按顺序执行。
 *
 * 迁移执行器在跑完一个迁移后写 `meta.schema_version`，因此每个迁移都必须保证
 * `meta` 表存在——v1 负责创建它。
 * `clusters` 与 `faces` 互相引用，SQLite 允许前向引用（建表时只做语法解析），
 * 因此这里先建 `faces`、后建 `clusters` 是合法的。
 */
export const SCHEMA_DDL_V1: readonly string[] = [
  `CREATE TABLE meta (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     schema_version INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `INSERT INTO meta (id, schema_version, created_at)
     VALUES (1, ${FRESH_DB_VERSION}, CAST(strftime('%s', 'now') AS INTEGER) * 1000)`,

  `CREATE TABLE roots (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     handle_key TEXT NOT NULL UNIQUE,
     label TEXT NOT NULL,
     permission_state TEXT NOT NULL
       CHECK (permission_state IN ('granted', 'prompt', 'denied'))
   )`,

  `CREATE TABLE photos (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
     rel_path TEXT NOT NULL,
     ext TEXT NOT NULL,
     size INTEGER NOT NULL,
     mtime INTEGER NOT NULL,
     content_hash TEXT NOT NULL,
     taken_at INTEGER,
     exif_orientation INTEGER CHECK (exif_orientation BETWEEN 1 AND 8),
     width INTEGER,
     height INTEGER,
     thumb_key TEXT,
     deleted_at INTEGER,
     UNIQUE (root_id, rel_path)
   )`,
  `CREATE INDEX idx_photos_content_hash ON photos (content_hash)`,
  `CREATE INDEX idx_photos_live ON photos (root_id, deleted_at)`,

  `CREATE TABLE jobs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('embed', 'face', 'ocr')),
     status TEXT NOT NULL
       CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     updated_at INTEGER NOT NULL,
     UNIQUE (photo_id, kind)
   )`,
  // 任务队列完全由 `SELECT ... WHERE status = 'pending'` 派生，没有游标。
  `CREATE INDEX idx_jobs_queue ON jobs (status, kind, updated_at)`,

  `CREATE TABLE embeddings (
     photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
     model_id TEXT NOT NULL,
     dim INTEGER NOT NULL,
     matrix_offset INTEGER NOT NULL,
     PRIMARY KEY (photo_id, model_id),
     UNIQUE (model_id, matrix_offset)
   ) WITHOUT ROWID`,

  `CREATE TABLE faces (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
     model_id TEXT NOT NULL,
     x1 REAL NOT NULL,
     y1 REAL NOT NULL,
     x2 REAL NOT NULL,
     y2 REAL NOT NULL,
     cluster_id INTEGER REFERENCES clusters(id) ON DELETE SET NULL,
     matrix_offset INTEGER NOT NULL,
     UNIQUE (model_id, matrix_offset)
   )`,
  `CREATE INDEX idx_faces_photo ON faces (photo_id)`,
  `CREATE INDEX idx_faces_cluster ON faces (cluster_id)`,

  `CREATE TABLE clusters (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT,
     cover_face_id INTEGER REFERENCES faces(id) ON DELETE SET NULL
   )`,
]
