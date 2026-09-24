/**
 * 文件名规则 —— 什么算照片、什么目录不进。`src/core/` 手写区。
 *
 * **只有这一份定义**：FSA 来源、OPFS 来源、扫描器都调这里。
 * （踩过一次：`photo-source-opfs.ts` 里有一份私有扩展名表，而 FSA 实现又要写一份——
 * 两份迟早对不上，且对不上的表现是「某些照片静默不被索引」，最难查。）
 */

/**
 * 认的扩展名。**含 HEIC/HEIF**：iPhone 默认格式，家庭库里最高频。
 * M0 已实测 Chrome 能 `createImageBitmap` 解开（实测记录 §9.x），所以收进来；
 * 解不开的文件由解码路径抛错、由状态机记为 `skipped`（**不是失败**），不影响其它照片。
 */
export const PHOTO_EXTENSIONS: readonly string[] = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'heic',
  'heif',
  'hif',
  'avif',
  'gif',
  'tif',
  'tiff',
  'bmp',
]

const PHOTO_EXTENSION_SET: ReadonlySet<string> = new Set(PHOTO_EXTENSIONS)

/** 不进目录的名字：点开头的一律不进（`.git` / `.Trash` / `.Spotlight-V100` …），外加系统垃圾目录 */
const SKIP_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '@eaDir', // Synology 缩略图缓存
  '#recycle', // Synology 回收站
  '$RECYCLE.BIN',
  'System Volume Information',
  'lost+found',
])

/** 小写扩展名（无扩展名返回空串） */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** 是不是照片。**大小写不敏感**：相机常给 `.JPG`，iOS 给 `.HEIC` */
export function isPhotoFile(name: string): boolean {
  return PHOTO_EXTENSION_SET.has(extensionOf(name))
}

/** 这个目录要不要跳过 */
export function shouldSkipDirectory(name: string): boolean {
  if (name.startsWith('.')) return true
  return SKIP_DIRECTORY_NAMES.has(name)
}

/**
 * 拼相对路径。**总是用 `/`**：`rel_path` 是跨平台的稳定身份，
 * 直接拿 `FileSystemDirectoryHandle.name` 拼在 Windows 上会混进 `\`，让同一张照片算两条记录。
 */
export function joinRelPath(parent: string, name: string): string {
  if (parent === '') return name
  return `${parent}/${name}`
}

/** 把 `a//b/./c` 归一成 `a/b/c`（也用于校验来自外部的路径，如 HTTP 清单） */
export function normalizeRelPath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/')
}

/** 相对路径的父目录（`a/b.jpg` → `a`；顶层文件 → 空串） */
