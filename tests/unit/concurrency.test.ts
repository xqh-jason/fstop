import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '../../src/core/concurrency'

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('mapWithConcurrency', () => {
  it('保持输入顺序返回结果（并发完成顺序不影响结果顺序）', async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await tick(ms)
      return ms
    })
    expect(results).toEqual([30, 10, 20])
  })

  it('同时在飞的任务数不超过上限', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (value) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await tick(5)
      inFlight -= 1
      return value
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1) // 确实并行过（否则等于串行实现）
  })

  it('每个元素都被处理恰好一次', async () => {
    const seen: number[] = []
    const items = Array.from({ length: 23 }, (_, index) => index)
    await mapWithConcurrency(items, 4, async (value) => {
      await tick(1)
      seen.push(value)
      return value
    })
    expect([...seen].sort((a, b) => a - b)).toEqual(items)
  })

  it('上限大于元素数时不空转（结果仍是全部元素）', async () => {
    const results = await mapWithConcurrency([1, 2], 8, async (value) => value * 2)
    expect(results).toEqual([2, 4])
  })

  it('单个任务抛错会向上传播（不静默吞掉）', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (value) => {
        if (value === 2) throw new Error('decode failed')
        return value
      }),
    ).rejects.toThrow('decode failed')
  })

  it('空输入直接返回空数组', async () => {
    await expect(mapWithConcurrency([], 3, async () => 1)).resolves.toEqual([])
  })

  it('非法的并发上限被拒绝（0 / 负数 / 小数）', async () => {
    await expect(mapWithConcurrency([1], 0, async () => 1)).rejects.toThrow(/正整数/)
    await expect(mapWithConcurrency([1], -1, async () => 1)).rejects.toThrow(/正整数/)
    await expect(mapWithConcurrency([1], 1.5, async () => 1)).rejects.toThrow(/正整数/)
  })
})
