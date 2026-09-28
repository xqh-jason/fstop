/**
 * 第 5 项专用页：`opfs-sahpool` 的多标签页行为。
 *
 * 要回答的问题（docs/DESIGN.md 的代价面）：同一 origin 的第二个标签页能不能优雅退化，
 * 还是直接抛错？以及用 Web Locks 选主能不能把「抛错」变成「明确的只读/提示」。
 *
 * URL 参数：`?vfs=<目录名>&locks=1`（locks=1 时先抢 Web Lock 再开库）。
 */

import * as Comlink from 'comlink'
import type { DbService } from '../src/storage/db.worker'

const params = new URLSearchParams(location.search)
const directory = params.get('vfs') ?? 'fstop-vfs-lock'
const useLocks = params.get('locks') === '1'
const output = document.getElementById('out')

interface Report {
  leader?: boolean
  opened?: boolean
  schemaVersion?: number
  error?: string
  locksSupported: boolean
}

const report: Report = { locksSupported: typeof navigator.locks?.request === 'function' }

function render(): void {
  if (output !== null) output.textContent = JSON.stringify(report, null, 2)
  ;(window as unknown as { __DB_RESULT: Report }).__DB_RESULT = report
}

render()

const db = Comlink.wrap<DbService>(
  new Worker(new URL('../src/storage/db.worker.ts', import.meta.url), { type: 'module' }),
)

async function openDatabase(): Promise<void> {
  try {
    const result = await db.open('bench', { directory })
    report.opened = true
    report.schemaVersion = result.schemaVersion
  } catch (error) {
    report.opened = false
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  render()
}

if (useLocks) {
  // 选主：拿不到锁的标签页不初始化 VFS，退化为只读视图（docs/DESIGN.md 的方案）
  void navigator.locks.request('fstop-db-leader', { ifAvailable: true }, async (lock) => {
    report.leader = lock !== null
    render()
    if (lock === null) return
    await openDatabase()
    // 保持持锁直到页面卸载，模拟「主标签页在管索引」
    await Promise.withResolvers<void>().promise
  })
} else {
  await openDatabase()
}
