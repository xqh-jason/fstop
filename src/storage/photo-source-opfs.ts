/**
 * `PhotoSource` 的 OPFS 实现（§7.5 的第二个实现）。
 *
 * 为什么必须有它：原生目录选择器 `showDirectoryPicker` 无法被自动化驱动，
 * 因此「端到端测试」与「可复现基准」都只能跑在 OPFS 合成根上。
 * 它同时是 M1 里 `FileSystemAccessSource` 的对照实现——两者必须能被同一套调用方互换。
 */

import type { PhotoRef, PhotoSource, PhotoStat } from '../core/photo-source'
import { opfsDirectory } from './opfs'

const PHOTO_EXTENSIONS: Record<string, true> = {
  jpg: true,
  jpeg: true,
  png: true,
  webp: true,
  heic: true,
  heif: true,
  avif: true,
  gif: true,
}

export class OpfsPhotoSource implements PhotoSource {
  constructor(
    readonly rootId: string,
    private readonly segments: readonly string[],
  ) {}

  async *list(): AsyncIterable<PhotoRef> {
    const root = await opfsDirectory(...this.segments)
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'file') continue
      const ext = name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : ''
      if (PHOTO_EXTENSIONS[ext] !== true) continue
      yield { rootId: this.rootId, relPath: name }
    }
  }

  async read(ref: PhotoRef): Promise<Blob> {
    const root = await opfsDirectory(...this.segments)
    const handle = await root.getFileHandle(ref.relPath)
    return handle.getFile()
  }

  async stat(ref: PhotoRef): Promise<PhotoStat> {
    const file = (await this.read(ref)) as File
    // OPFS 合成语料没有廉价的内容哈希通路，按 §7.6 由扫描器在读取后补齐
    return { size: file.size, mtime: file.lastModified }
  }
}
