<script setup lang="ts">
import { computed } from 'vue'
import type { Capabilities } from '../shared/env'

const props = defineProps<{ capabilities: Capabilities | null }>()

const rows = computed(() => {
  const capabilities = props.capabilities
  if (!capabilities) return []
  return [
    {
      key: 'fileSystemAccess',
      label: '文件系统访问',
      api: 'showDirectoryPicker()',
      ok: capabilities.fileSystemAccess,
      gap: '无法选定文件夹，P0 动作不存在',
    },
    {
      key: 'opfs',
      label: 'OPFS 存储',
      api: 'navigator.storage.getDirectory()',
      ok: capabilities.opfs,
      gap: '索引无法落盘，只能退化为一次性会话',
    },
    {
      key: 'webgpu',
      label: 'WebGPU',
      api: 'navigator.gpu.requestAdapter()',
      ok: capabilities.webgpu,
      gap: '降级 WASM 推理',
    },
    {
      key: 'persistentStorage',
      label: '持久化许可',
      api: 'navigator.storage.persist()',
      ok: capabilities.persistentStorage,
      gap: '浏览器可能清理索引',
    },
  ]
})
</script>

<template>
  <section class="panel" aria-live="polite">
    <h2 class="panel__title">运行环境</h2>
    <p v-if="!capabilities" class="panel__pending">检测中…</p>
    <ul v-else class="panel__list">
      <li v-for="row in rows" :key="row.key" class="cap" :data-ok="row.ok">
        <span class="cap__mark" aria-hidden="true">{{ row.ok ? '✓' : '✗' }}</span>
        <span class="cap__label">{{ row.label }}</span>
        <code class="cap__api">{{ row.api }}</code>
        <span class="cap__status">{{ row.ok ? '可用' : `缺失 · ${row.gap}` }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.panel {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 1.25rem 1.5rem;
}

.panel__title {
  margin: 0 0 0.25rem;
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.panel__pending,
.panel__list {
  margin: 0.5rem 0 0;
  color: var(--text-dim);
  font-size: 0.9375rem;
}

.panel__list {
  list-style: none;
  padding: 0;
}

.cap {
  display: grid;
  grid-template-columns: 1.25rem minmax(7rem, auto) minmax(0, 1fr) auto;
  gap: 0.75rem;
  align-items: baseline;
  padding: 0.5rem 0;
  border-top: 1px solid var(--border);
}

.cap:first-child {
  border-top: 0;
}

.cap__mark {
  color: var(--ok);
}

.cap[data-ok='false'] .cap__mark {
  color: var(--warn);
}

.cap__label {
  color: var(--text);
}

.cap__api {
  font-size: 0.8125rem;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}

.cap__status {
  font-size: 0.8125rem;
  color: var(--text-dim);
  text-align: right;
}
</style>
