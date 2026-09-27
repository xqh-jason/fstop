<script setup lang="ts">
/**
 * 离线能力面板（M2）—— 「用户可以亲眼确认只有模型请求」。
 *
 * 这一屏不是装饰：它把三件事摆到用户面前
 * 1. **外发账本**：页面实际发过的请求按 host 分类（本机 / 模型 origin / 其它）。
 *    出现「其它」就红着显示，并把 host 点名——承诺不成立时不能悄悄藏起来。
 * 2. **本机占用**：`storage.estimate()` 的已用/配额 + 本机数据（照片、缩略图、向量矩阵）。
 * 3. **口径说明**：冷缓存下载权重是唯一允许的外发，且发生在模型 origin 上。
 *
 * 记账靠 `PerformanceObserver('resource')`：它看的是**浏览器实际发出的资源请求**，
 * 而不是我们自称会请求什么。诚实的边界写在模板下方（worker 内的请求不进页面时间线）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { summarizeEgress, type EgressSummary } from '../core/egress-ledger'

const props = defineProps<{
  /** 本机数据计数（照片 / 向量 / 缩略图），由 App 传入——面板不自己去翻库 */
  local: {
    photos: number
    embeddings: number
    thumbFiles: number
    thumbBytes: number
    vectorBytes: number
  } | null
  /** 触发一次本机数据复查（缩略图目录遍历可能要几百毫秒，按需跑） */
  onRefresh?: () => Promise<void>
}>()

const resources = ref<{ name: string }[]>([])
const usage = ref<{ usage: number; quota: number } | null>(null)
const refreshing = ref(false)
let observer: PerformanceObserver | null = null

function collect(): void {
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  resources.value = entries.map((entry) => ({ name: entry.name }))
}

async function refreshUsage(): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.storage?.estimate === undefined) return
  try {
    const estimate = await navigator.storage.estimate()
    usage.value = { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
  } catch {
    usage.value = null
  }
}

// 必须传自己的 origin（部署到静态站点后 app 自己的资源会被判成外部的，见 core/egress-ledger 注释）
const summary = computed<EgressSummary>(() =>
  summarizeEgress(resources.value, typeof location === 'undefined' ? undefined : location.origin),
)
const clean = computed(() => summary.value.violations.length === 0)

onMounted(() => {
  collect()
  void refreshUsage()
  // 增量观察：不依赖定时器，请求一发生就记一笔
  if (typeof PerformanceObserver !== 'undefined') {
    observer = new PerformanceObserver(() => {
      collect()
    })
    try {
      observer.observe({ type: 'resource', buffered: true })
    } catch {
      observer = null
    }
  }
})

onBeforeUnmount(() => observer?.disconnect())

async function recheck(): Promise<void> {
  refreshing.value = true
  try {
    collect()
    await refreshUsage()
    await props.onRefresh?.()
  } finally {
    refreshing.value = false
  }
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

const KIND_LABELS: Record<string, string> = {
  local: '本机',
  model: '模型 origin',
  external: '外部（不允许）',
}
</script>

<template>
  <section class="offline" aria-live="polite" data-testid="offline-panel">
    <h2 class="offline__title">离线能力</h2>

    <p class="offline__verdict" :data-clean="clean" data-testid="offline-verdict">
      <span aria-hidden="true">{{ clean ? '✓' : '✗' }}</span>
      {{
        clean
          ? '本会话没有向模型 origin 以外的任何主机发过请求'
          : `发现外部请求：${summary.violations.join('、')}`
      }}
    </p>

    <table class="offline__table">
      <thead>
        <tr>
          <th>主机</th>
          <th>类别</th>
          <th>次数</th>
          <th>示例路径</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in summary.entries" :key="entry.host" :data-kind="entry.kind">
          <td class="offline__host">{{ entry.host }}</td>
          <td>{{ KIND_LABELS[entry.kind] ?? entry.kind }}</td>
          <td class="offline__num">{{ entry.count }}</td>
          <td class="offline__sample">{{ entry.sample }}</td>
        </tr>
        <tr v-if="summary.entries.length === 0">
          <td colspan="4" class="offline__empty">还没有记录到任何请求</td>
        </tr>
      </tbody>
    </table>

    <dl class="offline__facts">
      <div>
        <dt>浏览器存储</dt>
        <dd>
          {{
            usage === null ? '未知' : `${formatBytes(usage.usage)} / ${formatBytes(usage.quota)}`
          }}
        </dd>
      </div>
      <div>
        <dt>已索引照片</dt>
        <dd>
          {{
            local === null
              ? '—'
              : `${String(local.photos)} 张（向量 ${String(local.embeddings)} 条）`
          }}
        </dd>
      </div>
      <div>
        <dt>缩略图</dt>
        <dd>
          {{
            local === null
              ? '—'
              : `${String(local.thumbFiles)} 个 / ${formatBytes(local.thumbBytes)}`
          }}
        </dd>
      </div>
      <div>
        <dt>向量矩阵</dt>
        <dd>{{ local === null ? '—' : formatBytes(local.vectorBytes) }}</dd>
      </div>
    </dl>

    <div class="offline__actions">
      <button class="button" :disabled="refreshing" @click="recheck">
        {{ refreshing ? '复查中…' : '复查' }}
      </button>
    </div>

    <p class="offline__note">
      记账来自浏览器资源时间线（页面实际发出的请求）。诚实边界：只有**冷缓存首次运行**才会去模型
      origin 取权重；索引、检索、聚类全部在本机完成，照片不会离开设备。Worker 内部的请求不计入页面
      时间线，因此 CI 的静态断言与端到端脚本的运行时断言也各守一层。
    </p>
  </section>
</template>

<style scoped>
.offline {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 1.25rem 1.5rem;
  margin-top: 1.5rem;
}

.offline__title {
  margin: 0 0 0.5rem;
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.offline__verdict {
  margin: 0 0 0.75rem;
  font-size: 0.9375rem;
  color: var(--ok);
}

.offline__verdict[data-clean='false'] {
  color: var(--warn);
}

.offline__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}

.offline__table th {
  text-align: left;
  font-weight: 500;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
  padding: 0.25rem 0.5rem 0.25rem 0;
}

.offline__table td {
  padding: 0.3rem 0.5rem 0.3rem 0;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.offline__table tr[data-kind='external'] {
  color: var(--warn);
}

.offline__host {
  overflow-wrap: anywhere;
}

.offline__num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.offline__sample,
.offline__empty {
  color: var(--text-dim);
  overflow-wrap: anywhere;
}

.offline__facts {
  margin: 0.75rem 0 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 0.5rem 1rem;
  font-size: 0.875rem;
}

.offline__facts div {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  border-bottom: 1px dotted var(--border);
  padding-bottom: 0.2rem;
}

.offline__facts dt {
  color: var(--text-dim);
}

.offline__facts dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.offline__actions {
  margin-top: 0.75rem;
}

.offline__note {
  margin: 0.75rem 0 0;
  font-size: 0.8125rem;
  color: var(--text-dim);
  line-height: 1.6;
}
</style>
