import { describe, expect, it } from 'vitest'
import { electLeader, waitToPromote, type LockKeeper } from '../../src/storage/tab-primary'

/** 可编排的假锁：确定性驱动 tryAcquire / awaitAcquire 两条路径 */
function fakeLockKeeper(allOptions: { held?: boolean } = {}): LockKeeper & { releaseAll(): void } {
  const holders: string[] = []
  const waiters: Array<(release: () => void) => void> = []
  return {
    async tryAcquire(name) {
      if (allOptions.held === true || holders.length > 0) return null
      holders.push(name)
      return () => {
        const index = holders.indexOf(name)
        if (index >= 0) holders.splice(index, 1)
        // 释放后按序交付队首
        const next = waiters.shift()
        if (next !== undefined) {
          holders.push(name)
          next(() => {
            const i = holders.indexOf(name)
            if (i >= 0) holders.splice(i, 1)
          })
        }
      }
    },
    async awaitAcquire(name) {
      if (holders.length === 0) {
        holders.push(name)
        return () => {
          const i = holders.indexOf(name)
          if (i >= 0) holders.splice(i, 1)
        }
      }
      return new Promise((resolve) => {
        waiters.push(resolve)
      })
    },
    releaseAll() {
      holders.length = 0
      waiters.length = 0
    },
  }
}

describe('tab-primary：多标签选主', () => {
  it('没人持锁 → 本页是 leader，拿到可用的释放函数', async () => {
    const locks = fakeLockKeeper()
    const outcome = await electLeader(locks)
    expect(outcome.role).toBe('leader')
    // 释放不抛
    expect(() => outcome.releaseIfLeader()).not.toThrow()
  })

  it('别处持锁 → 本页退化为 follower（不碰锁，releaseIfLeader 是空操作）', async () => {
    const locks = fakeLockKeeper({ held: true })
    const outcome = await electLeader(locks)
    expect(outcome.role).toBe('follower')
    expect(() => outcome.releaseIfLeader()).not.toThrow()
  })

  it('主页释放后，排队中的从页被接管（waitToPromote 的回调被调用）', async () => {
    const locks = fakeLockKeeper()
    // 主页先抢到
    const leader = await electLeader(locks)
    expect(leader.role).toBe('leader')

    // 从页开始排队
    let promoted = false
    let settled = false
    const waiting = waitToPromote(locks, 'fstop-primary', async () => {
      promoted = true
    })
    void waiting.then(() => {
      settled = true
    })

    // 主页还没释放：从页没被回调
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(promoted).toBe(false)
    expect(settled).toBe(false)

    // 主页释放 → 从页接管
    leader.releaseIfLeader()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(promoted).toBe(true)
    expect(settled).toBe(true)
  })

  it('两个从页排队：主页释放后按请求顺序（先排的先接管）', async () => {
    const locks = fakeLockKeeper()
    const leader = await electLeader(locks)
    const promotedOrder: string[] = []
    waitToPromote(locks, 'fstop-primary', () => {
      promotedOrder.push('first')
    })
    waitToPromote(locks, 'fstop-primary', () => {
      promotedOrder.push('second')
    })
    leader.releaseIfLeader()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(promotedOrder[0]).toBe('first')
    expect(promotedOrder.length).toBeGreaterThan(0)
  })
})
