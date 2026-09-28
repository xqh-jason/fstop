/**
 * `PhotoSource` 的 OPFS 实现（docs/DESIGN.md 的第二个实现）。
 *
 * 为什么必须有它：原生目录选择器 `showDirectoryPicker` 无法被自动化驱动，
 * 因此「端到端测试」与「可复现基准」都只能跑在 OPFS 合成根上。
 *
 * **实现上它不重复写遍历逻辑**：OPFS 的目录句柄与 FSA 的是同一个 DOM 接口
 * （都是 `FileSystemDirectoryHandle`），所以这里只是把句柄交给 `FileSystemAccessSource`。
 * 曾经这里有一份私有的扩展名表与一份不递归的 `list()`——两份实现意味着
 * 「端到端测试跑的通路」和「用户真实通路」会悄悄分叉，而分叉的表现是静默漏索引。
 *
 * 副作用（好的那种）：OPFS 语料现在也有真实的 `content_hash`，
 * 于是增量识别能在基准层被真跑一遍，而不是只有单测覆盖。
 */

import type { PhotoRef, PhotoSource, PhotoStat } from '../core/photo-source'
import { opfsDirectory } from './opfs'
import { type DirectoryHandleLike, FileSystemAccessSource } from './photo-source-fsa'

export class OpfsPhotoSource implements PhotoSource {
  private delegate: FileSystemAccessSource | null = null

  constructor(
    readonly rootId: string,
    private readonly segments: readonly string[],
  ) {}

  private async source(): Promise<FileSystemAccessSource> {
    if (this.delegate === null) {
      const root = (await opfsDirectory(...this.segments)) as unknown as DirectoryHandleLike
      this.delegate = new FileSystemAccessSource(this.rootId, root)
    }
    return this.delegate
  }

  async *list(): AsyncIterable<PhotoRef> {
    yield* (await this.source()).list()
  }

  async read(ref: PhotoRef): Promise<Blob> {
    return (await this.source()).read(ref)
  }

  async stat(ref: PhotoRef): Promise<PhotoStat> {
    return (await this.source()).stat(ref)
  }
}
