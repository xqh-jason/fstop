<script setup lang="ts">
/**
 * 相似分组面板 —— M2「相似图 / 重复图分组」的产品入口。
 *
 * 为什么放在 App.vue 而不走检索链路：相似分组与文本查询互不依赖，用的是**纯视觉**相似
 * （库内向量的自相似）；分组计算在服务层一次跑完，这里只负责展示与「展开一组」。
 * 向量快照直接复用检索同款的 `VectorMatrix.snapshot()`，不引入第二份读法。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { groupSimilarPhotos } from '../core/similarity-group'
import type { SimilarityGroup } from '../core/similarity-group'
import { readOpfsFile } from '../storage/opfs'

const props = defineProps<{
  /** (photoId → thumbKey)；分组面板只显示键，图片由父级统一的 thumbMap 走 objectURL */
  thumbKeys: Map<number, string | null>
  /** 已索引照片的 id/向量快照（父级在打开面板时一次性传入） */
  snapshot: { photoIds: number[]; vectors: Float32Array[] } | null
  thumbDir: FileSystemDirectoryHandle | null
}>()

const SIMILAR_THRESHOLD = 0.86
const MIN_GROUP_SIZE = 2 // 只显示 ≥2 张的组：单张组没有「重复」含义，全是噪声

const groups = ref<SimilarityGroup[]>([])
const note = ref('')
const expanded = ref<number | null>(null) // 当前展开的组代表 id
const thumbUrls = ref<Map<number, string>>(new Map())

/** 只留有多张成员的组（近似重复 / 连拍），组数按大小降序 */
const repeatGroups = computed(() =>
  groups.value
    .filter((group) => group.memberIds.length >= MIN_GROUP_SIZE)
    .sort((a, b) => b.memberIds.length - a.memberIds.length),
)

async function run(): Promise<void> {
  const data = props.snapshot
  if (data === null || data.photoIds.length === 0) {
    note.value = '索引还是空的——先建立索引'
    return
  }
  note.value = '正在分组…'
  const started = performance.now()
  const all = groupSimilarPhotos(data, SIMILAR_THRESHOLD)
  groups.value = all
  const repeats = all.filter((group) => group.memberIds.length >= MIN_GROUP_SIZE)
  const dupPhotos = repeats.reduce((sum, group) => sum + group.memberIds.length, 0)
  note.value =
    repeats.length === 0
      ? `没有发现重复/相似组（阈值 ${SIMILAR_THRESHOLD}，共 ${all.length} 张彼此独立）`
      : `${repeats.length} 组 / ${dupPhotos} 张 · 阈值 ${SIMILAR_THRESHOLD} · ${Math.round(performance.now() - started)} ms`
}

async function toggle(group: SimilarityGroup): Promise<void> {
  expanded.value = expanded.value === group.representativeId ? null : group.representativeId
  if (expanded.value !== group.representativeId || props.thumbDir === null) return
  // 展开时才加载成员缩略图（走 OPFS 读 + objectURL），关闭时回收
  for (const id of group.memberIds) {
    if (thumbUrls.value.has(id)) continue
    const key = props.thumbKeys.get(id) ?? null
    if (key === null) continue
    const blob = await readOpfsFile(props.thumbDir, key)
    if (blob !== null) {
      thumbUrls.value = new Map(thumbUrls.value).set(id, URL.createObjectURL(blob))
    }
  }
}

onBeforeUnmount(() => {
  for (const url of thumbUrls.value.values()) URL.revokeObjectURL(url)
})

defineExpose({ run })
</script>

<template>
  <section class="similar">
    <div class="similar__bar">
      <button class="button" @click="run">查找重复 / 相似照片</button>
      <span class="similar__note">{{ note }}</span>
    </div>
    <ul v-if="repeatGroups.length > 0" class="similar__groups">
      <li v-for="group in repeatGroups" :key="group.representativeId" class="similar__group">
        <button class="similar__head" @click="toggle(group)" :data-testid="'similar-group'">
          <img
            v-if="thumbUrls.get(group.representativeId)"
            class="similar__cover"
            :src="thumbUrls.get(group.representativeId)"
            alt=""
          />
          <span class="similar__count">{{ group.memberIds.length }} 张相似</span>
        </button>
        <ul v-if="expanded === group.representativeId" class="similar__members">
          <li v-for="id in group.memberIds" :key="id">
            <img v-if="thumbUrls.get(id)" class="similar__thumb" :src="thumbUrls.get(id)" alt="" />
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.similar {
  margin-top: 20px;
}
.similar__bar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.similar__note {
  font-size: 13px;
  opacity: 0.75;
}
.similar__groups {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.similar__head {
  display: flex;
  align-items: center;
  gap: 10px;
  background: none;
  border: 1px solid rgba(128, 128, 128, 0.35);
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
}
.similar__cover {
  width: 44px;
  height: 44px;
  object-fit: cover;
  border-radius: 6px;
}
.similar__count {
  font-size: 13px;
}
.similar__members {
  list-style: none;
  margin: 6px 0 0;
  padding: 0 0 0 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.similar__thumb {
  width: 88px;
  height: 88px;
  object-fit: cover;
  border-radius: 6px;
}
</style>
