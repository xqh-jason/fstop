import { describe, expect, it } from 'vitest'
import {
  FINGERPRINT_BYTES,
  type KnownPhoto,
  type ScanEntry,
  fingerprintPayload,
  planScan,
  workCount,
} from '../../src/core/incremental-scan'

function entry(relPath: string, contentHash: string, size = 1000): ScanEntry {
  return { relPath, size, mtime: 1_700_000_000_000, contentHash }
}

function known(
  id: number,
  relPath: string,
  contentHash: string | null,
  deletedAt: number | null = null,
): KnownPhoto {
  return { id, relPath, contentHash, deletedAt }
}

describe('fingerprintPayload：什么算「同一个内容」', () => {
  it('size 进哈希：首尾相同、大小不同的两个文件不能撞成同一身份', () => {
    const head = new Uint8Array([1, 2, 3])
    const tail = new Uint8Array([4, 5, 6])
    const a = fingerprintPayload(head, tail, 1000)
    const b = fingerprintPayload(head, tail, 1001)
    expect(Array.from(a)).not.toEqual(Array.from(b))
    expect(a.length).toBe(8 + 3 + 3)
  })

  it('只取首尾各 limit 字节，超长部分被截断', () => {
    const head = new Uint8Array(FINGERPRINT_BYTES + 10).fill(7)
    const tail = new Uint8Array(FINGERPRINT_BYTES + 10).fill(9)
    const payload = fingerprintPayload(head, tail, 123456)
    expect(payload.length).toBe(8 + FINGERPRINT_BYTES + FINGERPRINT_BYTES)
    // 尾部取的是**最后** limit 字节（不是前 limit 字节）
    expect(payload[payload.length - 1]).toBe(9)
  })

  it('size 必须是非负整数', () => {
    expect(() => fingerprintPayload(new Uint8Array(0), new Uint8Array(0), -1)).toThrow(/非负整数/)
    expect(() => fingerprintPayload(new Uint8Array(0), new Uint8Array(0), 1.5)).toThrow(/非负整数/)
  })
})

describe('planScan：六种落点', () => {
  it('路径没记录 → inserts', () => {
    const plan = planScan([entry('a.jpg', 'h1')], [])
    expect(plan.inserts.map((item) => item.relPath)).toEqual(['a.jpg'])
    expect(workCount(plan)).toBe(1)
  })

  it('路径相同、哈希相同 → unchanged（不重算）', () => {
    const plan = planScan([entry('a.jpg', 'h1')], [known(1, 'a.jpg', 'h1')])
    expect(plan.unchanged.map((item) => item.id)).toEqual([1])
    expect(workCount(plan)).toBe(0)
  })

  it('路径相同、哈希不同 → reindex（就地替换）', () => {
    const plan = planScan([entry('a.jpg', 'h2')], [known(1, 'a.jpg', 'h1')])
    expect(plan.reindex).toEqual([
      { id: 1, entry: entry('a.jpg', 'h2'), reason: 'content-changed' },
    ])
    expect(plan.inserts).toHaveLength(0)
  })

  it('路径不同、哈希相同且候选唯一 → move（只改路径，不重算）', () => {
    const plan = planScan([entry('新目录/a.jpg', 'h1')], [known(1, '旧目录/a.jpg', 'h1')])
    expect(plan.moves).toEqual([
      { id: 1, entry: entry('新目录/a.jpg', 'h1'), from: '旧目录/a.jpg' },
    ])
    expect(plan.deleted).toEqual([])
    expect(workCount(plan)).toBe(1)
  })

  it('已删除的记录又出现 → restore；哈希变了则顺带重算', () => {
    const sameHash = planScan([entry('a.jpg', 'h1')], [known(1, 'a.jpg', 'h1', 999)])
    expect(sameHash.restores).toEqual([{ id: 1, entry: entry('a.jpg', 'h1'), reindex: false }])
    expect(sameHash.deleted).toEqual([])

    const changed = planScan([entry('a.jpg', 'h2')], [known(1, 'a.jpg', 'h1', 999)])
    expect(changed.restores).toEqual([{ id: 1, entry: entry('a.jpg', 'h2'), reindex: true }])
    expect(changed.reindex).toHaveLength(0)
  })

  it('记录里有、扫描里没有 → deleted（标记，不物理删）；已删除的不重复标记', () => {
    const plan = planScan(
      [entry('a.jpg', 'h1')],
      [known(1, 'a.jpg', 'h1'), known(2, 'b.jpg', 'h2'), known(3, 'c.jpg', 'h3', 999)],
    )
    expect(plan.deleted).toEqual([2])
  })
})

describe('planScan：三条安全规则', () => {
  it('空扫描而库里有记录 → 抛错，绝不返回「全删」', () => {
    expect(() => planScan([], [known(1, 'a.jpg', 'h1'), known(2, 'b.jpg', 'h2')])).toThrow(
      /拒绝把整库标记为已删除/,
    )
  })

  it('空扫描且库也空 → 正常的空计划', () => {
    const plan = planScan([], [])
    expect(plan.deleted).toEqual([])
    expect(workCount(plan)).toBe(0)
  })

  it('同一内容有多条记录时不做移动猜测：当成新照片插入，其余按消失处理', () => {
    // 两张真照片内容哈希相同（size + 首尾 64 KB 的碰撞，或用户复制了文件）
    const plan = planScan(
      [entry('新/a.jpg', 'h1')],
      [known(1, 'x/a.jpg', 'h1'), known(2, 'y/a.jpg', 'h1')],
    )
    expect(plan.inserts.map((item) => item.relPath)).toEqual(['新/a.jpg'])
    expect(plan.moves).toHaveLength(0)
    expect(plan.deleted).toEqual([1, 2])
  })

  it('同路径优先于同哈希：A 改名成 B、B 位置又新建了文件时不串味', () => {
    // 库：1 在 a.jpg（内容 h1）；2 在 b.jpg（内容 h2）
    // 扫描：a.jpg 现在是 h2（内容换成了原 b 的内容），b.jpg 变成了 h1
    const plan = planScan(
      [entry('a.jpg', 'h2'), entry('b.jpg', 'h1')],
      [known(1, 'a.jpg', 'h1'), known(2, 'b.jpg', 'h2')],
    )
    // 两条都按路径判定为「内容变了」，而不是互相认成对方的移动
    expect(plan.reindex.map((item) => item.id).sort()).toEqual([1, 2])
    expect(plan.moves).toHaveLength(0)
    expect(plan.deleted).toEqual([])
  })

  it('老库没有哈希（contentHash = null）时按路径判定未变，不触发整库重算', () => {
    const plan = planScan([entry('a.jpg', 'h1')], [known(1, 'a.jpg', null)])
    expect(plan.unchanged.map((item) => item.id)).toEqual([1])
    expect(workCount(plan)).toBe(0)
  })
})

describe('planScan：典型场景', () => {
  it('重命名整个目录：只产生 move，向量一个都不用重算', () => {
    const knownRows = [known(1, '2024/a.jpg', 'h1'), known(2, '2024/b.jpg', 'h2')]
    const plan = planScan([entry('2025/a.jpg', 'h1'), entry('2025/b.jpg', 'h2')], knownRows)
    expect(plan.moves.map((item) => item.from).sort()).toEqual(['2024/a.jpg', '2024/b.jpg'])
    expect(workCount(plan)).toBe(2)
    expect(plan.deleted).toEqual([])
  })

  it('从备份恢复（mtime 全变、内容没变）：unchanged，不重算', () => {
    const knownRows = [known(1, 'a.jpg', 'h1')]
    const restored = { ...entry('a.jpg', 'h1'), mtime: 1 }
    const plan = planScan([restored], knownRows)
    expect(plan.unchanged).toHaveLength(1)
    expect(workCount(plan)).toBe(0)
  })

  it('增量扫描的常态：一次全量重扫里绝大多数是 unchanged', () => {
    const entries = Array.from({ length: 100 }, (_, index) => entry(`p/${index}.jpg`, `h${index}`))
    const knownRows = entries.map((item, index) => known(index + 1, item.relPath, item.contentHash))
    const plan = planScan([...entries, entry('p/new.jpg', 'hnew')], knownRows)
    expect(plan.unchanged).toHaveLength(100)
    expect(plan.inserts).toHaveLength(1)
    expect(workCount(plan)).toBe(1)
  })
})
