import { describe, expect, it } from 'vitest'
import { layoutWall, visibleRange } from '../../src/app/wall-layout'
import { ThumbnailCache, type ThumbnailSource } from '../../src/app/thumbnail-cache'

describe('wall-layout：照片墙窗口计算', () => {
  it('列数由容器宽度算出，行数与撑高一致', () => {
    const layout = layoutWall({
      total: 1000,
      containerWidth: 1000,
      columnWidth: 160,
      rowHeight: 160,
      gap: 8,
    })
    // (1000 + 8) / 168 = 6 列
    expect(layout.columns).toBe(6)
    expect(layout.rows).toBe(Math.ceil(1000 / 6))
    expect(layout.spacerHeight).toBe(layout.rows * 168)
  })

  it('容器比一个格子还窄时至少 1 列（不能算出 0 列导致除零）', () => {
    const layout = layoutWall({
      total: 10,
      containerWidth: 50,
      columnWidth: 160,
      rowHeight: 160,
      gap: 8,
    })
    expect(layout.columns).toBe(1)
    expect(layout.rows).toBe(10)
  })

  it('空库：行数与撑高都是 0，窗口为空', () => {
    const layout = layoutWall({
      total: 0,
      containerWidth: 800,
      columnWidth: 160,
      rowHeight: 160,
      gap: 8,
    })
    expect(layout.rows).toBe(0)
    expect(layout.spacerHeight).toBe(0)
    expect(visibleRange({ scrollTop: 0, viewportHeight: 600, layout })).toEqual({
      startRow: 0,
      endRow: 0,
      startIndex: 0,
      endIndex: 0,
    })
  })

  it('万张级：窗口只覆盖可视行 + overscan，而不是全部', () => {
    const layout = layoutWall({
      total: 10_000,
      containerWidth: 1008,
      columnWidth: 160,
      rowHeight: 160,
      gap: 8,
    })
    const range = visibleRange({ scrollTop: 0, viewportHeight: 800, layout, overscan: 2 })
    expect(range.startRow).toBe(0)
    // 800 / 168 ≈ 5 行 + 1 + overscan 2
    expect(range.endRow).toBeLessThanOrEqual(9)
    expect(range.endIndex - range.startIndex).toBeLessThan(60) // 远小于 10000
  })

  it('滚到中部：起始行按 scrollTop 位移，且窗口大小恒定（顶部夹紧之外）', () => {
    const layout = layoutWall({
      total: 10_000,
      containerWidth: 1008,
      columnWidth: 160,
      rowHeight: 160,
      gap: 8,
    })
    const top = visibleRange({ scrollTop: 16_800, viewportHeight: 800, layout, overscan: 2 })
    // 16800 / 168 = 100 行 → overscan 2 行 → 98
    expect(top.startRow).toBe(98)
    const mid = visibleRange({ scrollTop: 33_600, viewportHeight: 800, layout, overscan: 2 })
    expect(mid.startRow).toBe(198)
    // 不在顶部夹紧区时，窗口大小只由视口高度决定
    expect(mid.endRow - mid.startRow).toBe(top.endRow - top.startRow)
  })

  it('滚到底：窗口被 total 行数夹住，不会渲染越界行，也不会算出负窗口', () => {
    const layout = layoutWall({
      total: 100,
      containerWidth: 1008,
      columnWidth: 160,
      rowHeight: 160,
      gap: 8,
    })
    const bottom = visibleRange({ scrollTop: 1_000_000, viewportHeight: 800, layout, overscan: 2 })
    expect(bottom.endRow).toBe(layout.rows)
    expect(bottom.endRow).toBeGreaterThanOrEqual(bottom.startRow)
    expect(bottom.startIndex).toBeLessThanOrEqual(100)
  })
})

/** 可观察的假缩略图来源：记录 load/revoke 调用 */
function fakeSource(blobs: Record<string, Blob>): ThumbnailSource & {
  revokes: string[]
  loads: string[]
} {
  const revokes: string[] = []
  const loads: string[] = []
  let counter = 0
  return {
    revokes,
    loads,
    async load(key) {
      loads.push(key)
      return blobs[key] ?? null
    },
    createUrl(blob) {
      counter += 1
      return `blob:fake/${String(counter)}/${String(blob.size)}`
    },
    revokeUrl(url) {
      revokes.push(url)
    },
  }
}

describe('thumbnail-cache：缩略图 LRU', () => {
  const blob = (size: number): Blob => ({ size }) as Blob

  it('容量内重复取：只加载一次，命中计数增加', async () => {
    const source = fakeSource({ a: blob(1), b: blob(2) })
    const cache = new ThumbnailCache(source, 10)
    const first = await cache.get('a')
    const second = await cache.get('a')
    expect(first).toBe(second)
    expect(source.loads).toEqual(['a'])
    expect(cache.stats()).toMatchObject({ size: 1, hits: 1, misses: 1, evictions: 0 })
  })

  it('超出容量：淘汰最久未使用的，并 revoke 它的 URL', async () => {
    const source = fakeSource({ a: blob(1), b: blob(2), c: blob(3) })
    const cache = new ThumbnailCache(source, 2)
    const urlA = await cache.get('a')
    await cache.get('b')
    // 用一次 a：a 变成最近使用，淘汰时应先淘汰 b
    await cache.get('a')
    await cache.get('c')
    expect(cache.stats().size).toBe(2)
    expect(source.revokes.length).toBe(1)
    expect(source.revokes[0]).not.toBe(urlA)
  })

  it('clear()：全部 revoke，缓存清空', async () => {
    const source = fakeSource({ a: blob(1), b: blob(2) })
    const cache = new ThumbnailCache(source, 10)
    await cache.get('a')
    await cache.get('b')
    cache.clear()
    expect(source.revokes.length).toBe(2)
    expect(cache.stats().size).toBe(0)
  })

  it('不存在的缩略图返回 null，且不占容量', async () => {
    const source = fakeSource({})
    const cache = new ThumbnailCache(source, 10)
    expect(await cache.get('missing')).toBeNull()
    expect(cache.stats()).toMatchObject({ size: 0, misses: 1 })
  })

  it('同一 key 并发请求只触发一次加载', async () => {
    const source = fakeSource({ a: blob(1) })
    const cache = new ThumbnailCache(source, 10)
    const [one, two] = await Promise.all([cache.get('a'), cache.get('a')])
    expect(one).toBe(two)
    expect(source.loads).toEqual(['a'])
  })

  it('容量非正整数直接抛错（避免写成 0 导致每张都被立刻淘汰）', () => {
    const source = fakeSource({})
    expect(() => new ThumbnailCache(source, 0)).toThrow(/容量必须是正整数/)
    expect(() => new ThumbnailCache(source, -3)).toThrow(/容量必须是正整数/)
  })
})
