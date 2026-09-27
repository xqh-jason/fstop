/**
 * `PhotoSource` 的 HTTP 实现 —— 读**同源静态文件**（内置样例库、基准语料）。
 *
 * 用途有两个，共用这一份实现（红线：同一语义不允许两份实现）：
 * 1. **内置样例库**（`public/samples/`）：M3 的「打开即可体验」—— 用户不选目录也能
 *    先跑一遍索引与检索，看清楚这东西是什么；
 * 2. **基准语料**：`showDirectoryPicker` 无法自动化，`<input webkitdirectory>` 实测在
 *    持久化 profile 下会静默失败（`input.files.length` 恒为 0，见实测记录 §8 第 7 项），
 *    所以基准让页面用 HTTP 读项目根下的语料。
 *
 * ⚠ **这是 `src/` 里第二个允许 `fetch` 的文件**（另一个是 `storage/models.ts`），
 * 理由与约束：
 * - URL 一律由 `baseUrl`（调用方传 `location.origin`）拼出，**同源、只读**，不存在外部站点；
 * - 静态零外发断言（`pnpm check:egress`）把它列进白名单；运行时两层断言
 *   （端到端 request hook、`core/egress-ledger` 面板）仍会对真实请求逐条核对，
 *   本文件拿不到「免检」待遇。
 *
 * 口径上的代价要说清：read 走本地 HTTP 回环而不是 File 句柄，和真实目录路径不完全等价
 * （本地回环误差在毫秒级，相对 `embed` 的百毫秒量级是噪声）。产品路径仍是 File System Access。
 */

import type { PhotoRef, PhotoSource, PhotoStat } from '../core/photo-source'

/** 清单条目：`public/samples/manifest.json` 与 `bench/corpus/manifest.json` 同形 */
export interface HttpSourceEntry {
  readonly file: string
  readonly bytes: number
  readonly width?: number
  readonly height?: number
}

export class HttpPhotoSource implements PhotoSource {
  private readonly entries = new Map<string, HttpSourceEntry>()

  private constructor(
    readonly rootId: string,
    private readonly baseUrl: string,
    private readonly basePath: string,
    entries: readonly HttpSourceEntry[],
  ) {
    for (const entry of entries) this.entries.set(entry.file, entry)
  }

  /**
   * 读清单并建源。`limit > 0` 用于基准分块跑；`basePath` 缺省是基准语料，
   * **内置样例请用 `openBundledSamples`**，别在这里手拼路径。
   */
  static async open(
    rootId: string,
    baseUrl: string,
    limit = 0,
    basePath = 'bench/corpus',
  ): Promise<HttpPhotoSource> {
    const response = await fetch(`${baseUrl}/${basePath}/manifest.json`)
    if (!response.ok) throw new Error(`语料清单不可读：HTTP ${String(response.status)}`)
    const manifest = (await response.json()) as HttpSourceEntry[]
    const entries = limit > 0 ? manifest.slice(0, limit) : manifest
    return new HttpPhotoSource(rootId, baseUrl, basePath, entries)
  }

  /** 内置样例库（M3「打开即可体验」）：`public/samples/manifest.json` */
  static async openBundledSamples(
    rootId: string,
    baseUrl: string,
    limit = 0,
  ): Promise<HttpPhotoSource> {
    return await HttpPhotoSource.open(rootId, baseUrl, limit, 'samples')
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
    if (!response.ok) throw new Error(`读取失败 ${ref.relPath}：HTTP ${String(response.status)}`)
    return await response.blob()
  }

  async stat(ref: PhotoRef): Promise<PhotoStat> {
    const entry = this.entries.get(ref.relPath)
    if (entry === undefined) throw new Error(`文件不在清单里：${ref.relPath}`)
    // mtime = 0：内置样例没有有意义的修改时间，如实报「未知」，
    // 而不是编一个时间戳让「按时间排序」看起来有结果（README 的「不编造」同一条纪律）。
    // `hash` 留空，由扫描器读完之后补齐（身份必须来自内容）。
    return { size: entry.bytes, mtime: 0 }
  }
}
