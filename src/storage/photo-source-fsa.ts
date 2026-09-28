/**
 * `PhotoSource` 的 File System Access 实现（docs/DESIGN.md 的第一个实现，M1）。
 *
 * **只持有句柄，不复制文件**：原图始终留在用户硬盘上（这是产品的核心承诺）。
 *
 * 句柄的最小结构定义在这里而不是直接用 DOM 类型，有两个原因：
 * 1. 单测能用假目录树在 node 里驱动整条遍历（含跳过规则、路径拼接），
 *    否则遍历逻辑就只能靠「手动点一次」来验证；
 * 2. 遍历/读取是**可复用的纯结构**，M4 的 Tauri 实现只要满足同样的结构。
 *
 * 注意 `rel_path` 一律用 `/` 拼（见 `core/photo-files.ts`），Windows 上不会混进 `\`。
 */

import { contentHashOf } from '../core/content-hash'
import { isPhotoFile, joinRelPath, shouldSkipDirectory } from '../core/photo-files'
import type { PhotoRef, PhotoSource, PhotoStat } from '../core/photo-source'

/** 句柄的公共部分 */
export interface HandleLike {
  readonly kind: 'file' | 'directory'
  readonly name: string
}

export interface FileHandleLike extends HandleLike {
  readonly kind: 'file'
  getFile(): Promise<File>
}

export interface DirectoryHandleLike extends HandleLike {
  readonly kind: 'directory'
  entries(): AsyncIterable<[string, HandleLike]>
  getDirectoryHandle(name: string): Promise<DirectoryHandleLike>
  getFileHandle(name: string): Promise<FileHandleLike>
}

/**
 * 按相对路径取文件句柄。`relPath` 里的空段与 `.` 会被忽略（防 `../` 越权：只按段名向下走，
 * 不做任何向上解析——句柄 API 本身也不接受 `..`）。
 */
export async function resolveFileHandle(
  root: DirectoryHandleLike,
  relPath: string,
): Promise<FileHandleLike> {
  const segments = relPath.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) throw new Error(`空路径无法解析为文件：${relPath}`)
  let directory = root
  for (const segment of segments.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(segment)
  }
  return directory.getFileHandle(segments[segments.length - 1]!)
}

export interface FsaSourceOptions {
  /**
   * 深度上限。防止「用户选了主目录」这种极端情况把整台机器爬一遍——
   * 到上限就停，而不是无限递归。
   */
  readonly maxDepth?: number
  /** 遍历中遇到不可读的目录：默认跳过（权限、损坏），交给调用方决定要不要记 */
  readonly onDirectoryError?: (relPath: string, error: unknown) => void
}

export class FileSystemAccessSource implements PhotoSource {
  constructor(
    readonly rootId: string,
    private readonly root: DirectoryHandleLike,
    private readonly options: FsaSourceOptions = {},
  ) {}

  /**
   * 惰性广度优先遍历。**不先把整个库读进内存**（契约要求）：边遍历边产出，
   * 调用方可以边扫描边入库。顺序由目录列举顺序决定——**同一台机器上稳定**，
   * 这一点对基准可复现很重要（同一次语料、两次运行必须产出同样的顺序）。
   */
  async *list(): AsyncIterable<PhotoRef> {
    const maxDepth = this.options.maxDepth ?? 32
    const queue: { directory: DirectoryHandleLike; relPath: string; depth: number }[] = [
      { directory: this.root, relPath: '', depth: 0 },
    ]
    // 用游标而不是 shift()：shift 是 O(n)，几万个目录会退化成 O(n²)
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head]!
      let entries: AsyncIterable<[string, HandleLike]>
      try {
        entries = current.directory.entries()
      } catch (error) {
        this.report(current.relPath, error)
        continue
      }
      try {
        for await (const [name, handle] of entries) {
          if (handle.kind === 'file') {
            if (!isPhotoFile(name)) continue
            yield { rootId: this.rootId, relPath: joinRelPath(current.relPath, name) }
            continue
          }
          if (shouldSkipDirectory(name)) continue
          if (current.depth >= maxDepth) continue
          queue.push({
            directory: handle as DirectoryHandleLike,
            relPath: joinRelPath(current.relPath, name),
            depth: current.depth + 1,
          })
        }
      } catch (error) {
        // 遍历中途失败（目录被拔、权限被撤销）：跳过这一层，其余照片照常索引
        this.report(current.relPath, error)
      }
    }
  }

  async read(ref: PhotoRef): Promise<Blob> {
    const handle = await resolveFileHandle(this.root, ref.relPath)
    return handle.getFile()
  }

  /**
   * 元数据 + `content_hash`。哈希在这里算：`getFile()` 拿到的 `File` 是惰性的，
   * 只有 `slice()` 的片段会被真正读出来（首尾各 64 KB），不会把几 MB 原图读进内存。
   */
  async stat(ref: PhotoRef): Promise<PhotoStat> {
    const handle = await resolveFileHandle(this.root, ref.relPath)
    const file = await handle.getFile()
    return { size: file.size, mtime: file.lastModified, hash: await contentHashOf(file) }
  }

  private report(relPath: string, error: unknown): void {
    this.options.onDirectoryError?.(relPath, error)
  }
}
