/**
 * 浏览器锁实现（`navigator.locks` 的薄封装）。
 *
 * 规范约束（实测踩到，写下来免得再踩）：`request()` 的 `signal` 与 `ifAvailable`
 * **不能同时传**，否则同步抛 `The 'signal' and 'ifAvailable' options cannot be used together`。
 *
 * 我们要的语义是「长持锁 + 能主动放锁 + 拿不到就立刻退出」：
 * - 传 `signal`（不传 `ifAvailable`）→ 请求会**排队**，授予时回调被调用。
 * - 长持锁：回调里返回一个只在 abort 时 resolve 的 promise，锁一直持有到 `release()`。
 * - 立刻判胜负：请求发出后给一个很短的探测窗口（默认 150 ms）。窗口内回调被调用 = 抢到；
 *   没被调用 = 别处持有（本页在排队）→ 立刻 abort 撤销请求，退化为从页。
 *
 * 之所以单独一个文件：`navigator.locks` 不可注入、node 里没有，这段必须浏览器测；
 * 选主的语义逻辑（electLeader / waitToPromote）已由注入假锁的单测覆盖。
 */

import type { LockKeeper } from './tab-primary'

/** 浏览器侧锁名，与 App.vue 的约定保持一处 */
export const PRIMARY_LOCK = 'fstop-primary'

/** 判定「抢到」的探测窗口：Chromium 授予空闲锁在同一任务内完成，150 ms 足够宽裕 */
const PROBE_WINDOW_MS = 150

export function browserLockKeeper(probeWindowMs: number = PROBE_WINDOW_MS): LockKeeper {
  const manager = (): LockManager => {
    if (typeof navigator === 'undefined' || !('locks' in navigator)) {
      throw new Error('当前环境没有 Web Locks（需要 Chromium）')
    }
    return navigator.locks
  }

  /** 请求并把锁长持到 release()；granted() 反映授予与否 */
  function hold(name: string): { granted: () => boolean; release: () => void } {
    const controller = new AbortController()
    let granted = false
    void manager().request(name, { signal: controller.signal }, (lock) => {
      if (lock === null) return
      granted = true
      // 挂起回调：锁由本页持有，直到 release() 触发 abort 才让回调结束
      return new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => {
          resolve()
        })
      })
    })
    return { granted: () => granted, release: () => controller.abort() }
  }

  return {
    async tryAcquire(name) {
      const holder = hold(name)
      await new Promise((resolve) => setTimeout(resolve, probeWindowMs))
      if (holder.granted()) return () => holder.release()
      // 没抢到：撤销排队中的请求，退化为从页
      holder.release()
      return null
    },

    async awaitAcquire(name) {
      const holder = hold(name)
      // 等授予（浏览器在主页释放时按序交付）；25 ms 轮询对「接管」这种低频事件足够
      while (!holder.granted()) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return () => holder.release()
    },
  }
}
