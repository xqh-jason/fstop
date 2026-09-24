/**
 * 增量识别 —— `src/core/` 手写区（项目计划 §7.6 第 3/4 条）。
 *
 * **照片身份是内容，不是路径、也不是 `mtime + size`**。计划里点名了两种会毁掉索引的常见情况：
 * 从备份恢复、跨盘复制会让 `mtime` 全变；重命名目录只改 `rel_path`。
 * 所以身份用 `content_hash`（`size` + 首尾各 64 KB 的哈希），路径只作为「同一个内容的另一个位置」。
 *
 * 于是「扫描结果 vs 库里已知」的组合只有六种落点：
 *
 * | 情况 | 判定 | 理由 |
 * |---|---|---|
 * | 路径没记录 | `inserts` | 新照片 |
 * | 路径相同、哈希相同 | `unchanged` | 什么都不用做（增量扫描的绝大多数） |
 * | 路径相同、哈希不同 | `reindex` | 文件被就地替换（重导出、修图） |
 * | 路径不同、哈希相同、**唯一候选** | `moves` | 重命名 / 移动 → 只改 `rel_path`，**不重算向量** |
 * | 记录里已 `deleted_at`、现在又出现 | `restores` | 清掉 `deleted_at`，按哈希决定要不要重算 |
 * | 记录里有、扫描里没有 | `deleted` | 标记 `deleted_at`，**不物理删**（用户可能只是拔了移动盘） |
 *
 * 三条安全规则（都有单测钉住）：
 * 1. **扫描结果为空而库里有记录 → 抛错**，不返回「全删」。扫描失败/权限丢失不该毁掉库。
 * 2. **移动判定要求哈希唯一**：多个已知记录共享同一哈希时不做猜测（否则会把两张真照片认成一张）。
 * 3. **同路径优先于同哈希**：路径能对上就用路径那条记录，避免「A 改名成 B、B 又新建」时错配。
 */

/** 一次扫描得到的一条文件（`contentHash` 由扫描侧按 `fingerprintPayload` 计算） */
export interface ScanEntry {
  readonly relPath: string
  readonly size: number
  readonly mtime: number
  readonly contentHash: string
}

/** 库里已知的一条照片（只需要判定用得到的字段） */
export interface KnownPhoto {
  readonly id: number
  readonly relPath: string
  /** 老库可能还没有哈希（升级前入库的），为 null 时只能按路径判定 */
  readonly contentHash: string | null
  readonly deletedAt: number | null
}

export interface ReindexAction {
  readonly id: number
  readonly entry: ScanEntry
  readonly reason: 'content-changed'
}

export interface MoveAction {
  readonly id: number
  readonly entry: ScanEntry
  readonly from: string
}

export interface RestoreAction {
  readonly id: number
  readonly entry: ScanEntry
  readonly reindex: boolean
}

export interface UnchangedAction {
  readonly id: number
  readonly entry: ScanEntry
}

export interface ScanPlan {
  readonly inserts: readonly ScanEntry[]
  readonly reindex: readonly ReindexAction[]
  readonly moves: readonly MoveAction[]
  readonly restores: readonly RestoreAction[]
  readonly unchanged: readonly UnchangedAction[]
  /** 需要标记 `deleted_at` 的照片 id */
  readonly deleted: readonly number[]
}

/** 首尾各取多少字节参与内容哈希（计划 §7.6 第 3 条） */
export const FINGERPRINT_BYTES = 64 * 1024

/**
 * 组装内容哈希的输入：`size`（8 字节小端）+ 头部 + 尾部。
 *
 * 抽成纯函数是为了**让「什么算同一个内容」只有一处定义**：扫描侧只管把字节喂进来。
 * 注意 `size` 必须进哈希——否则「首尾相同、中间不同」的两个文件会撞成同一个身份。
 */
export function fingerprintPayload(
  head: Uint8Array,
  tail: Uint8Array,
  size: number,
  limit: number = FINGERPRINT_BYTES,
): Uint8Array {
  if (!Number.isInteger(size) || size < 0) {
    throw new Error(`size 必须是非负整数，实际为 ${String(size)}`)
  }
  const payload = new Uint8Array(8 + Math.min(head.length, limit) + Math.min(tail.length, limit))
  const view = new DataView(payload.buffer)
  // 8 字节大端整数（固定端序，跨平台一致）；`size` 必须进哈希，见上面的说明
  view.setBigUint64(0, BigInt(size))
  payload.set(head.subarray(0, limit), 8)
  payload.set(
    tail.subarray(tail.length - Math.min(tail.length, limit)),
    8 + Math.min(head.length, limit),
  )
  return payload
}

/**
 * 把「扫描结果」和「库里已知」对成一份行动计划。**纯函数**：不碰数据库、不碰文件系统，
 * 因此可以直接用单测覆盖全部六种落点与三条安全规则。
 */
export function planScan(entries: readonly ScanEntry[], known: readonly KnownPhoto[]): ScanPlan {
  if (entries.length === 0 && known.length > 0) {
    // 安全规则 1：空扫描不等于「照片都没了」。文件夹被拔掉、权限失效、扫描器崩了都会给出空结果，
    // 此时把整库标记删除是最坏的自动化。宁可抛错让上层去确认。
    throw new Error('扫描结果为空但库里有记录：拒绝把整库标记为已删除（先确认根目录可读）')
  }

  const byPath = new Map<string, KnownPhoto>()
  for (const photo of known) {
    // 同一路径只可能有一条记录（DDL 有 UNIQUE(root_id, rel_path)）；重复时保留未删除的那条
    const existing = byPath.get(photo.relPath)
    if (existing === undefined || (existing.deletedAt !== null && photo.deletedAt === null)) {
      byPath.set(photo.relPath, photo)
    }
  }

  const inserts: ScanEntry[] = []
  const reindex: ReindexAction[] = []
  const moves: MoveAction[] = []
  const restores: RestoreAction[] = []
  const unchanged: UnchangedAction[] = []
  const matchedIds = new Set<number>()

  for (const entry of entries) {
    const samePath = byPath.get(entry.relPath)
    if (samePath !== undefined) {
      matchedIds.add(samePath.id)
      if (samePath.contentHash === null || samePath.contentHash === entry.contentHash) {
        // 老库没有哈希时按路径判定为未变（无法更精确，但不能因此整库重算）
        if (samePath.deletedAt !== null) {
          restores.push({ id: samePath.id, entry, reindex: false })
        } else {
          unchanged.push({ id: samePath.id, entry })
        }
      } else if (samePath.deletedAt !== null) {
        restores.push({ id: samePath.id, entry, reindex: true })
      } else {
        reindex.push({ id: samePath.id, entry, reason: 'content-changed' })
      }
      continue
    }

    // 路径对不上：看有没有「同一内容、换了个位置」的记录（重命名 / 移动）
    const candidates = known.filter(
      (photo) =>
        photo.contentHash !== null &&
        photo.contentHash === entry.contentHash &&
        !matchedIds.has(photo.id),
    )
    if (candidates.length === 1) {
      const candidate = candidates[0]!
      matchedIds.add(candidate.id)
      if (candidate.deletedAt !== null) {
        restores.push({ id: candidate.id, entry, reindex: false })
      } else {
        moves.push({ id: candidate.id, entry, from: candidate.relPath })
      }
      continue
    }

    // 安全规则 2：多个候选（内容哈希相同）时不猜——当成新照片插入，
    // 那些老记录会在下面按「扫描里没有」被标记删除，用户可以自己确认。
    inserts.push(entry)
  }

  const deleted: number[] = []
  for (const photo of known) {
    if (matchedIds.has(photo.id)) continue
    if (photo.deletedAt !== null) continue
    deleted.push(photo.id)
  }

  return { inserts, reindex, moves, restores, unchanged, deleted }
}

/** 计划里有多少条**需要干活**的动作（不含 unchanged） */
export function workCount(plan: ScanPlan): number {
  return plan.inserts.length + plan.reindex.length + plan.moves.length + plan.restores.length
}
