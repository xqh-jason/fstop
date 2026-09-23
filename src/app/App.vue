<script setup lang="ts">
import { onMounted, ref } from 'vue'
import CapabilityPanel from '../ui/CapabilityPanel.vue'
import { detectCapabilities, type Capabilities } from '../shared/env'

const capabilities = ref<Capabilities | null>(null)

onMounted(async () => {
  capabilities.value = await detectCapabilities()
})
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

    <p class="status">
      工程骨架已就绪：数据模型与 <code>PhotoSource</code> / <code>EmbeddingProvider</code>
      两个接口已定稿，索引与检索将在 M0 实测之后落地。
    </p>
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

.status {
  margin: 0;
  color: var(--text-dim);
  font-size: 0.875rem;
  line-height: 1.7;
}

.status code {
  color: var(--text);
}
</style>
