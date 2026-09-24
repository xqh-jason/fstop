/**
 * `PhotoSource` 的 `<input webkitdirectory>` 实现 —— **仅用于基准与端到端测试**。
 *
 * 为什么需要它：`showDirectoryPicker` 无法被自动化驱动，而基准要跑的是**磁盘上真实照片**
 * （合成语料的 JPEG 只有 ~200 KB，真实相机 12MP 是 3–6 MB，会显著低估 read 与 decode）。
 * Playwright 可以直接给 `<input webkitdirectory>` 塞一个目录，于是拿到 `File` 列表：
 * 不复制文件、不需要用户手势、也不需要把几 GB 语料搬进 OPFS。
 *
 * 它**不是**产品路径：产品路径是 File System Access（可持久化句柄、可增量重扫）。
 */

import type { PhotoRef, PhotoSource, PhotoStat } from '../src/core/photo-source'

interface RelativePathFile extends File {
  readonly webkitRelativePath: string
}

export class FileListPhotoSource implements PhotoSource {
  private readonly files = new Map<string, File>()

  constructor(
    readonly rootId: string,
    files: Iterable<File>,
  ) {
    for (const file of files) {
      const relative = (file as RelativePathFile).webkitRelativePath
      this.files.set(relative === '' ? file.name : relative, file)
    }
  }

  get count(): number {
    return this.files.size
  }

  get bytes(): number {
    let total = 0
    for (const file of this.files.values()) total += file.size
    return total
  }

  async *list(): AsyncIterable<PhotoRef> {
    for (const relPath of this.files.keys()) yield { rootId: this.rootId, relPath }
  }

  async read(ref: PhotoRef): Promise<Blob> {
    const file = this.files.get(ref.relPath)
    if (file === undefined) throw new Error(`文件不在列表里：${ref.relPath}`)
    return file
  }

  async stat(ref: PhotoRef): Promise<PhotoStat> {
    const file = this.files.get(ref.relPath)
    if (file === undefined) throw new Error(`文件不在列表里：${ref.relPath}`)
    return { size: file.size, mtime: file.lastModified }
  }
}
