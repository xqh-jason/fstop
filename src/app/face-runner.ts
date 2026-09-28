/**
 * 人脸流水线（M2）：领 `face` 任务 → 检测/对齐/识别 → 写 faces 表 + 人脸向量矩阵。
 *
 * **为什么不塞进 `index-runner.ts`**：那条路径是「一张照片 → 一条向量」的调优产物
 * （批内并发、每批 flush、槽位预留都按 1:1 设计）。人脸是 1:N（一张照片 0..N 张脸），
 * 硬塞会把两条语义搅在一起——项目红线是「同一语义不允许两份实现」，不是「所有流程合成一个
 * 函数」。可以复用的是**队列原语**（claim/complete/fail/skip、进度、崩溃恢复），这里全部复用。
 *
 * 人脸向量放在**独立的矩阵**里（`face-arcface-r100` space）：与人脸向量混进照片向量矩阵
 * 会让检索的槽位语义崩掉，也不利于「换人脸模型时单独重算」。
 */

import { clusterFaces, type FaceVector } from '../core/face-cluster'
import type { JobKind } from '../core/index-queue'
import { mapWithConcurrency, createSerialGate } from '../core/concurrency'
import type { VectorMatrix } from '../storage/vector-matrix'
import type { DbService } from '../storage/db.worker'
import type { FaceWorkerResult } from '../workers/face.worker'
import { decodePhoto, DEFAULT_DECODE_OPTIONS } from '../workers/decode'
import { FACE_DECODE_SIDE } from '../workers/face-preprocess'
import type { PhotoSource } from '../core/photo-source'

export interface FaceRunProgress {
  readonly total: number
  readonly done: number
  readonly failed: number
  readonly skipped: number
  readonly pending: number
  readonly running: number
  readonly currentPath: string | null
  /** 已经写进库的人脸数（不是「照片数」——一张合照可能有 5 张脸） */
  readonly faces: number
  readonly phase: 'loading' | 'indexing' | 'clustering' | 'done' | 'cancelled' | 'failed'
  readonly error: string | null
}

export interface FaceRunResult {
  readonly processed: number
  readonly failed: number
  readonly skipped: number
  readonly faces: number
  readonly clusters: number
  readonly cancelled: boolean
}

export interface FaceRunnerOptions {
  readonly rootId: string
  readonly source: PhotoSource
  readonly db: DbService
  readonly face: {
    analyze(bitmap: ImageBitmap): Promise<FaceWorkerResult>
    /** 预加载模型（可选）：冷缓存时这一步要下载约 300 MB，必须先报「加载中」再开工 */
    init?(options?: { executionProviders?: readonly string[] }): Promise<unknown>
  }
  readonly vectors: VectorMatrix
  readonly modelId: string
  readonly onProgress?: (progress: FaceRunProgress) => void
  readonly signal?: AbortSignal
  readonly batchSize?: number
  /** 聚类阈值（余弦相似度）；默认见 `DEFAULT_FACE_THRESHOLD` */
  readonly threshold?: number
  /** 只跑流水线不重聚类（重跑单张照片时用） */
  readonly skipClustering?: boolean
}

export async function runFaces(options: FaceRunnerOptions): Promise<FaceRunResult> {
  const { source, db, face, vectors, modelId } = options
  const batchSize = options.batchSize ?? 4
  const kind: JobKind = 'face'
  const report = options.onProgress ?? (() => {})
  /** GPU 串行闸门（同一 ORT 会话不能并发 run，见批内注释） */
  const faceGate = createSerialGate()

  let state: FaceRunProgress = {
    total: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    running: 0,
    currentPath: null,
    faces: 0,
    phase: 'indexing',
    error: null,
  }
  const update = (patch: Partial<FaceRunProgress>): void => {
    state = { ...state, ...patch }
    report(state)
  }

  let processed = 0
  let failed = 0
  let skipped = 0

  try {
    await db.requeueRunning(Date.now())
    const enqueued = await db.enqueueFaceJobs(Date.now())
    void enqueued // 计数只用于日志；真正的进度从库里读（不存内存态）

    // 冷缓存时模型要下载约 300 MB：先明确报「加载中」，别让用户对着「识别中…」干等。
    // 同时把总量读出来（此前第一个批次跑完才刷新 total，界面会显示 0/0 —— 已修）。
    if (options.face.init !== undefined) {
      const progress = await db.faceProgress()
      update({ phase: 'loading', total: progress.total, pending: progress.pending })
      await options.face.init()
    }
    update({ phase: 'indexing' })

    for (;;) {
      if (options.signal?.aborted === true) {
        update({ phase: 'cancelled' })
        return resultOf(state, processed, failed, skipped, 0, true)
      }
      const jobs = await db.claimJobs(kind, batchSize, Date.now())
      if (jobs.length === 0) break

      // 解码/读文件可以并发（吃 CPU，正好填 GPU 空档），但**推理必须串行**：
      // 同一个 ORT 会话不接受并发 run，并发提交会让标签页空转卡死（M1 已在嵌入路径上踩过，
      // 见 docs/BENCHMARKS.md「GPU 单会话」）。这里用同一把串行闸门把 GPU 那一段串起来。
      const outcomes = await mapWithConcurrency(jobs, 2, async (job) => {
        update({ currentPath: job.relPath })
        let blob: Blob
        try {
          blob = await source.read({ rootId: options.rootId, relPath: job.relPath })
        } catch (error) {
          await db.failJob(job.jobId, `read: ${messageOf(error)}`, Date.now())
          return 'failed' as const
        }
        let decoded: Awaited<ReturnType<typeof decodePhoto>>
        try {
          // 人脸链要的是**像素**，不是照片嵌入那套 512（理由见 FACE_DECODE_SIDE 注释）
          decoded = await decodePhoto(blob, {
            ...DEFAULT_DECODE_OPTIONS,
            embedSide: FACE_DECODE_SIDE,
          })
        } catch (error) {
          await db.skipJob(job.jobId, `decode: ${messageOf(error)}`, Date.now())
          return 'skipped' as const
        }

        try {
          const result = await faceGate(() => face.analyze(decoded.bitmap))
          decoded.bitmap.close()
          // 一张照片的人脸写一个事务：要么这批脸全进库，要么都不进（避免半张照片的人脸）
          const offsets: number[] = []
          for (const detection of result.faces) {
            offsets.push(await vectors.append(detection.embedding))
          }
          await db.writeFaces(
            result.faces.map((detection, index) => ({
              relPath: job.relPath,
              modelId,
              dim: detection.embedding.length,
              x1: detection.x1,
              y1: detection.y1,
              x2: detection.x2,
              y2: detection.y2,
              matrixOffset: offsets[index] as number,
            })),
          )
          await db.completeJob(job.jobId, Date.now())
          return 'done' as const
        } catch (error) {
          await db.failJob(job.jobId, `face: ${messageOf(error)}`, Date.now())
          return 'failed' as const
        }
      })

      for (const outcome of outcomes) {
        if (outcome === 'done') processed += 1
        if (outcome === 'failed') failed += 1
        if (outcome === 'skipped') skipped += 1
      }
      // 人脸向量也只在 flush 之后才对检索/聚类可见（M1 的 crswap 教训同样适用于这里）
      await vectors.flush()
      const progress = await db.faceProgress()
      update({
        total: progress.total,
        done: progress.done,
        failed: progress.failed,
        skipped: progress.skipped,
        pending: progress.pending,
        running: progress.running,
        faces: await db.countFaces(),
      })
    }

    let clusters = 0
    if (options.skipClustering !== true) {
      update({ phase: 'clustering', currentPath: null, faces: await db.countFaces() })
      clusters = await clusterAndPersist({
        db,
        vectors,
        modelId,
        threshold: options.threshold,
      })
    }

    const progress = await db.faceProgress()
    update({
      phase: 'done',
      currentPath: null,
      total: progress.total,
      done: progress.done,
      failed: progress.failed,
      skipped: progress.skipped,
      pending: progress.pending,
      running: progress.running,
      faces: await db.countFaces(),
    })
    return resultOf(state, processed, failed, skipped, clusters, false)
  } catch (error) {
    update({ phase: 'failed', error: messageOf(error) })
    throw error
  }
}

/**
 * 聚类并把分组落库。
 *
 * 语义提醒：**有名字的组不会被重算冲掉**。重算只重排「没名字的组」，用户命名的组按
 * `name` 保留成员（否则用户辛苦标的名字会被下一次「重新聚类」抹掉——这是最容易被骂的行为）。
 * 实现上：先按名字把已有分组冻结，再对剩下的人脸聚类，把新组写回。
 */
export async function clusterAndPersist(options: {
  db: DbService
  vectors: VectorMatrix
  modelId: string
  threshold?: number
}): Promise<number> {
  const { db, vectors, threshold } = options
  const faces = await db.listFaces()
  if (faces.length === 0) return 0

  // 命名过的组是**用户资产**：重算只重排无名组，有名字的组原样保留（否则用户辛苦标的名字
  // 会被下一次聚类抹掉，这是最容易被骂的行为）。
  const named = await db.listClusters()
  const keep = named.filter((cluster) => cluster.name !== null)
  const frozenFaceIds = new Set(keep.flatMap((cluster) => cluster.faceIds))
  for (const cluster of named) {
    if (cluster.name === null) await db.deleteCluster(cluster.clusterId)
  }

  const matrix = await vectors.snapshot()
  const dim = vectors.dim
  const slots = dim === 0 ? 0 : Math.floor(matrix.length / dim)
  const candidates: FaceVector[] = []
  for (const face of faces) {
    if (frozenFaceIds.has(face.faceId)) continue
    if (face.matrixOffset >= slots) continue
    const base = face.matrixOffset * dim
    candidates.push({ faceId: face.faceId, vector: matrix.slice(base, base + dim) })
  }

  const clusters = clusterFaces(candidates, threshold)
  let created = 0
  for (const cluster of clusters) {
    const clusterId = await db.createCluster(null)
    created += 1
    await db.setFaceClusters(cluster.faceIds.map((faceId) => ({ faceId, clusterId })))
    const cover = cluster.faceIds[0]
    if (cover !== undefined) await db.setClusterCover(clusterId, cover)
  }
  return created
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resultOf(
  state: FaceRunProgress,
  processed: number,
  failed: number,
  skipped: number,
  clusters: number,
  cancelled: boolean,
): FaceRunResult {
  return {
    processed,
    failed,
    skipped,
    faces: state.faces,
    clusters,
    cancelled,
  }
}
