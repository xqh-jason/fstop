<script setup lang="ts">
/**
 * 应用外壳（M1）：选文件夹 → 建立索引 → 一句话检索。
 *
 * **可自动化的通路**：原生目录选择器 `showDirectoryPicker` 无法被 Playwright 驱动，
 * 所以 `?root=opfs` 时改用 OPFS 合成根（与基准同一条通路）。
 * 这样「扫描 → 入库 → 逐条处理 → 检索」整条链路能被端到端跑一遍，
 * 而不是只有单测覆盖、产品路径靠手点。
 */
import * as Comlink from 'comlink'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { IndexProgress } from './index-runner'
import { runIndex } from './index-runner'
import { type SearchHit, searchPhotos } from './search'
import { detectCapabilities, type Capabilities } from '../shared/env'
import {
  DEFAULT_ROOT_KEY,
  asDirectoryHandle,
  ensurePermission,
  loadStoredRoot,
  permissionStateOf,
  pickPhotoFolder,
  supportsDirectoryPicker,
} from '../storage/folder-access'
import type { DbService } from '../storage/db.worker'
import { opfsDirectory, readOpfsFile } from '../storage/opfs'
import { OpfsPhotoSource } from '../storage/photo-source-opfs'
import { FileSystemAccessSource } from '../storage/photo-source-fsa'
import { HttpPhotoSource } from '../storage/photo-source-http'
import type { PhotoSource } from '../core/photo-source'
import { VectorMatrix } from '../storage/vector-matrix'
import { browserLockKeeper, PRIMARY_LOCK } from '../storage/tab-primary-browser'
import { electLeader, waitToPromote } from '../storage/tab-primary'
import type { EmbedService } from '../workers/embed.worker'
import CapabilityPanel from '../ui/CapabilityPanel.vue'
import {
  countUnknownTime,
  effectiveTime,
  orderResults,
  RESULT_ORDER_LABELS,
  type ResultOrder,
} from '../core/result-order'
import SimilarGroups from '../ui/SimilarGroups.vue'
import OfflinePanel from '../ui/OfflinePanel.vue'
import PeoplePanel from '../ui/PeoplePanel.vue'
import { FACE_RECOGNIZER } from '../storage/models'
import { runFaces, type FaceRunProgress } from './face-runner'
import { normalizeVector, splitCluster } from '../core/face-cluster'
import type { FaceService } from '../workers/face.worker'
import type { ClusterRow, FaceRow } from '../storage/db.worker'
import PhotoWall from '../ui/PhotoWall.vue'

const params = new URLSearchParams(location.search)
const ROOT_MODE = params.get('root') ?? 'fsa'
const OPFS_SEGMENTS = (params.get('opfs') ?? 'bench-corpus')
  .split('/')
  .filter((part) => part !== '')
const TOP_K = Number(params.get('topk') ?? 24)

const capabilities = ref<Capabilities | null>(null)

// ——— 人脸状态（M2）———
const faces = ref<readonly FaceRow[]>([])
const clusters = ref<readonly ClusterRow[]>([])
/** 是否跑过人脸识别：区分「没跑」与「跑完一张脸都没有」 */
const faceRan = ref(false)
const facing = ref(false)
const faceStatus = ref<string | null>(null)
/** 离线面板要的本机数据（照片/向量/缩略图/向量矩阵字节数）——按需复查，不在渲染里遍历目录 */
const localStats = ref<{
  photos: number
  embeddings: number
  thumbFiles: number
  thumbBytes: number
  vectorBytes: number
} | null>(null)

/**
 * 统计本机数据占用。缩略图目录要逐个 `getFile()` 拿大小（OPFS 没有目录级体积查询），
 * 1 万张量级是几百毫秒到几秒，所以只在用户点「复查」或索引结束后调用一次，
 * 绝不放渲染路径里。
 */
async function refreshLocalStats(): Promise<void> {
  if (db === null) return
  try {
    const counts = await db.stats()
    let thumbFiles = 0
    let thumbBytes = 0
    if (thumbsDir !== null) {
      for await (const [, handle] of thumbsDir.entries()) {
        if (handle.kind !== 'file') continue
        thumbFiles += 1
        thumbBytes += (await handle.getFile()).size
      }
    }
    const slots = vectors === null ? 0 : await vectors.committedSlots()
    const dim = vectors === null ? 0 : vectors.dim
    localStats.value = {
      photos: counts.photos,
      embeddings: counts.embeddings,
      thumbFiles,
      thumbBytes,
      vectorBytes: slots * dim * Float32Array.BYTES_PER_ELEMENT,
    }
  } catch {
    localStats.value = null
  }
}
const supported = ref(supportsDirectoryPicker())
const rootLabel = ref<string | null>(null)
const permission = ref<'granted' | 'prompt' | 'denied' | 'none'>('none')
const indexing = ref(false)
/** 初始化（数据库 / 模型 / 向量矩阵）是否就绪。未就绪时索引按钮**必须**不可点： */
/** 实测踩过：按钮提前可点 → startIndex 里 vectors 还是 null → 弹出一句错误的「还没有可索引的文件夹」*/
const ready = ref(false)
const progress = ref<IndexProgress | null>(null)
const notice = ref<string | null>(null)

const query = ref('')
const searching = ref(false)
const hits = ref<readonly SearchHit[]>([])
/**
 * 结果排序（M2）：默认「按相似度」= 检索层的原始顺序，切到时间模式时**客户端重排**，
 * 不重新查库（重排只是重排，再跑一次检索既慢又会刷新相似度分数）。
 */
const order = ref<ResultOrder>('similarity')
const orderedHits = computed(() => orderResults(hits.value, order.value))
const unknownTime = computed(() =>
  order.value === 'similarity' ? 0 : countUnknownTime(hits.value),
)

/** 结果行上显示的时间：拍摄时间优先，缺了用文件时间；都没有就说不知道 */
function formatTime(hit: SearchHit): string {
  const time = effectiveTime(hit)
  if (time === null) return '时间未知'
  return new Date(time).toLocaleDateString('zh-CN')
}
const searchNote = ref<string | null>(null)
const thumbs = ref<Record<string, string>>({})

/** 照片墙（全部已索引照片，万张级虚拟滚动） */
const wallOpen = ref(false)
const wallPhotos = ref<readonly { photoId: number; relPath: string; thumbKey: string | null }[]>([])
const wallNote = ref<string | null>(null)

let db: DbService | null = null
let embed: EmbedService | null = null
let face: FaceService | null = null
let vectors: VectorMatrix | null = null
/** 人脸向量单独一个矩阵（space=face-arcface-r100）：与照片向量混存会让检索槽位语义崩掉 */
let faceVectors: VectorMatrix | null = null
let thumbsDir: FileSystemDirectoryHandle | null = null
/** 当前照片来源：真实目录（FSA）/ 合成根（自动化）/ 内置样例（HTTP，同源只读） */
let source: PhotoSource | null = null
/** 内置样例模式：UI 上要如实说明「你正在看的是内置样例，不是你的照片」 */
const samplesMode = ref(false)
/** 人物面板专用的人脸缩略图表（与照片墙的 `thumbs` 分开，理由见 refreshFaceThumbs） */
const faceThumbs = ref<Record<string, string>>({})
/** 当前生效的 rootId —— 不同来源不同根，别再各处重算（人脸流水线也曾算错一次） */
const SAMPLES_ROOT_KEY = 'bundled-samples'
function currentRootId(): string {
  if (samplesMode.value) return SAMPLES_ROOT_KEY
  return ROOT_MODE === 'opfs' ? 'opfs-corpus' : DEFAULT_ROOT_KEY
}
let modelId = ''
let dim = 0
let controller: AbortController | null = null

const progressText = computed(() => {
  const value = progress.value
  if (value === null) return ''
  if (value.phase === 'scanning') return `正在扫描… 已看到 ${value.scanned} 个文件`
  if (value.phase === 'planning') return '正在比对增量…'
  if (value.phase === 'working') {
    const finished = value.done + value.failed + value.skipped
    return `正在建立索引… ${finished}/${value.total}（跳过 ${value.skipped}、失败 ${value.failed}）`
  }
  if (value.phase === 'done')
    return `索引完成：${value.done} 张可检索（跳过 ${value.skipped}、失败 ${value.failed}）`
  if (value.phase === 'cancelled') return '已停止（下次打开会接着算）'
  if (value.phase === 'failed') return `出错了：${value.error ?? ''}`
  return ''
})

/** 本页是否持有主锁；从页只读、不给索引按钮 */
const isLeader = ref(true)
/** 主锁当前的释放函数（elect 拿到后替换，onUnmounted 调用） */
let releaseIfLeader: () => void = () => {}

onMounted(async () => {
  document.body.dataset.ready = 'false'
  capabilities.value = await detectCapabilities()
  await elect()
  document.body.dataset.ready = String(ready.value)
})

/** 页面卸载：abort 索引、关矩阵、放主锁（放锁是 follower 接管的前提） */
onUnmounted(() => {
  controller?.abort()
  void vectors?.close()
  releaseIfLeader()
})

/** 选主：抢到 → 主页走 boot；抢不到 → 只读从页，同时排队等接管 */
async function elect(): Promise<void> {
  try {
    const outcome = await electLeader(browserLockKeeper(), PRIMARY_LOCK)
    releaseIfLeader = outcome.releaseIfLeader
    if (outcome.role === 'leader') {
      isLeader.value = true
      await boot()
      return
    }
    isLeader.value = false
    notice.value = '另一个标签页正在管理索引，本页只读。关闭那个标签后本页会自动接管。'
    document.body.dataset.ready = 'true' // 从页界面是可用的（可搜索），不算初始化失败
    // 排队等接管：主页释放的瞬间本页重新走完整 boot（含 db worker）
    void waitToPromote(browserLockKeeper(), PRIMARY_LOCK, async () => {
      isLeader.value = true
      notice.value = null
      document.body.dataset.ready = 'false'
      await boot()
      document.body.dataset.ready = String(ready.value)
    })
  } catch (error) {
    // 没有 Web Locks 的环境（非 Chromium）：保持原行为，直接尝试 boot 让真实报错浮出来
    void error
    await boot()
  }
}

/**
 * 人脸流水线（M2）：跑识别 → 读回分组 → 刷新界面。
 */
async function runFacePipeline(): Promise<void> {
  if (db === null || face === null || vectors === null || faceVectors === null || source === null) {
    notice.value = '初始化还没完成，稍后再试'
    return
  }
  facing.value = true
  faceStatus.value = '正在加载人脸模型（首次约 300 MB）…'
  try {
    const rootId = currentRootId()
    const controller = new AbortController()
    await runFaces({
      rootId,
      source,
      db,
      face,
      vectors: faceVectors,
      modelId: FACE_RECOGNIZER.modelId,
      signal: controller.signal,
      onProgress: (progress: FaceRunProgress) => {
        faceStatus.value =
          progress.phase === 'loading'
            ? '正在加载人脸模型（首次约 300 MB，之后走浏览器缓存）…'
            : progress.phase === 'clustering'
              ? `正在聚类…已检出 ${String(progress.faces)} 张人脸`
              : `识别人脸 ${String(progress.done)}/${String(progress.total)}` +
                (progress.failed > 0 ? `（失败 ${String(progress.failed)}）` : '')
      },
    })
    await refreshFaceData()
    faceStatus.value = null
  } catch (error) {
    notice.value = `人脸识别中断：${error instanceof Error ? error.message : String(error)}`
    faceStatus.value = null
  } finally {
    facing.value = false
  }
}

async function refreshFaceData(): Promise<void> {
  if (db === null) return
  faces.value = await db.listFaces()
  clusters.value = await db.listClusters()
  // 「跑过没跑过」看任务表：跑完但一张脸都没检出时，faces 是空的，但那不等于「没跑过」
  const progress = await db.faceProgress()
  faceRan.value = faces.value.length > 0 || progress.total > 0
  void refreshLocalStats()
  await refreshFaceThumbs()
}

async function renameCluster(clusterId: number, name: string): Promise<void> {
  if (db === null) return
  await db.renameCluster(clusterId, name === '' ? null : name)
  await refreshFaceData()
}

/**
 * 合并两组：把来源组的成员搬到目标组，然后删掉来源组。
 * 保留目标组是刻意的——用户说「这两个是同一个人」时，期望留下的是他刚才写过名字的那一组。
 */
async function mergeClusters(fromClusterId: number, toClusterId: number): Promise<void> {
  if (db === null || faceVectors === null) return
  const from = clusters.value.find((cluster) => cluster.clusterId === fromClusterId)
  if (from === undefined) return
  await db.setFaceClusters(from.faceIds.map((faceId) => ({ faceId, clusterId: toClusterId })))
  await db.deleteCluster(fromClusterId)
  await refreshFaceData()
}

/** 拆分：把选中的脸交给 core 的 `splitCluster` 重新分组（不假设用户想分几组） */
async function splitSelected(clusterId: number, selectedIds: readonly number[]): Promise<void> {
  if (db === null || faceVectors === null) return
  const cluster = clusters.value.find((item) => item.clusterId === clusterId)
  if (cluster === undefined) return
  if (selectedIds.length === 0) return

  // 一次快照 + 按行切片：向量按 `matrixOffset * dim` 定位（与检索层同一套口径）
  const vectorsById = await faceVectorsOf(cluster.faceIds)
  const allVectors = await faceVectorsOf(faces.value.map((face) => face.faceId))
  const centroid = centroidFrom(
    cluster.faceIds.map((faceId) => allVectors.get(faceId)).filter(isVector),
  )

  const { remaining, moved } = splitCluster(
    { faceIds: cluster.faceIds, centroid },
    selectedIds,
    vectorsById,
  )
  if (remaining !== null) {
    await db.setFaceClusters(remaining.faceIds.map((faceId) => ({ faceId, clusterId })))
  }
  for (const group of moved) {
    const newId = await db.createCluster(null)
    await db.setFaceClusters(group.faceIds.map((faceId) => ({ faceId, clusterId: newId })))
    const cover = group.faceIds[0]
    if (cover !== undefined) await db.setClusterCover(newId, cover)
  }
  await refreshFaceData()
}

/** 取这批人脸在人脸矩阵里的向量（一次快照，按行切片） */
async function faceVectorsOf(faceIds: readonly number[]): Promise<Map<number, Float32Array>> {
  const result = new Map<number, Float32Array>()
  if (faceVectors === null) return result
  const matrix = await faceVectors.snapshot()
  const dim = faceVectors.dim
  if (dim === 0) return result
  const slots = Math.floor(matrix.length / dim)
  for (const faceId of faceIds) {
    const face = faces.value.find((item) => item.faceId === faceId)
    if (face === undefined || face.matrixOffset >= slots) continue
    result.set(faceId, matrix.slice(face.matrixOffset * dim, (face.matrixOffset + 1) * dim))
  }
  return result
}

function isVector(value: Float32Array | undefined): value is Float32Array {
  return value !== undefined
}

function centroidFrom(rows: readonly Float32Array[]): Float32Array {
  const dim = faceVectors?.dim ?? 512
  const sum = new Float32Array(dim)
  for (const row of rows) {
    for (let index = 0; index < dim; index += 1) sum[index] = (sum[index] ?? 0) + (row[index] ?? 0)
  }
  return normalizeVector(sum)
}

/**
 * 人物面板里的人脸裁切要用缩略图。
 *
 * **必须和照片墙/检索结果分开一张表**（实测踩过）：两者周期间完全不重叠 ——
 * 检索结果每次搜索都在换，人脸封面则相对稳定。早先共用一张 `thumbs`，而
 * `refreshThumbMap()` 每次都**用一个新对象整体替换**它（只放当前命中的 key），
 * 于是刚加进去的人脸 key 会被下一次检索/索引顺手冲掉，人物面板就剩下一片空白格子。
 * 一个 map 两个写者、还带替换语义，必然互相清空；分开之后谁也不动谁。
 */
async function refreshFaceThumbs(): Promise<void> {
  if (thumbsDir === null) return
  const next: Record<string, string> = {}
  for (const face of faces.value) {
    const key = face.thumbKey
    if (key === null || next[key] !== undefined) continue
    const blob = await readOpfsFile(thumbsDir, key)
    if (blob !== null) next[key] = URL.createObjectURL(blob)
  }
  // 旧 URL 要显式撤销：重跑人脸识别会换一批 key，不撤就是泄（照片墙那份也一样）
  for (const url of Object.values(faceThumbs.value)) URL.revokeObjectURL(url)
  faceThumbs.value = next
}

async function boot(): Promise<void> {
  try {
    const dbWorker = new Worker(new URL('../storage/db.worker.ts', import.meta.url), {
      type: 'module',
    })
    db = Comlink.wrap<DbService>(dbWorker)
    const embedWorker = new Worker(new URL('../workers/embed.worker.ts', import.meta.url), {
      type: 'module',
    })
    embed = Comlink.wrap<EmbedService>(embedWorker)
    const faceWorker = new Worker(new URL('../workers/face.worker.ts', import.meta.url), {
      type: 'module',
    })
    face = Comlink.wrap<FaceService>(faceWorker)

    const rootId = currentRootId()
    await db.open(rootId)

    if (ROOT_MODE === 'opfs') {
      source = new OpfsPhotoSource(rootId, OPFS_SEGMENTS) as unknown as FileSystemAccessSource
      rootLabel.value = `OPFS:${OPFS_SEGMENTS.join('/')}`
      permission.value = 'granted'
    } else {
      const stored = await loadStoredRoot()
      if (stored !== null) {
        rootLabel.value = stored.label
        permission.value = await permissionStateOf(stored.handle)
        if (permission.value === 'granted') {
          source = new FileSystemAccessSource(rootId, asDirectoryHandle(stored.handle))
        }
      }
    }

    const init = await embed.init({ device: 'webgpu' })
    modelId = init.modelId
    dim = init.dim
    vectors = await VectorMatrix.open(
      await opfsDirectory('fstop-vectors'),
      modelId.replace(/\//g, '_'),
      dim,
    )
    // 人脸向量矩阵按「固定空间名」开：换照片模型时人脸向量不该被牵连重算
    faceVectors = await VectorMatrix.open(
      await opfsDirectory('fstop-vectors'),
      'face-arcface-r100',
      FACE_RECOGNIZER.dim,
    )
    thumbsDir = await opfsDirectory('fstop-thumbs')
    await refreshThumbMap()
    // 人脸数据从库里读回：打开页面就能看到上次的聚类结果（不必重跑识别）
    await refreshFaceData()
    await refreshFaceThumbs()
    ready.value = true
  } catch (error) {
    notice.value = `初始化失败：${error instanceof Error ? error.message : String(error)}`
  }
}

async function chooseFolder(): Promise<void> {
  try {
    const stored = await pickPhotoFolder()
    rootLabel.value = stored.label
    permission.value = (await ensurePermission(stored.handle)) ? 'granted' : 'denied'
    source = new FileSystemAccessSource(DEFAULT_ROOT_KEY, asDirectoryHandle(stored.handle))
    notice.value = null
  } catch (error) {
    notice.value = `选择文件夹失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/** 恢复上次的目录需要用户手势（`requestPermission` 必须由手势触发） */
async function resumeFolder(): Promise<void> {
  const stored = await loadStoredRoot()
  if (stored === null) return
  const granted = await ensurePermission(stored.handle)
  permission.value = granted ? 'granted' : 'prompt'
  if (granted) {
    source = new FileSystemAccessSource(DEFAULT_ROOT_KEY, asDirectoryHandle(stored.handle))
    notice.value = null
  } else {
    notice.value = '浏览器要求你点一下「继续使用上次的文件夹」才给权限'
  }
}

/**
 * 试用内置样例（M3「打开即可体验」）。
 *
 * 用户不选目录也能先跑一遍索引与检索 —— 这是发布版第一屏最重要的东西：
 * 「这玩意儿到底是什么」不该要求先授权一个真实照片目录。
 * 样例来自 `public/samples/`（CC0 / 公有领域，见 NOTICE §4），同源 HTTP 读，只读不写。
 * 样例模式**不持久化**：刷新后回到「选目录」状态，避免用户误以为自己的照片被索引进去了。
 */
async function startSamples(): Promise<void> {
  if (indexing.value) return
  try {
    const samples = await HttpPhotoSource.openBundledSamples(SAMPLES_ROOT_KEY, location.origin)
    source = samples
    samplesMode.value = true
    notice.value = null
    rootLabel.value = `内置样例 · ${String(samples.count)} 张（public/samples，CC0）`
  } catch (error) {
    notice.value = `内置样例不可用：${error instanceof Error ? error.message : String(error)}`
    return
  }
  await startIndex()
}

async function startIndex(): Promise<void> {
  if (
    !ready.value ||
    source === null ||
    db === null ||
    embed === null ||
    vectors === null ||
    thumbsDir === null
  ) {
    // 分开报：未就绪与没选目录是两回事，混成一句会把人引到错的方向（E2E 首轮就被引偏过）
    notice.value = ready.value ? '还没有可索引的文件夹' : '还在初始化（模型与向量矩阵），稍等再试'
    return
  }
  indexing.value = true
  notice.value = null
  controller = new AbortController()
  try {
    await runIndex({
      rootId: currentRootId(),
      source,
      db,
      embed,
      vectors,
      thumbs: thumbsDir,
      modelId,
      dim,
      signal: controller.signal,
      onProgress: (value) => {
        progress.value = value
      },
    })
    await refreshThumbMap()
    // 索引刚写完一批缩略图与向量，顺手把离线面板的数字刷新到最新（这里不做轮询：
    // 目录级体积统计在 1 万张量级要几百毫秒，只在索引结束这种明确节点跑一次）
    await refreshLocalStats()
  } catch (error) {
    notice.value = `索引中断：${error instanceof Error ? error.message : String(error)}`
  } finally {
    indexing.value = false
    controller = null
  }
}

function stopIndex(): void {
  controller?.abort()
}

async function runSearch(): Promise<void> {
  if (db === null || embed === null || vectors === null) return
  searching.value = true
  try {
    const outcome = await searchPhotos({ db, embed, vectors, query: query.value, topK: TOP_K })
    hits.value = outcome.hits
    await refreshThumbMap(outcome.hits)
    searchNote.value =
      outcome.indexed === 0
        ? '索引还是空的——先选文件夹并建立索引'
        : `${outcome.elapsedMs} ms · 库内 ${outcome.indexed} 张` +
          (outcome.partial ? `（其中 ${outcome.ranked} 张已落盘，索引仍在进行）` : '')
  } catch (error) {
    searchNote.value = `检索失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    searching.value = false
  }
}

/**
 * 相似分组的数据源：照片墙行同样有 photoId/thumbKey，直接复用那一次 `searchRows()`；
 * 向量快照在分组按钮点击时才取（`SimilarGroups` 通过传出的 `takeSnapshot` 拿）。
 */
const similarThumbKeys = ref<Map<number, string | null>>(new Map())
const similarSnapshot = ref<{ photoIds: number[]; vectors: Float32Array[] } | null>(null)

/**
 * 打开照片墙：一次性取回全部已索引照片的轻量行（id/路径/缩略图键），
 * 图片本体由 PhotoWall 按可视窗口惰性读取 + LRU 回收。
 */
async function openWall(): Promise<void> {
  if (db === null) return
  wallNote.value = '正在读取照片列表…'
  try {
    const rows = await db.searchRows()
    wallPhotos.value = rows.map((row) => ({
      photoId: row.photoId,
      relPath: row.relPath,
      thumbKey: row.thumbKey,
    }))
    similarThumbKeys.value = new Map(
      rows.map((row) => [row.photoId, row.thumbKey satisfies string | null]),
    )
    similarSnapshot.value = await buildSimilarSnapshot(rows)
    wallOpen.value = true
    wallNote.value =
      rows.length === 0 ? '索引还是空的——先建立索引' : `共 ${rows.length} 张（仅渲染可视区域）`
  } catch (error) {
    wallNote.value = `读取照片列表失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/** 取回全部已落盘的视觉向量，与行序一一对齐（检索层同款读法，无第二份实现） */
async function buildSimilarSnapshot(
  rows: readonly { photoId: number; matrixOffset: number }[],
): Promise<{ photoIds: number[]; vectors: Float32Array[] } | null> {
  if (vectors === null || rows.length === 0) return null
  const matrix = await vectors.snapshot()
  // 维度可由模型信息直接推出；这里从矩阵与最大槽位反推，避免再传一个参数
  const maxOffset = rows.reduce((max, row) => Math.max(max, row.matrixOffset), 0)
  if (maxOffset < 0 || matrix.length === 0) return null
  const dimGuess = Math.round(matrix.length / (maxOffset + 1))
  if (dimGuess <= 0 || !Number.isInteger(dimGuess)) return null
  const photoIds: number[] = []
  const outVectors: Float32Array[] = []
  for (const row of rows) {
    const base = row.matrixOffset * dimGuess
    if (base + dimGuess > matrix.length) continue // 该向量尚未落盘
    photoIds.push(row.photoId)
    outVectors.push(matrix.slice(base, base + dimGuess))
  }
  return photoIds.length === 0 ? null : { photoIds, vectors: outVectors }
}

/** 照片墙的缩略图读取器（交给 PhotoWall 的缓存去管生命周期） */
async function loadWallThumb(key: string): Promise<Blob | null> {
  if (thumbsDir === null) return null
  return readOpfsFile(thumbsDir, key)
}

/** 缩略图从 OPFS 读出来做 objectURL；只读当前要显示的那些 */
async function refreshThumbMap(only?: readonly SearchHit[]): Promise<void> {
  if (thumbsDir === null) return
  const keys = (only ?? hits.value)
    .map((hit) => hit.thumbKey)
    .filter((key): key is string => key !== null)
  const next: Record<string, string> = {}
  for (const key of keys) {
    if (thumbs.value[key] !== undefined) {
      next[key] = thumbs.value[key]!
      continue
    }
    const blob = await readOpfsFile(thumbsDir, key)
    if (blob !== null) next[key] = URL.createObjectURL(blob)
  }
  thumbs.value = next
}
</script>

<template>
  <main class="shell">
    <header class="hero">
      <h1 class="hero__name">Fstop <span class="hero__cn">光圈</span></h1>
      <p class="hero__tagline">
        跑在桌面 Chromium 里的本地照片检索层。选定一个文件夹，索引在你自己设备上建立，
        之后用一句话找到任意一张照片——照片不复制、不上传、不安装任何东西。
      </p>
    </header>

    <CapabilityPanel :capabilities="capabilities" />
    <OfflinePanel :local="localStats" :on-refresh="refreshLocalStats" />
    <PeoplePanel
      :faces="faces"
      :clusters="clusters"
      :thumb-urls="faceThumbs"
      :ran="faceRan"
      :status="faceStatus"
      :busy="facing"
      :on-rename="renameCluster"
      :on-merge="mergeClusters"
      :on-split="splitSelected"
      :on-run="runFacePipeline"
    />

    <section class="card">
      <h2 class="card__title">照片文件夹</h2>
      <p v-if="rootLabel === null" class="hint">
        {{ supported ? '还没有选定文件夹。' : '这个浏览器不支持目录选择，需要桌面 Chromium。' }}
      </p>
      <p v-else class="hint">
        已选定 <code>{{ rootLabel }}</code>
        <span v-if="permission !== 'granted'" class="warn">（权限：{{ permission }}）</span>
      </p>
      <p v-if="samplesMode" class="hint">
        当前索引的是仓库自带的样例图片（不是你的照片）。样例可以在
        <code>public/samples/</code> 里换成你自己的。要索引自己的照片，点「选择文件夹」。
      </p>
      <div class="row">
        <button
          class="button button--ghost"
          :disabled="indexing || !ready || !supported"
          data-testid="try-samples"
          @click="startSamples"
        >
          先试用内置样例
        </button>
        <button v-if="supported" class="button" :disabled="indexing" @click="chooseFolder">
          选择文件夹
        </button>
        <button
          v-if="permission === 'prompt'"
          class="button"
          :disabled="indexing"
          @click="resumeFolder"
        >
          继续使用上次的文件夹
        </button>
        <button
          v-if="!indexing"
          class="button button--primary"
          :disabled="source === null || !isLeader"
          @click="startIndex"
        >
          {{ isLeader ? '建立索引' : '从标签页：只读' }}
        </button>
        <button v-else class="button" @click="stopIndex">停止</button>
      </div>
      <p v-if="progressText !== ''" class="status">{{ progressText }}</p>
      <p v-if="notice !== null" class="warn">{{ notice }}</p>
    </section>

    <section class="card">
      <h2 class="card__title">检索</h2>
      <form class="row" @submit.prevent="runSearch">
        <input
          v-model="query"
          class="input"
          type="search"
          placeholder="例如：雪地里的狗 / 夜晚的城市"
          :disabled="searching"
        />
        <button
          class="button button--primary"
          type="submit"
          :disabled="searching || query.trim() === ''"
        >
          {{ searching ? '检索中…' : '找照片' }}
        </button>
      </form>
      <p v-if="searchNote !== null" class="status">{{ searchNote }}</p>
      <div class="row">
        <button class="button" :disabled="db === null" @click="openWall">浏览全部照片</button>
        <button v-if="wallOpen" class="button" @click="wallOpen = false">收起照片墙</button>
      </div>
      <p v-if="wallNote !== null" class="status">{{ wallNote }}</p>
      <PhotoWall v-if="wallOpen" :photos="wallPhotos" :load-thumb="loadWallThumb" />
      <SimilarGroups
        v-if="isLeader"
        ref="similarRef"
        :thumb-keys="similarThumbKeys"
        :snapshot="similarSnapshot"
        :thumb-dir="thumbsDir"
      />
      <div v-if="hits.length > 0" class="sortbar">
        <label class="sortbar__label" for="result-order">排序</label>
        <select
          id="result-order"
          v-model="order"
          class="sortbar__select"
          data-testid="result-order"
        >
          <option v-for="(label, value) in RESULT_ORDER_LABELS" :key="value" :value="value">
            {{ label }}
          </option>
        </select>
        <span v-if="unknownTime > 0" class="sortbar__note">
          其中 {{ unknownTime }} 张没有时间信息（已排在最后）
        </span>
      </div>
      <ul class="results">
        <li v-for="hit in orderedHits" :key="hit.photoId" class="result">
          <img
            v-if="hit.thumbKey !== null && thumbs[hit.thumbKey] !== undefined"
            class="result__thumb"
            :src="thumbs[hit.thumbKey]"
            :alt="hit.relPath"
            loading="lazy"
          />
          <div v-else class="result__thumb result__thumb--empty" />
          <div class="result__meta">
            <span class="result__path">{{ hit.relPath }}</span>
            <span class="result__score">{{ hit.score.toFixed(3) }}</span>
            <span v-if="order !== 'similarity'" class="result__time">{{ formatTime(hit) }}</span>
          </div>
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.shell {
  /* 铺满宽度：46rem 会把照片墙和人物面板都挤成一列（实测反馈「展示太小」）。
     上限留给超宽屏，笔记本/普通显示器上就是整宽 + 内边距。 */
  max-width: 108rem;
  margin: 0 auto;
  padding: 3rem 2rem 6rem;
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.hero__name {
  margin: 0;
  font-size: 2.5rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.hero__cn {
  color: var(--accent);
}

.hero__tagline {
  margin: 1rem 0 0;
  max-width: 36rem;
  color: var(--text-dim);
  line-height: 1.7;
}

.card {
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.card__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.button {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  border-radius: 0.5rem;
  padding: 0.5rem 0.9rem;
  font: inherit;
  cursor: pointer;
}

.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.button--primary {
  border-color: var(--accent);
  color: var(--accent);
}

.input {
  flex: 1 1 16rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: transparent;
  color: var(--text);
  padding: 0.5rem 0.75rem;
  font: inherit;
}

.hint,
.status {
  margin: 0;
  color: var(--text-dim);
  font-size: 0.875rem;
  line-height: 1.6;
}

.warn {
  margin: 0;
  color: var(--warn, #ffb020);
  font-size: 0.875rem;
}

.sortbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.75rem 0 0.5rem;
  font-size: 0.85rem;
}
.sortbar__select {
  padding: 0.2rem 0.4rem;
  border-radius: 6px;
  border: 1px solid rgba(128, 128, 128, 0.4);
  background: transparent;
  color: inherit;
}
.sortbar__note {
  opacity: 0.7;
}
.result__time {
  opacity: 0.7;
  margin-left: 0.4rem;
}
.results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
  gap: 0.75rem;
}

.result {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.result__thumb {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 0.5rem;
  background: rgba(255, 255, 255, 0.04);
}

.result__thumb--empty {
  border: 1px dashed var(--border);
}

.result__meta {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.75rem;
  color: var(--text-dim);
}

.result__path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
