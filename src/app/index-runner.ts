/**
 * 索引驱动 —— 把「扫描 → 判断 → 落库 → 逐条处理」串起来（M1）。
 *
 * 这一层刻意只做编排：判断在 `core/incremental-scan.ts`，写库在 `core/scan-apply.ts`，
 * 任务状态机在 `core/index-queue.ts`。于是「进度」不是内存里的计数器，而是**随时可以从库里查出来**的
 * ——这正是「不允许存在内存态的隐式进度」（docs/DESIGN.md）的意思：进程被杀掉，重启后
 * `requeueRunning` + 重新 `claimJobs` 就能接着算，不需要任何游标。
 */

import type { JobKind } from '../core/index-queue'
import type { ScanEntry } from '../core/incremental-scan'
import { planScan } from '../core/incremental-scan'
import type { PhotoSource } from '../core/photo-source'
import type { ClaimedJob, DbService } from '../storage/db.worker'
import { writeOpfsFile } from '../storage/opfs'
import type { VectorMatrix } from '../storage/vector-matrix'
import { createSerialGate, mapWithConcurrency } from '../core/concurrency'
import { DEFAULT_DECODE_OPTIONS, decodePhoto } from '../workers/decode'
import type { EmbedService } from '../workers/embed.worker'

export type IndexPhase =
  'idle' | 'scanning' | 'planning' | 'working' | 'done' | 'cancelled' | 'failed'

export interface IndexProgress {
  readonly phase: IndexPhase
  /** 已扫描的文件数（扫描阶段） */
  readonly scanned: number
  /** 队列总数与分布（工作阶段） */
  readonly total: number
  readonly done: number
  readonly failed: number
  readonly skipped: number
  readonly pending: number
  readonly running: number
  readonly inserted: number
  readonly moved: number
  readonly restored: number
  readonly reindexed: number
  readonly markedDeleted: number
  /** 正在处理哪张（界面上要能看出「卡在哪一步」） */
  readonly currentPath: string | null
  readonly error: string | null
}

export interface IndexRunnerOptions {
  readonly rootId: string
  readonly source: PhotoSource
  readonly db: DbService
  readonly embed: EmbedService
  readonly vectors: VectorMatrix
  readonly thumbs: FileSystemDirectoryHandle
  readonly modelId: string
  readonly dim: number
  readonly onProgress?: (progress: IndexProgress) => void
  readonly signal?: AbortSignal
  /** 一次领多少任务（docs/DESIGN.md：16–32 摊薄 postMessage 开销） */
  readonly batchSize?: number
  /**
   * 同时在飞的照片数（默认 3）。单张耗时几乎全在解码 + 嵌入两段计算上，串行时 GPU/CPU 互相空转；
   * 实测并发 3 即可把产品路径从 10.9 张/秒提到约 17 张/秒（对齐基准页），再高只会让队列互抢。
   */
  readonly concurrency?: number
  readonly kind?: JobKind
}

export interface IndexRunResult {
  readonly scanned: number
  readonly inserted: number
  readonly moved: number
  readonly restored: number
  readonly reindexed: number
  readonly markedDeleted: number
  readonly processed: number
  readonly failed: number
  readonly skipped: number
  readonly cancelled: boolean
}

const REPORT_EVERY = 25

export async function runIndex(options: IndexRunnerOptions): Promise<IndexRunResult> {
  const { source, db, embed, vectors, thumbs, modelId, dim } = options
  const kind: JobKind = options.kind ?? 'embed'
  const batchSize = options.batchSize ?? 16
  const report = options.onProgress ?? (() => {})
  const embedGate = createSerialGate()

  let state: IndexProgress = {
    phase: 'scanning',
    scanned: 0,
    total: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    running: 0,
    inserted: 0,
    moved: 0,
    restored: 0,
    reindexed: 0,
    markedDeleted: 0,
    currentPath: null,
    error: null,
  }
  const update = (patch: Partial<IndexProgress>): void => {
    state = { ...state, ...patch }
    report(state)
  }

  try {
    // ——— 1. 扫描：只拿元数据 + 内容哈希，不读原图 ———
    const entries: ScanEntry[] = []
    for await (const ref of source.list()) {
      if (options.signal?.aborted === true) {
        update({ phase: 'cancelled' })
        return resultOf(state, 0, true)
      }
      const stat = await source.stat(ref)
      entries.push({
        relPath: ref.relPath,
        size: stat.size,
        mtime: stat.mtime,
        // 来源给不出哈希时才回落到读取（FSA/OPFS 都能廉价给出）
        contentHash: stat.hash ?? '',
      })
      if (entries.length % REPORT_EVERY === 0)
        update({ scanned: entries.length, currentPath: ref.relPath })
    }
    update({ scanned: entries.length, currentPath: null })

    // 来源没给哈希（例如未来的网络来源）→ 读一次补上。**不能在扫描里读整图**，所以只补缺的。
    for (const entry of entries) {
      if (entry.contentHash !== '') continue
      const ref = { rootId: options.rootId, relPath: entry.relPath }
      const { contentHashOf } = await import('../core/content-hash')
      entries[entries.indexOf(entry)] = {
        ...entry,
        contentHash: await contentHashOf(await source.read(ref)),
      }
    }

    // ——— 2. 判断 + 落库（纯函数判断，SQL 在 core 里，整段一个事务）———
    update({ phase: 'planning' })
    const known = await db.knownPhotos()
    const plan = planScan(entries, known)
    const applied = await db.applyScan(plan, Date.now())
    update({
      inserted: applied.inserted,
      moved: applied.moved,
      restored: applied.restored,
      reindexed: applied.reindexed,
      markedDeleted: applied.markedDeleted,
    })

    // ——— 3. 处理任务：崩溃恢复 → 领批 → 逐条 → 记账 ———
    // 上次没跑完的 running 打回 pending（进程被杀时留下的状态）
    await db.requeueRunning(Date.now())
    update({ phase: 'working' })

    // 只记「这轮处理了多少张」；failed/skipped 一律以库里的计数为准（不存内存态进度）
    let processed = 0
    // GPU 只有一个会话：并发提交只会互相排队，所以串行
    for (;;) {
      if (options.signal?.aborted === true) {
        update({ phase: 'cancelled' })
        return resultOf(state, processed, true)
      }
      const jobs = await db.claimJobs(kind, batchSize, Date.now())
      if (jobs.length === 0) break
      // 批内并发（默认 3）：单张的瓶颈在计算，串行会让 GPU/CPU 轮流空转，实测慢 1.6×。
      // 并发安全的前提两条，都已成立：向量槽位**同步预留**（不会算出同一槽位）、
      // 数据库写入**串行化**（单连接不能并发 BEGIN）。
      const outcomes = await mapWithConcurrency(
        jobs,
        options.concurrency ?? 3,
        async (job): Promise<'done' | 'failed' | 'skipped'> => {
          update({ currentPath: job.relPath })
          return processOne(job)
        },
      )
      for (const outcome of outcomes) {
        if (outcome === 'done') processed += 1
      }
      // 一批写完就把向量提交落盘：未提交的写入只落在 OPFS 的 .crswap 里，
      // 检索侧读不到（实测：「库内 N 张、已落盘 0 张」）。摊薄到每批一次。
      await vectors.flush()
      const progress = await db.progress()
      update({
        total: progress.total,
        done: progress.done,
        failed: progress.failed,
        skipped: progress.skipped,
        pending: progress.pending,
        running: progress.running,
      })
    }

    const progress = await db.progress()
    update({
      phase: 'done',
      currentPath: null,
      total: progress.total,
      done: progress.done,
      failed: progress.failed,
      skipped: progress.skipped,
      pending: progress.pending,
      running: progress.running,
    })
    return resultOf(state, processed, false)
  } catch (error) {
    update({ phase: 'failed', error: error instanceof Error ? error.message : String(error) })
    throw error
  }

  async function processOne(job: ClaimedJob): Promise<'done' | 'failed' | 'skipped'> {
    const now = () => Date.now()
    let blob: Blob
    try {
      blob = await source.read({ rootId: options.rootId, relPath: job.relPath })
    } catch (error) {
      // 读不到 = 可能是移动盘拔了/权限被撤：**重试**（不是跳过），由状态机计次数
      await db.failJob(job.jobId, `read: ${messageOf(error)}`, now())
      return 'failed'
    }

    let decoded: Awaited<ReturnType<typeof decodePhoto>>
    try {
      decoded = await decodePhoto(blob, DEFAULT_DECODE_OPTIONS)
    } catch (error) {
      // 解不开 = 格式不支持（或文件损坏）：**跳过**，不是失败。重试多少次也解不开。
      await db.skipJob(job.jobId, `decode: ${messageOf(error)}`, now())
      return 'skipped'
    }

    try {
      // 嵌入必须串行（GPU 单会话）：并发提交会让标签页空转卡死，实测过。
      // 闸门只串住 GPU 这一段，读文件/解码/缩略图/入库仍然并发，填满 GPU 的空档。
      const vector = await embedGate(
        () => embed.embedImage(decoded.bitmap) as Promise<Float32Array>,
      )
      decoded.bitmap.close()

      // 缩略图用内容哈希命名：路径里可能有 '/'（OPFS 文件名不允许），而内容哈希天然唯一
      const thumbKey = `${job.contentHash}.jpg`
      await writeOpfsFile(thumbs, thumbKey, decoded.thumb)

      // 重算必须写回同一槽位（UNIQUE(model_id, matrix_offset) 与矩阵布局都要求这样）
      const offset =
        job.matrixOffset === null
          ? await vectors.append(vector)
          : (await vectors.writeAt(job.matrixOffset, vector), job.matrixOffset)

      await db.writeBatch([
        {
          relPath: job.relPath,
          ext: extensionOfPath(job.relPath),
          size: blob.size,
          mtime: job.mtime,
          contentHash: job.contentHash,
          width: decoded.width,
          height: decoded.height,
          thumbKey,
          modelId,
          dim,
          matrixOffset: offset,
        },
      ])
      await db.completeJob(job.jobId, now())
      return 'done'
    } catch (error) {
      await db.failJob(job.jobId, `embed: ${messageOf(error)}`, now())
      return 'failed'
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function extensionOfPath(relPath: string): string {
  const dot = relPath.lastIndexOf('.')
  return dot <= 0 ? '' : relPath.slice(dot + 1).toLowerCase()
}

function resultOf(state: IndexProgress, processed: number, cancelled: boolean): IndexRunResult {
  return {
    scanned: state.scanned,
    inserted: state.inserted,
    moved: state.moved,
    restored: state.restored,
    reindexed: state.reindexed,
    markedDeleted: state.markedDeleted,
    processed,
    failed: state.failed,
    skipped: state.skipped,
    cancelled,
  }
}
