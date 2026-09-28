/**
 * 缩略图 objectURL 的 LRU 缓存 —— 万张级照片墙的关键约束（docs/DESIGN.md）。
 *
 * 为什么必须显式回收：每张缩略图都 `URL.createObjectURL(blob)`，浏览器只在页面卸载或
 * 显式 `revokeObjectURL` 时释放它指向的 blob。滚过一万张不回收 = 一万个 blob 常驻，
 * 内存直接爆（实测过：几百张就开始明显涨）。所以这里做**有上限的 LRU**，
 * 被淘汰的条目立刻 revoke。
 *
 * 抽成独立模块（而不是写在组件里）是为了能用单测验证三件事：
 * 容量上限、淘汰顺序（最近使用的留）、淘汰时 revoke 被调用。
 */

export interface ThumbnailSource {
  /** 读出缩略图字节；不存在返回 null */
  load(key: string): Promise<Blob | null>
  /** 把 Blob 变成可放进 <img src> 的 URL */
  createUrl(blob: Blob): string
  /** 释放 URL（`URL.revokeObjectURL`） */
  revokeUrl(url: string): void
}

export interface ThumbnailStats {
  /** 当前缓存条目数 */
  readonly size: number
  /** 命中次数（诊断用：命中率高说明容量够） */
  readonly hits: number
  /** 未命中次数 */
  readonly misses: number
  /** 因容量淘汰而 revoke 的次数 */
  readonly evictions: number
}

export class ThumbnailCache {
  /** Map 的迭代顺序即插入顺序：用它当 LRU 队列（get 时先删后插 = 挪到队尾） */
  private readonly entries = new Map<string, string>()
  private readonly pending = new Map<string, Promise<string | null>>()
  private hits = 0
  private misses = 0
  private evictions = 0

  constructor(
    private readonly source: ThumbnailSource,
    private readonly capacity: number = 300,
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`缩略图缓存容量必须是正整数，实际为 ${String(capacity)}`)
    }
  }

  /** 取缩略图 URL；不存在返回 null。同一 key 并发调用只加载一次 */
  async get(key: string): Promise<string | null> {
    const cached = this.entries.get(key)
    if (cached !== undefined) {
      // 挪到队尾 = 标记为最近使用
      this.entries.delete(key)
      this.entries.set(key, cached)
      this.hits += 1
      return cached
    }

    const inflight = this.pending.get(key)
    if (inflight !== undefined) return inflight

    this.misses += 1
    const task = (async (): Promise<string | null> => {
      try {
        const blob = await this.source.load(key)
        if (blob === null) return null
        const url = this.source.createUrl(blob)
        this.admit(key, url)
        return url
      } finally {
        this.pending.delete(key)
      }
    })()
    this.pending.set(key, task)
    return task
  }

  /** 主动丢弃（例如切换文件夹、退出照片墙）：立刻 revoke，不留悬挂 URL */
  clear(): void {
    for (const url of this.entries.values()) this.source.revokeUrl(url)
    this.entries.clear()
  }

  stats(): ThumbnailStats {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    }
  }

  private admit(key: string, url: string): void {
    this.entries.set(key, url)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      const victimKey = oldest.value
      const victimUrl = this.entries.get(victimKey)
      this.entries.delete(victimKey)
      if (victimUrl !== undefined) {
        this.source.revokeUrl(victimUrl)
        this.evictions += 1
      }
    }
  }
}
