/**
 * 多标签选主 —— `opfs-sahpool` VFS 每 origin 只允许一个实例（计划 §7.3），
 * 第二个标签 `db.open()` 直接硬失败（实测：界面显示误导性的「还没有可索引的文件夹」）。
 * 所以在**碰数据库之前**先用 Web Locks 抢主：
 *
 * - 抢到 → 本页是主 page，负责索引与写入；`release()` 交给页面卸载时调用。
 * - 抢不到 → 本页退化为**只读**：不创建 db worker（那正是第二个 SAH pool 实例会硬失败的那条路）、
 *   不显示索引按钮，界面如实说明「另一个标签页正在管理索引」。
 * - 主页关闭/释放后，从页要能接管 → 从页用 `awaitAcquire` 排队；浏览器按请求顺序交付。
 *
 * 这个模块刻意不 import 任何业务代码：选主的**纯逻辑**（抢到/抢不到/排队接管的状态走向）
 * 可以用注入的假锁在 node 单测里覆盖；`navigator.locks` 只出现在 browserLockKeeper 里。
 */

/** 选主所需的最小锁接口（`navigator.locks` 的可测子集） */
export interface LockKeeper {
  /** 尝试立刻拿锁：拿到返回 release，别处持有返回 null */
  tryAcquire(name: string): Promise<(() => void) | null>
  /** 排队等锁（阻塞直到被授予），返回释放函数 */
  awaitAcquire(name: string): Promise<() => void>
}

export type PageRole = 'leader' | 'follower'

/**
 * 选主：立即试一次；抢到 → leader；没抢到 → follower。
 * leader 持锁到（页面关闭时）显式 release；follower 的接管路径见 `waitToPromote`。
 *
 * 长持锁的实现约定：`tryAcquire` 返回的 release 是**唯一**的放锁方式，
 * 调用方（App.vue onUnmounted / beforeunload）必须调用它，否则锁到浏览器把标签关掉才释放。
 */
export async function electLeader(
  locks: LockKeeper,
  name = 'fstop-primary',
): Promise<{ role: PageRole; releaseIfLeader: () => void }> {
  const release = await locks.tryAcquire(name)
  if (release !== null) {
    return { role: 'leader', releaseIfLeader: release }
  }
  return { role: 'follower', releaseIfLeader: () => {} }
}

/**
 * follower 的接管等待：排队（浏览器在主页释放时按序交付），拿到锁并回调。
 * promise 永不返回 = 本页一直是从页（正常，除非主页释放）；接管发生在回调里（重新 boot）。
 *
 * 注意：这个函数必须在**调用后立刻**驻留后台（不要 await 它控制页面流程），
 * 它 resolve 只有两件事发生之后：接管成功 + onPromoted 完成。
 */
export async function waitToPromote(
  locks: LockKeeper,
  name: string,
  onPromoted: () => void | Promise<void>,
): Promise<void> {
  await locks.awaitAcquire(name)
  await onPromoted()
  // 接管成功后本页就是新主页：不主动释放（释放交给页面卸载）
}
