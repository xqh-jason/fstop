/**
 * 有界并发映射：按 `limit` 个「在飞任务」推进，保持输入顺序返回结果。
 *
 * 为什么需要它：产品路径的单张照片耗时几乎全在「解码 + 视觉塔嵌入」这两段计算
 * （实测 decode 24 ms、embed 122 ms，中位）。严格串行时 GPU 在解码期间空转、CPU 在嵌入期间空转，
 * 实测恰好慢 1.6×（产品路径 10.9 张/秒 vs 基准页 17.69 张/秒，解码并发 3）。
 * 基准页的并发只有 3，就足以把 1 万张从 15.3 分钟压回 10 分钟以内——所以这里保持**低并发**：
 * 再往上加只会让 WebGPU 队列互抢，收益反而变差（§9.9 的结论同样是「别靠加大并发压榨」）。
 *
 * 与「无界 `Promise.all`」的区别：无界会把整批（默认 16，未来可能是 256）的照片同时解码，
 * 内存里同时存在 N 个位图，1 万张规模下会直接把标签页打爆。这里保证同时只处理 `limit` 张。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`并发上限必须是正整数，实际为 ${String(limit)}`)
  }
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index] as T, index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 串行闸门：把并发调用排成一列依次执行。
 *
 * 为什么需要它：`EmbedService` 背后只有**一个** GPU 会话（§7.4 拓扑决策：多会话会各自解析权重、
 * 抢同一个 GPU 队列，合并吞吐反而更低）。实测教训——把 `embedImage` 直接并发提交 3 份，
 * 标签页会**空转卡死**（CPU 7%，既不报错也不推进），所以嵌入必须串行。
 * 但「解码、缩略图、入库」这些 CPU 侧的活可以并发：让它们填满 GPU 在嵌入时的空档，
 * 这才是产品路径追平基准页的原因（基准页 17.69 张/秒 vs 产品路径串行时 10.9 张/秒）。
 */
export function createSerialGate(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    // 前一个任务无论成败都要放行下一个（失败不能把闸门永久锁死）
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}
