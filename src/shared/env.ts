/**
 * 运行环境能力探测 —— 见 docs/DESIGN.md。
 *
 * 目标平台是桌面 Chromium；能力缺失时必须**明确提示**而不是静默失败：
 * - 没有 File System Access → 无法选定文件夹，P0 动作不存在
 * - 没有 OPFS → 索引无法落盘，只能退化为一次性会话
 * - 没有 WebGPU → 降级 WASM，并在界面上说明
 * - 没有 `storage.persist()` → OPFS 是 best-effort，索引可能被浏览器清理
 */

export interface Capabilities {
  /** `showDirectoryPicker`：目录选择器的前提 */
  readonly fileSystemAccess: boolean
  /** `navigator.storage.getDirectory()`：OPFS 可用（且只在 Worker 上下文可实际使用） */
  readonly opfs: boolean
  /** 可用的 WebGPU 适配器；false 时走 WASM 降级路径 */
  readonly webgpu: boolean
  /** `navigator.storage.persist()`：能否请求持久化，避免索引被清理 */
  readonly persistentStorage: boolean
}

interface GpuLike {
  requestAdapter(): Promise<unknown | null>
}

async function hasWebGpu(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) !== null
  } catch {
    // 非安全上下文等情况下 requestAdapter 会抛
    return false
  }
}

export async function detectCapabilities(): Promise<Capabilities> {
  const hasStorage = typeof navigator !== 'undefined' && navigator.storage !== undefined
  return {
    fileSystemAccess:
      typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function',
    opfs: hasStorage && typeof navigator.storage.getDirectory === 'function',
    webgpu: await hasWebGpu(),
    persistentStorage: hasStorage && typeof navigator.storage.persist === 'function',
  }
}
