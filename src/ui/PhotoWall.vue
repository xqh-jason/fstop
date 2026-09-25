<script setup lang="ts">
/**
 * 虚拟滚动照片墙（万张级）—— M1 §9C。
 *
 * 三条硬约束：
 * 1. **只渲染可视行**：万张 → 只挂几十个 DOM 节点（`wall-layout.ts` 算窗口）。
 * 2. **缩略图走 LRU + 显式 revoke**：objectURL 不回收会一直持有 blob
 *    （`thumbnail-cache.ts` 有单测钉住淘汰与 revoke）。
 * 3. **滚动用 rAF 节流**：万张级下每次 scroll 事件都重算窗口会让滚动发涩。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { layoutWall, visibleRange } from '../app/wall-layout'
import { ThumbnailCache, type ThumbnailSource } from '../app/thumbnail-cache'

interface WallPhoto {
  readonly photoId: number
  readonly relPath: string
  readonly thumbKey: string | null
}

const props = defineProps<{
  readonly photos: readonly WallPhoto[]
  readonly loadThumb: (key: string) => Promise<Blob | null>
  /** 缓存上限（默认 300：约等于 2–3 屏的缩略图） */
  readonly cacheCapacity?: number
}>()

const COLUMN_WIDTH = 160
const ROW_HEIGHT = 160
const GAP = 8

const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(600)
const containerWidth = ref(1000)

const layout = computed(() =>
  layoutWall({
    total: props.photos.length,
    containerWidth: containerWidth.value,
    columnWidth: COLUMN_WIDTH,
    rowHeight: ROW_HEIGHT,
    gap: GAP,
  }),
)

const range = computed(() =>
  visibleRange({
    scrollTop: scrollTop.value,
    viewportHeight: viewportHeight.value,
    layout: layout.value,
  }),
)

/** 当前窗口内要渲染的条目（含行内填充，保持网格对齐） */
const visible = computed(() =>
  props.photos
    .slice(range.value.startIndex, range.value.endIndex)
    .map((photo, offset) => ({ photo, index: range.value.startIndex + offset })),
)

const urls = ref<Record<string, string>>({})
let cache: ThumbnailCache | null = null
let observer: ResizeObserver | null = null
let rafId = 0

function source(): ThumbnailSource {
  return {
    load: (key) => props.loadThumb(key),
    createUrl: (blob) => URL.createObjectURL(blob),
    // 显式回收：这是「万张级不涨内存」的唯一保证
    revokeUrl: (url) => URL.revokeObjectURL(url),
  }
}

onMounted(() => {
  cache = new ThumbnailCache(source(), props.cacheCapacity ?? 300)
  observer = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect
    if (rect === undefined) return
    containerWidth.value = rect.width
    viewportHeight.value = rect.height
  })
  if (viewport.value !== null) observer.observe(viewport.value)
})

onUnmounted(() => {
  observer?.disconnect()
  cancelAnimationFrame(rafId)
  cache?.clear() // 退出照片墙：把所有 objectURL 释放掉
  urls.value = {}
})

/** 滚动：rAF 节流，一帧只更新一次 scrollTop */
function onScroll(event: Event): void {
  const target = event.target as HTMLElement
  const next = target.scrollTop
  cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    scrollTop.value = next
  })
}

/** 窗口变化时按需取缩略图；已取到的直接复用 */
watch(
  visible,
  (items) => {
    if (cache === null) return
    for (const { photo } of items) {
      const key = photo.thumbKey
      if (key === null || urls.value[key] !== undefined) continue
      void cache.get(key).then((url) => {
        if (url === null) return
        urls.value = { ...urls.value, [key]: url }
      })
    }
  },
  { immediate: true },
)

defineExpose({
  /** 诊断用：缓存命中/淘汰计数（端到端断言要能看到 revoke 确实发生） */
  cacheStats: () => cache?.stats() ?? null,
})
</script>

<template>
  <div ref="viewport" class="wall" data-testid="photo-wall" @scroll="onScroll">
    <div class="wall__spacer" :style="{ height: `${layout.spacerHeight}px` }">
      <ul
        class="wall__grid"
        :style="{
          transform: `translateY(${range.startRow * layout.rowHeight}px)`,
          gridTemplateColumns: `repeat(${layout.columns}, ${COLUMN_WIDTH}px)`,
          gap: `${GAP}px`,
        }"
      >
        <li
          v-for="{ photo } in visible"
          :key="photo.photoId"
          class="wall__cell"
          :title="photo.relPath"
        >
          <img
            v-if="photo.thumbKey !== null && urls[photo.thumbKey] !== undefined"
            class="wall__thumb"
            :src="urls[photo.thumbKey]"
            :alt="photo.relPath"
            width="160"
            height="160"
          />
          <div v-else class="wall__thumb wall__thumb--empty" />
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.wall {
  height: 32rem;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  /* 滚动容器必须有自己的合成层，否则万张级下滚动会与主线程布局互相拖累 */
  contain: strict;
}

.wall__spacer {
  position: relative;
}

.wall__grid {
  position: absolute;
  top: 0;
  left: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
}

.wall__cell {
  width: 160px;
  height: 160px;
}

.wall__thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 0.375rem;
  background: var(--surface);
}

.wall__thumb--empty {
  background: var(--surface);
  opacity: 0.4;
}
</style>
