/**
 * PhotoSource —— 照片来源的唯一抽象。见 docs/Fstop-光圈-项目计划-v0.2.md §7.5
 *
 * 实现：
 * - `FileSystemAccessSource`（storage/，M1）：真实目录，只持有句柄
 * - `OpfsSyntheticSource`（tests/）：合成根，让 Playwright 能驱动端到端流程，
 *   因为原生目录选择器无法被自动化驱动——这是端到端测试唯一可行的通路
 * - 未来的 Tauri 原生实现（M4）：换实现而不是重写
 *
 * 契约：
 * - `list()` 必须惰性产出，不得先把整个库读进内存。
 * - `read()` 按需读取**原始字节**，不缓存原图；调用方负责释放。
 * - `stat()` 只读元数据，必须便宜——增量扫描要对每张照片调用它。
 * - 文件消失、权限被撤销等错误直接抛出，由索引状态机决定重试或标记。
 */

/** 一张照片的身份：**根 + 相对路径**。其余属性都从 `stat()` / `read()` 得到。 */
export interface PhotoRef {
  readonly rootId: string
  /** 相对根目录的 POSIX 路径，唯一标识根内的一张照片 */
  readonly relPath: string
}

export interface PhotoStat {
  readonly size: number
  /** epoch ms */
  readonly mtime: number
  /**
   * `content_hash`：size + 首尾各 64 KB 的哈希（§7.6）。
   * 来源无法廉价提供时留空，由扫描器在 `read()` 之后补齐——
   * 身份必须来自内容，`mtime + size` 在备份恢复或跨盘复制后会让整库重算。
   */
  readonly hash?: string
}

export interface PhotoSource {
  /** 该来源对应的 `roots.id` */
  readonly rootId: string

  list(): AsyncIterable<PhotoRef>

  /** 读取原图字节。返回 `Blob` 而不是 `ArrayBuffer`，让解码路径能直接喂给 `createImageBitmap`。 */
  read(ref: PhotoRef): Promise<Blob>

  stat(ref: PhotoRef): Promise<PhotoStat>
}
