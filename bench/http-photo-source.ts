/**
 * `PhotoSource` 的 HTTP 实现 —— **仅用于基准**。
 *
 * 为什么需要它：`showDirectoryPicker` 无法自动化；`<input webkitdirectory>` 那条路要靠
 * Playwright 的 `setInputFiles` 把目录塞进页面，实测在持久化 profile + 大目录下会静默失败
 * （`input.files.length` 恒为 0，页面就一直等），连着两次把基准卡死。
 * 语料本来就在项目根目录下、dev server 直接能服务，于是干脆让页面用 HTTP 读：
 * 没有 CDP 文件传递、没有输入元素、没有静默失败。
 *
 * 代价要说清：读路径变成「本地 HTTP」而不是「File 句柄」，`read` 那一栏的数字与产品路径
 * 不完全等价（本地回环，误差在毫秒级；embed 占 200 ms 量级时是噪声）。
 * 产品路径仍是 File System Access，这里只为把端到端吞吐测出来。
 */

import type { PhotoRef, PhotoSource, PhotoStat } from '../src/core/photo-source'

interface CorpusEntry {
  readonly file: string
  readonly bytes: number
  readonly width: number
  readonly height: number
}

export class HttpPhotoSource implements PhotoSource {
  private readonly entries = new Map<string, CorpusEntry>()

  private constructor(
    readonly rootId: string,
    private readonly baseUrl: string,
    private readonly basePath: string,
    entries: readonly CorpusEntry[],
  ) {
    for (const entry of entries) this.entries.set(entry.file, entry)
  }

  /** 从 dev server 读取清单；`limit` 用于分块跑，`basePath` 缺省为真实语料，检索质量页用 `samples` */
  static async open(
    rootId: string,
    baseUrl: string,
    limit: number,
    basePath = 'bench/corpus',
  ): Promise<HttpPhotoSource> {
    const response = await fetch(`${baseUrl}/${basePath}/manifest.json`)
    if (!response.ok) throw new Error(`语料清单不可读：HTTP ${response.status}`)
    const manifest = (await response.json()) as CorpusEntry[]
    const entries = limit > 0 ? manifest.slice(0, limit) : manifest
    return new HttpPhotoSource(rootId, baseUrl, basePath, entries)
  }

  get count(): number {
    return this.entries.size
  }

  get bytes(): number {
    let total = 0
    for (const entry of this.entries.values()) total += entry.bytes
    return total
  }

  async *list(): AsyncIterable<PhotoRef> {
    for (const file of this.entries.keys()) yield { rootId: this.rootId, relPath: file }
  }

  async read(ref: PhotoRef): Promise<Blob> {
    const response = await fetch(
      `${this.baseUrl}/${this.basePath}/${encodeURIComponent(ref.relPath)}`,
    )
    if (!response.ok) throw new Error(`读取失败 ${ref.relPath}：HTTP ${response.status}`)
    return response.blob()
  }

  async stat(ref: PhotoRef): Promise<PhotoStat> {
    const entry = this.entries.get(ref.relPath)
    if (entry === undefined) throw new Error(`文件不在清单里：${ref.relPath}`)
    return { size: entry.bytes, mtime: 0 }
  }
}
