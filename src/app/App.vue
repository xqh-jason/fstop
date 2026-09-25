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
import { VectorMatrix } from '../storage/vector-matrix'
import { browserLockKeeper, PRIMARY_LOCK } from '../storage/tab-primary-browser'
import { electLeader, waitToPromote } from '../storage/tab-primary'
import type { EmbedService } from '../workers/embed.worker'
import CapabilityPanel from '../ui/CapabilityPanel.vue'
import PhotoWall from '../ui/PhotoWall.vue'

const params = new URLSearchParams(location.search)
const ROOT_MODE = params.get('root') ?? 'fsa'
const OPFS_SEGMENTS = (params.get('opfs') ?? 'bench-corpus')
  .split('/')
  .filter((part) => part !== '')
const TOP_K = Number(params.get('topk') ?? 24)

const capabilities = ref<Capabilities | null>(null)
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
const searchNote = ref<string | null>(null)
const thumbs = ref<Record<string, string>>({})

/** 照片墙（全部已索引照片，万张级虚拟滚动） */
const wallOpen = ref(false)
const wallPhotos = ref<readonly { photoId: number; relPath: string; thumbKey: string | null }[]>([])
const wallNote = ref<string | null>(null)

let db: DbService | null = null
let embed: EmbedService | null = null
let vectors: VectorMatrix | null = null
let thumbsDir: FileSystemDirectoryHandle | null = null
let source: FileSystemAccessSource | null = null
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

    const rootId = ROOT_MODE === 'opfs' ? 'opfs-corpus' : DEFAULT_ROOT_KEY
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
    thumbsDir = await opfsDirectory('fstop-thumbs')
    await refreshThumbMap()
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
      rootId: ROOT_MODE === 'opfs' ? 'opfs-corpus' : DEFAULT_ROOT_KEY,
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
    wallOpen.value = true
    wallNote.value =
      rows.length === 0 ? '索引还是空的——先建立索引' : `共 ${rows.length} 张（仅渲染可视区域）`
  } catch (error) {
    wallNote.value = `读取照片列表失败：${error instanceof Error ? error.message : String(error)}`
  }
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

    <section class="card">
      <h2 class="card__title">照片文件夹</h2>
      <p v-if="rootLabel === null" class="hint">
        {{ supported ? '还没有选定文件夹。' : '这个浏览器不支持目录选择，需要桌面 Chromium。' }}
      </p>
      <p v-else class="hint">
        已选定 <code>{{ rootLabel }}</code>
        <span v-if="permission !== 'granted'" class="warn">（权限：{{ permission }}）</span>
      </p>
      <div class="row">
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
      <ul class="results">
        <li v-for="hit in hits" :key="hit.photoId" class="result">
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
          </div>
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.shell {
  max-width: 46rem;
  margin: 0 auto;
  padding: 4rem 1.5rem 6rem;
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
