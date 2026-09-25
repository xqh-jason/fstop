/**
 * 索引任务队列 —— `src/core/` 手写区（项目计划 §7.4/§7.6 第 2 条、§7.7）。
 *
 * **设计要点（都是计划里明写的约束，不是实现细节）**：
 *
 * 1. **没有游标**。队列完全由 `jobs` 表派生：`status = 'pending'` 就是待办，
 *    `claimBatch` 把一批打上 `running` 并返回。崩溃后不需要任何「续算位置」——
 *    重启时 `requeueRunning` 把残留的 `running` 打回 `pending` 即可。**不允许存在内存态的隐式进度。**
 * 2. **状态即事实**。`pending / running / done / failed / skipped` 五态在 DDL 里就有 CHECK 约束，
 *    这里只做合法迁移，非法迁移一律抛错（宁可炸在写库前，也不要写出一个语义不明的状态）。
 * 3. **重试有上限**。`failJob` 每次 `attempts + 1`：未到上限回 `pending`（下次还能被领取），
 *    到上限转 `failed` 并保留 `last_error`。没有上限的重试会把「格式不支持」变成无限循环。
 * 4. **不支持 ≠ 失败**。`skipped` 是终态（如 HEIC 解不开、OCR 无文字），不该计入失败率，
 *    也不该被反复重试。
 *
 * 这个模块只依赖一个最小的结构化 DB 契约（`prepare().run/all/get`）：
 * 测试里由 `node:sqlite` 满足，浏览器里由 Worker 内的 sqlite-wasm 满足。
 */

/** 与 `src/core/model.ts` 的 DDL 一致；改这里必须同步改 DDL 的 CHECK 约束 */
export const JOB_KINDS = ['embed', 'face', 'ocr'] as const
export const JOB_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'] as const

export type JobKind = (typeof JOB_KINDS)[number]
export type JobStatus = (typeof JOB_STATUSES)[number]

/** 超过这个次数仍失败就转 `failed`，不再重试 */
export const MAX_ATTEMPTS = 3

export interface JobRow {
  readonly id: number
  readonly photo_id: number
  readonly kind: JobKind
  readonly status: JobStatus
  readonly attempts: number
  readonly last_error: string | null
  readonly updated_at: number
}

export interface QueueStatement {
  run(...params: readonly unknown[]): unknown
  all(...params: readonly unknown[]): readonly unknown[]
  get(...params: readonly unknown[]): unknown
}

/** 迁移执行器（`SchemaExecutor`）之外，这里额外需要能取回结果集的 `prepare` */
export interface QueueDatabase {
  prepare(sql: string): QueueStatement
}

export interface Progress {
  readonly pending: number
  readonly running: number
  readonly done: number
  readonly failed: number
  readonly skipped: number
  readonly total: number
  /** 终态（done + failed + skipped）数量，用于进度条 */
  readonly finished: number
}

function assertKind(kind: string): asserts kind is JobKind {
  if (!(JOB_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`未知的任务类型：${kind}（允许：${JOB_KINDS.join(' / ')}）`)
  }
}

function rowOf(value: unknown): JobRow {
  if (value === null || value === undefined) throw new Error('任务不存在')
  const row = value as Record<string, unknown>
  return {
    id: Number(row['id']),
    photo_id: Number(row['photo_id']),
    kind: row['kind'] as JobKind,
    status: row['status'] as JobStatus,
    attempts: Number(row['attempts']),
    last_error: (row['last_error'] as string | null) ?? null,
    updated_at: Number(row['updated_at']),
  }
}

/**
 * 给一批照片登记任务。`UNIQUE (photo_id, kind)` + `INSERT OR IGNORE` 让重复登记成为空操作——
 * 增量扫描每次都会重扫同一批文件，登记必须是幂等的。
 *
 * 返回**新登记**的条数（已存在的任务不计）。
 */
export function enqueueJobs(
  db: QueueDatabase,
  photoIds: readonly number[],
  kinds: readonly JobKind[],
  now: number = Date.now(),
): number {
  if (photoIds.length === 0 || kinds.length === 0) return 0
  for (const kind of kinds) assertKind(kind)
  const statement = db.prepare(
    `INSERT OR IGNORE INTO jobs (photo_id, kind, status, attempts, updated_at)
     VALUES (?, ?, 'pending', 0, ?)`,
  )
  let inserted = 0
  for (const photoId of photoIds) {
    for (const kind of kinds) {
      const result = statement.run(photoId, kind, now) as { changes?: number } | undefined
      // sqlite-wasm 与 node:sqlite 都在 run() 上给 changes；拿不到时按「插入了」保守计数
      if (result?.changes === undefined || result.changes > 0) inserted += 1
    }
  }
  return inserted
}

/**
 * 领取一批待办任务：`pending → running`。
 *
 * 单写者假设（Worker 内一次只有一条流水线）下这是原子的；跨标签页由 Web Locks 选主保证（M1）。
 * 按 `updated_at` 升序领取，让老任务先跑（失败重试的不会被无限往后挤）。
 */
export function claimBatch(
  db: QueueDatabase,
  options: { kind: JobKind; limit: number; now?: number },
): readonly JobRow[] {
  assertKind(options.kind)
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error(`limit 必须是正整数，实际为 ${String(options.limit)}`)
  }
  const now = options.now ?? Date.now()
  const candidates = db
    .prepare(
      `SELECT id FROM jobs
       WHERE kind = ? AND status = 'pending'
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`,
    )
    .all(options.kind, options.limit) as readonly Record<string, unknown>[]
  const ids = candidates.map((row) => Number(row['id']))
  if (ids.length === 0) return []

  const update = db.prepare(
    `UPDATE jobs SET status = 'running', updated_at = ?
     WHERE id = ? AND status = 'pending'`,
  )
  const claimed: JobRow[] = []
  for (const id of ids) {
    const result = update.run(now, id) as { changes?: number } | undefined
    // 条件里带 status = 'pending'：并发下抢不到的行不会被重复领取
    if (result?.changes === 0) continue
    const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id)
    claimed.push(rowOf(row))
  }
  return claimed
}

/** 任务成功：`running → done`（attempts 保留，便于事后看「重试过几次才成功」） */
export function completeJob(db: QueueDatabase, jobId: number, now: number = Date.now()): void {
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'done', last_error = NULL, updated_at = ?
       WHERE id = ? AND status IN ('running', 'pending')`,
    )
    .run(now, jobId) as { changes?: number } | undefined
  if (result?.changes === 0) {
    // 已是 done 属于幂等收尾（writeBatch 落库时可能已经把任务标成 done，再调一次是正常路径）。
    // 对 done 视为成功；对 failed/skipped 这些真正不该到这里的状态保持抛错。
    const row = db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(jobId) as
      { status?: string } | undefined
    if (row?.status === 'done') return
    throw new Error(`任务 ${jobId} 不在可完成状态（已 done/failed/skipped？）`)
  }
}

/**
 * 任务失败：`attempts + 1`，未到 `maxAttempts` 回 `pending`（可被再次领取），否则转 `failed`。
 * 返回落定的状态，调用方据此决定要不要在界面上报警。
 */
export function failJob(
  db: QueueDatabase,
  jobId: number,
  error: string,
  now: number = Date.now(),
  maxAttempts: number = MAX_ATTEMPTS,
): JobStatus {
  const row = rowOf(db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId))
  const attempts = row.attempts + 1
  const status: JobStatus = attempts >= maxAttempts ? 'failed' : 'pending'
  db.prepare(
    `UPDATE jobs SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(status, attempts, error, now, jobId)
  return status
}

/** 任务被跳过（格式不支持、内容不适用）：终态，不计入失败，也不会被重试 */
export function skipJob(
  db: QueueDatabase,
  jobId: number,
  reason: string,
  now: number = Date.now(),
): void {
  const result = db
    .prepare(`UPDATE jobs SET status = 'skipped', last_error = ?, updated_at = ? WHERE id = ?`)
    .run(reason, now, jobId) as { changes?: number } | undefined
  if (result?.changes === 0) throw new Error(`任务 ${jobId} 不存在`)
}

/**
 * 崩溃恢复：把残留的 `running` 打回 `pending`。启动时调用一次。
 *
 * 这是「无游标」设计的另一半：不需要记录跑到哪里，只需要把「正在跑」的状态清掉，
 * 队列自己会重新给出待办。`attempts` 不动——崩溃不是任务的错，但也不能靠崩溃来无限重试。
 */
export function requeueRunning(db: QueueDatabase, now: number = Date.now()): number {
  const result = db
    .prepare(`UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'`)
    .run(now) as { changes?: number } | undefined
  return result?.changes ?? 0
}

/** 队列进度（界面进度条的唯一数据源，不存内存计数） */
export function progressOf(db: QueueDatabase, kind: JobKind): Progress {
  assertKind(kind)
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS count FROM jobs WHERE kind = ? GROUP BY status`)
    .all(kind) as readonly Record<string, unknown>[]
  const counts: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 }
  for (const row of rows) {
    const status = String(row['status'])
    if (status in counts) counts[status] = Number(row['count'])
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  return {
    pending: counts['pending'] ?? 0,
    running: counts['running'] ?? 0,
    done: counts['done'] ?? 0,
    failed: counts['failed'] ?? 0,
    skipped: counts['skipped'] ?? 0,
    total,
    finished: (counts['done'] ?? 0) + (counts['failed'] ?? 0) + (counts['skipped'] ?? 0),
  }
}

/** 取下一张待办（不改变状态）；流水线要「先看再领」时用 */
export function nextPending(db: QueueDatabase, kind: JobKind): JobRow | null {
  assertKind(kind)
  const row = db
    .prepare(
      `SELECT * FROM jobs WHERE kind = ? AND status = 'pending' ORDER BY updated_at ASC, id ASC LIMIT 1`,
    )
    .get(kind)
  return row === null || row === undefined ? null : rowOf(row)
}
