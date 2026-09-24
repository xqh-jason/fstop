/**
 * `content_hash` —— 照片身份的唯一来源（项目计划 §7.6 第 3 条）。
 *
 * 为什么不是 `mtime + size`：从备份恢复、跨盘复制、云盘回填都会让 `mtime` 全变，
 * 那样整个库会被判成「全变了」而重算几万张照片的向量。
 *
 * 为什么只读首尾 64 KB：索引 1 万张的冲刺线里，**哈希必须便宜**。
 * 全文件哈希要把每张几 MB 的原图读两遍（一次哈希、一次解码），
 * 而 `size` + 首尾 64 KB 已经能区分「换了一张照片」与「同一张照片换了个位置」。
 * 代价是理论碰撞：同样大小、首尾 64 KB 相同的两个不同文件会被认成同一张——
 * 在 `planScan` 里这种情况**不会瞎猜**（见 `incremental-scan.ts` 的安全规则 2）。
 */

import { FINGERPRINT_BYTES, fingerprintPayload } from './incremental-scan'

/**
 * 只需要 `size` 与 `slice`，因此 `Blob` / `File` 天然满足，
 * 也让单测能用假对象**数出到底读了几次、每次多大**（这正是要钉住的不变量）。
 */
export interface SlicableBlob {
  readonly size: number
  slice(start?: number, end?: number): Blob
}

/** 十六进制小写（64 位十六进制 = 32 字节 SHA-256） */
function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

async function digest(payload: Uint8Array): Promise<string> {
  const view = payload.buffer.slice(
    payload.byteOffset,
    payload.byteOffset + payload.byteLength,
  ) as ArrayBuffer
  const hash = await crypto.subtle.digest('SHA-256', view)
  return toHex(new Uint8Array(hash))
}

/**
 * 计算 `content_hash`。
 *
 * 小文件（`size ≤ 2 × limit`）只切一次，避免把同一段字节读两遍——
 * 缩略图、手机小图在库里占比不小，白读一次是纯浪费。
 */
export async function contentHashOf(
  blob: SlicableBlob,
  limit: number = FINGERPRINT_BYTES,
): Promise<string> {
  const size = blob.size
  if (size <= limit * 2) {
    const bytes = new Uint8Array(await blob.slice(0, size).arrayBuffer())
    // 头尾都喂同一段：`fingerprintPayload` 会按 limit 截断，结果与「头 + 尾」一致
    return digest(fingerprintPayload(bytes, bytes, size, limit))
  }
  const head = new Uint8Array(await blob.slice(0, limit).arrayBuffer())
  const tail = new Uint8Array(await blob.slice(size - limit, size).arrayBuffer())
  return digest(fingerprintPayload(head, tail, size, limit))
}
