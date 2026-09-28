<script setup lang="ts">
/**
 * 人物面板（M2）—— 聚类结果 + 命名 / 合并 / 拆分。
 *
 * 三个刻意的取舍：
 * 1. **封面用照片缩略图按框定位裁切**，不额外写小图：脸裁切是纯显示问题，
 *    多写一份缩略图文件就多一份要维护、要清理、要同步的东西。
 * 2. **命名的组不会被重算冲掉**（逻辑在 `face-runner.ts` 的 `clusterAndPersist`）：
 *    这里只负责把名字写回去。
 * 3. **合并是「搬到另一组」而不是「新建一组」**：用户的心智是「这俩是同一个人」，
 *    所以合并后保留目标组的名字——名字是用户资产，不能因为合并被重置。
 */
import { computed, ref } from 'vue'
import type { ClusterRow, FaceRow } from '../storage/db.worker'

const props = defineProps<{
  faces: readonly FaceRow[]
  clusters: readonly ClusterRow[]
  /** 缩略图 URL 表（键 = thumbKey），由 App 提供；缺了就显示占位 */
  thumbUrls: Readonly<Record<string, string>>
  /** 是否已经跑过人脸识别（区分「没跑」与「跑完没人脸」） */
  ran: boolean
  /** 人脸识别进度文案（跑的时候显示） */
  status: string | null
  busy: boolean
  onRename: (clusterId: number, name: string) => Promise<void>
  onMerge: (fromClusterId: number, toClusterId: number) => Promise<void>
  onSplit: (clusterId: number, faceIds: readonly number[]) => Promise<void>
  onRun: () => Promise<void>
}>()

const openClusterId = ref<number | null>(null)
/** 待拆分的人脸（键 = clusterId → faceId 集合） */
const selected = ref<Map<number, Set<number>>>(new Map())
const nameDraft = ref<Map<number, string>>(new Map())
const mergeTarget = ref<Map<number, number>>(new Map())

const faceById = computed(() => {
  const map = new Map<number, FaceRow>()
  for (const face of props.faces) map.set(face.faceId, face)
  return map
})

/** 未分组的人脸（聚类阈值下没跟任何人凑成组；界面要如实列出来，不能假装没有） */
const ungrouped = computed(() => props.faces.filter((face) => face.clusterId === null))

function facesOf(cluster: ClusterRow): FaceRow[] {
  const result: FaceRow[] = []
  for (const faceId of cluster.faceIds) {
    const face = faceById.value.get(faceId)
    if (face !== undefined) result.push(face)
  }
  return result
}

function coverOf(cluster: ClusterRow): FaceRow | null {
  const explicit = cluster.coverFaceId
  if (explicit !== null) {
    const face = faceById.value.get(explicit)
    if (face !== undefined) return face
  }
  return facesOf(cluster)[0] ?? null
}

function toggle(clusterId: number): void {
  openClusterId.value = openClusterId.value === clusterId ? null : clusterId
}

function isSelected(clusterId: number, faceId: number): boolean {
  return selected.value.get(clusterId)?.has(faceId) ?? false
}

function toggleSelect(clusterId: number, faceId: number): void {
  const next = new Map(selected.value)
  const set = new Set(next.get(clusterId) ?? [])
  if (set.has(faceId)) set.delete(faceId)
  else set.add(faceId)
  next.set(clusterId, set)
  selected.value = next
}

function selectedCount(clusterId: number): number {
  return selected.value.get(clusterId)?.size ?? 0
}

function draftOf(cluster: ClusterRow): string {
  return nameDraft.value.get(cluster.clusterId) ?? cluster.name ?? ''
}

function setDraft(clusterId: number, value: string): void {
  const next = new Map(nameDraft.value)
  next.set(clusterId, value)
  nameDraft.value = next
}

function targetOf(cluster: ClusterRow): string {
  const target = mergeTarget.value.get(cluster.clusterId)
  return target === undefined ? '' : String(target)
}

function setTarget(clusterId: number, value: string): void {
  const next = new Map(mergeTarget.value)
  next.set(clusterId, Number(value))
  mergeTarget.value = next
}

async function rename(cluster: ClusterRow): Promise<void> {
  const name = draftOf(cluster).trim()
  await props.onRename(cluster.clusterId, name === '' ? '' : name)
}

async function merge(cluster: ClusterRow): Promise<void> {
  const target = mergeTarget.value.get(cluster.clusterId)
  if (target === undefined || target === cluster.clusterId) return
  await props.onMerge(cluster.clusterId, target)
}

async function split(cluster: ClusterRow): Promise<void> {
  const picked = [...(selected.value.get(cluster.clusterId) ?? new Set<number>())]
  await props.onSplit(cluster.clusterId, picked)
  const next = new Map(selected.value)
  next.set(cluster.clusterId, new Set())
  selected.value = next
}

/**
 * 缩略图里按人脸框定位：把整张缩略图放大到「人脸较长的那条边正好铺满格子」，
 * 并让人脸**中心对准格子中心**。
 *
 * 全部用无单位比例，交给 CSS `calc` 去乘容器尺寸与图片自身尺寸 —— 算式里不出现
 * 绝对像素、也不出现照片/缩略图的具体分辨率，换任何尺寸的图都对。
 *
 * 三个变量（都以「人脸较长边」为 1 个单位）：
 * - `--sw`：整张照片的宽 = 多少个人脸长边 → `width: 100% * var(--sw)` 就把脸放大到铺满格子
 * - `--fx/--fy`：人脸**中心**在照片里的位置（同样的单位）→ 用 `50% - 100% * fx` 把中心对到格子中心
 *
 * 踩过的两个坑（都实测过，别再写回去）：
 * ① 用**原图像素**算放大倍数、却作用在 320 px 缩略图上 → 多放大十几倍，格子只剩一块皮肤（纯色）；
 * ② 只对齐人脸左上角、不加高宽比因子 → 平移到「额头+眼睛」，用户看到的就是「照片一角」。
 *    正确做法是对齐**中心**：对齐左上角必须同时知道脸的宽高占格子的比例，而中心不需要。
 */
function faceStyle(face: FaceRow): Record<string, string> {
  const width = face.width ?? 0
  const height = face.height ?? 0
  const boxWidth = face.x2 - face.x1
  const boxHeight = face.y2 - face.y1
  // 尺寸缺失时不给变量：CSS 的默认值（整宽、居中）会退化成「按宽铺满、居中裁切」，
  // 至少还是等比缩放，而不是把图片按原始像素摆在格子里只露一角。
  if (width <= 0 || height <= 0 || boxWidth <= 0 || boxHeight <= 0) return {}
  const span = Math.max(boxWidth, boxHeight)
  return {
    '--sw': String(width / span),
    '--fx': String((face.x1 + boxWidth / 2) / span),
    '--fy': String((face.y1 + boxHeight / 2) / span),
  }
}

function nameOf(cluster: ClusterRow): string {
  return cluster.name === null || cluster.name === '' ? '未命名' : cluster.name
}
</script>

<template>
  <section class="people" data-testid="people-panel">
    <header class="people__head">
      <h2 class="people__title">人物</h2>
      <div class="people__actions">
        <span v-if="status !== null" class="people__status">{{ status }}</span>
        <button class="button" :disabled="busy" data-testid="people-run" @click="onRun">
          {{ busy ? '识别中…' : ran ? '重新识别' : '识别人脸' }}
        </button>
      </div>
    </header>

    <p v-if="!ran" class="people__empty" data-testid="people-untouched">
      还没有跑过人脸识别。点「识别人脸」后，照片会在本机完成检测与聚类（首次需要下载人脸模型约 300
      MB，之后离线可用）。
    </p>
    <p v-else-if="faces.length === 0" class="people__empty" data-testid="people-none">
      识别完成，这批照片里没有检出人脸。
    </p>

    <template v-else>
      <p class="people__summary" data-testid="people-summary">
        共 {{ faces.length }} 张人脸，分成 {{ clusters.length }} 组<template
          v-if="ungrouped.length > 0"
          >，另有 {{ ungrouped.length }} 张还没归组</template
        >。
      </p>

      <ul class="people__clusters">
        <li
          v-for="cluster in clusters"
          :key="cluster.clusterId"
          class="person"
          :class="{ 'person--open': openClusterId === cluster.clusterId }"
          :data-cluster-id="cluster.clusterId"
          :data-name="nameOf(cluster)"
          :data-members="
            facesOf(cluster)
              .map((face) => face.relPath.split('/').pop())
              .join(',')
          "
        >
          <div class="person__head">
            <button class="person__cover" type="button" @click="toggle(cluster.clusterId)">
              <span
                v-if="coverOf(cluster) !== null"
                class="face-crop"
                :style="faceStyle(coverOf(cluster)!)"
              >
                <img
                  v-if="thumbUrls[coverOf(cluster)!.thumbKey ?? ''] !== undefined"
                  :src="thumbUrls[coverOf(cluster)!.thumbKey ?? '']"
                  alt=""
                />
              </span>
            </button>
            <div class="person__meta">
              <strong class="person__name">{{ nameOf(cluster) }}</strong>
              <span class="person__count">{{ cluster.faceIds.length }} 张</span>
            </div>
          </div>

          <div v-if="openClusterId === cluster.clusterId" class="person__body">
            <div class="person__row">
              <input
                class="input"
                type="text"
                placeholder="给这个人起个名字"
                :value="draftOf(cluster)"
                :data-testid="`people-name-${String(cluster.clusterId)}`"
                @input="setDraft(cluster.clusterId, ($event.target as HTMLInputElement).value)"
              />
              <button class="button" @click="rename(cluster)">保存名字</button>
            </div>

            <div class="person__row">
              <select
                class="input"
                :value="targetOf(cluster)"
                :data-testid="`people-merge-${String(cluster.clusterId)}`"
                @change="setTarget(cluster.clusterId, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">合并到…</option>
                <option
                  v-for="other in clusters.filter((item) => item.clusterId !== cluster.clusterId)"
                  :key="other.clusterId"
                  :value="String(other.clusterId)"
                >
                  {{ nameOf(other) }}（{{ other.faceIds.length }} 张）
                </option>
              </select>
              <button
                class="button"
                :disabled="mergeTarget.get(cluster.clusterId) === undefined"
                :data-testid="`people-merge-go-${String(cluster.clusterId)}`"
                @click="merge(cluster)"
              >
                合并
              </button>
            </div>

            <div class="person__faces">
              <button
                v-for="face in facesOf(cluster)"
                :key="face.faceId"
                class="face"
                type="button"
                :data-selected="isSelected(cluster.clusterId, face.faceId)"
                :data-face-id="face.faceId"
                @click="toggleSelect(cluster.clusterId, face.faceId)"
              >
                <span class="face-crop" :style="faceStyle(face)">
                  <img
                    v-if="thumbUrls[face.thumbKey ?? ''] !== undefined"
                    :src="thumbUrls[face.thumbKey ?? '']"
                    alt=""
                  />
                </span>
                <span class="face__path">{{ face.relPath.split('/').pop() }}</span>
              </button>
            </div>

            <button
              class="button"
              :disabled="selectedCount(cluster.clusterId) === 0"
              :data-testid="`people-split-${String(cluster.clusterId)}`"
              @click="split(cluster)"
            >
              把选中的 {{ selectedCount(cluster.clusterId) }} 张拆成新组
            </button>
          </div>
        </li>
      </ul>

      <details v-if="ungrouped.length > 0" class="people__ungrouped">
        <summary>还没归组的人脸（{{ ungrouped.length }}）</summary>
        <div class="person__faces">
          <span v-for="face in ungrouped" :key="face.faceId" class="face face--static">
            <span class="face-crop" :style="faceStyle(face)">
              <img
                v-if="thumbUrls[face.thumbKey ?? ''] !== undefined"
                :src="thumbUrls[face.thumbKey ?? '']"
                alt=""
              />
            </span>
            <span class="face__path">{{ face.relPath.split('/').pop() }}</span>
          </span>
        </div>
      </details>
    </template>
  </section>
</template>

<style scoped>
.people {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 1.25rem 1.5rem;
  margin-top: 1.5rem;
}

.people__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.people__title {
  margin: 0;
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.people__actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

/*
 * 人脸格子的尺寸。用户实测反馈：64px 太小，看不清是谁。
 * 下限写死 100px（窄屏也不许小于它），宽屏随视口放大到 152px。
 */
.people {
  --face-size: clamp(100px, 8.5vw, 152px);
}

.people__status {
  font-size: 0.8125rem;
  color: var(--text-dim);
}

.people__empty,
.people__summary {
  margin: 0.75rem 0 0;
  font-size: 0.875rem;
  color: var(--text-dim);
  line-height: 1.6;
}

.people__clusters {
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
  display: grid;
  /* 铺满宽度：宽屏一行能放下几组就放几组，窄屏自动回落到一列 */
  grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
  gap: 0.75rem;
  align-items: start;
}

/* 展开的那一组横跨整行：人脸格子才有地方铺开 */
.person--open {
  grid-column: 1 / -1;
}

.person {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.6rem 0.75rem;
}

.person__head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.person__cover {
  appearance: none;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  line-height: 0;
}

/* 封面是这一组的「门面」，比成员脸再大一档 */
.person__cover .face-crop {
  width: calc(var(--face-size) * 1.25);
  height: calc(var(--face-size) * 1.25);
}

.person__meta {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  align-items: flex-start;
}

.person__name {
  font-size: 1.125rem;
}

.person__count {
  font-size: 0.8125rem;
  color: var(--text-dim);
}

.person__body {
  margin-top: 0.75rem;
  display: grid;
  gap: 0.6rem;
}

.person__row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}

.person__faces {
  display: grid;
  /* 每格正好一个人脸尺寸，多余空间留在右侧，别把脸拉变形 */
  grid-template-columns: repeat(auto-fill, var(--face-size));
  gap: 0.6rem;
}

.face,
.face-crop {
  display: block;
  position: relative;
  overflow: hidden;
}

.face {
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: none;
  padding: 0;
  cursor: pointer;
  width: var(--face-size);
}

.face[data-selected='true'] {
  outline: 2px solid var(--ok);
}

.face--static {
  cursor: default;
}

.face-crop {
  width: var(--face-size);
  height: var(--face-size);
  background: var(--border);
}

.face-crop img {
  position: absolute;
  max-width: none;
  /* 等比放大到「人脸长边铺满格子」，并把人脸中心对准格子中心（全用比例，与容器尺寸无关） */
  width: calc(100% * var(--sw, 1));
  height: auto;
  left: calc(50% - 100% * var(--fx, 0.5));
  top: calc(50% - 100% * var(--fy, 0.5));
}

.face__path {
  display: block;
  font-size: 0.6875rem;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: var(--face-size);
}

.people__ungrouped {
  margin-top: 0.75rem;
  font-size: 0.875rem;
  color: var(--text-dim);
}
</style>
