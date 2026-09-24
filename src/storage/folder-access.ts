/**
 * 文件夹授权与权限持久化（M1）。
 *
 * 产品承诺是「照片不复制、不上传」，所以这里**只存句柄**，不碰文件内容。
 * 句柄可以存进 IndexedDB（结构化克隆支持 `FileSystemDirectoryHandle`），
 * 于是用户重启应用后不必重新选目录——但**权限可能已被撤销**，
 * 所以每次启动都要 `queryPermission` 一次，`prompt` 时必须由用户手势触发 `requestPermission`。
 *
 * 这里不直接用 DOM 类型而是窄接口 + 能力检测，原因有二：
 * 1. `showDirectoryPicker` / `queryPermission` 在不同 TS 版本的 `lib.dom` 里时有时无，
 *    写死全局类型会让升级 TS 变成一次编译失败；
 * 2. 能力检测让「浏览器不支持」变成一句人话，而不是 `undefined is not a function`。
 */

import type { DirectoryHandleLike } from './photo-source-fsa'

export type PermissionState = 'granted' | 'prompt' | 'denied'

export interface StoredRoot {
  readonly key: string
  readonly label: string
  readonly handle: FileSystemDirectoryHandle
}

interface PermissionDescriptorLike {
  readonly mode?: 'read' | 'readwrite'
}

interface PermissionCapableHandle {
  queryPermission?(descriptor?: PermissionDescriptorLike): Promise<PermissionState>
  requestPermission?(descriptor?: PermissionDescriptorLike): Promise<PermissionState>
}

interface DirectoryPickerHost {
  showDirectoryPicker?(options?: {
    id?: string
    mode?: 'read' | 'readwrite'
  }): Promise<FileSystemDirectoryHandle>
}

const DB_NAME = 'fstop-roots'
const DB_VERSION = 1
const STORE = 'handles'
/** 单根产品（M1）；多根留给后续版本，键名先定下来免得以后迁移 */
export const DEFAULT_ROOT_KEY = 'photos'

export function supportsDirectoryPicker(): boolean {
  return typeof (globalThis as DirectoryPickerHost).showDirectoryPicker === 'function'
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开 IndexedDB'))
  })
}

function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const request = run(transaction.objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB 操作失败'))
        transaction.oncomplete = () => db.close()
      }),
  )
}

/** 弹出目录选择器并记住句柄。**必须在用户手势里调用**（否则浏览器直接拒绝） */
export async function pickPhotoFolder(key: string = DEFAULT_ROOT_KEY): Promise<StoredRoot> {
  const host = globalThis as DirectoryPickerHost
  if (typeof host.showDirectoryPicker !== 'function') {
    throw new Error('这个浏览器不支持目录选择（需要桌面 Chromium 的 File System Access）')
  }
  const handle = await host.showDirectoryPicker({ id: 'fstop-photos', mode: 'read' })
  const stored: StoredRoot = { key, label: handle.name, handle }
  await transact('readwrite', (store) => store.put(stored) as IDBRequest<IDBValidKey>)
  return stored
}

/** 取回上次选的目录（可能没有） */
export async function loadStoredRoot(key: string = DEFAULT_ROOT_KEY): Promise<StoredRoot | null> {
  try {
    const value = await transact<StoredRoot | undefined>('readonly', (store) => store.get(key))
    return value ?? null
  } catch {
    // 隐私模式等场景下 IndexedDB 不可用：当作「没有记住」而不是崩掉
    return null
  }
}

export async function forgetRoot(key: string = DEFAULT_ROOT_KEY): Promise<void> {
  await transact('readwrite', (store) => store.delete(key) as IDBRequest<undefined>)
}

/** 当前权限状态。拿不到能力时按 `prompt` 处理（保守：宁可多问一次） */
export async function permissionStateOf(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite' = 'read',
): Promise<PermissionState> {
  const capable = handle as unknown as PermissionCapableHandle
  if (typeof capable.queryPermission !== 'function') return 'prompt'
  try {
    return await capable.queryPermission({ mode })
  } catch {
    return 'prompt'
  }
}

/**
 * 确保有读权限。`prompt` 状态会调 `requestPermission`——**这一步需要用户手势**，
 * 所以在没有手势的路径上（比如启动自动恢复）要接受 `false`，并让界面提示用户点一下。
 */
export async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite' = 'read',
): Promise<boolean> {
  const state = await permissionStateOf(handle, mode)
  if (state === 'granted') return true
  if (state === 'denied') return false
  const capable = handle as unknown as PermissionCapableHandle
  if (typeof capable.requestPermission !== 'function') return false
  try {
    return (await capable.requestPermission({ mode })) === 'granted'
  } catch {
    return false
  }
}

/** 句柄 → `PhotoSource` 需要的窄接口（`FileSystemDirectoryHandle` 天然满足） */
export function asDirectoryHandle(handle: FileSystemDirectoryHandle): DirectoryHandleLike {
  return handle as unknown as DirectoryHandleLike
}
