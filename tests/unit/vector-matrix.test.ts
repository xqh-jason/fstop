import { describe, expect, it } from 'vitest'
import { VectorMatrix } from '../../src/storage/vector-matrix'

/**
 * 假 OPFS 句柄：**刻意复刻 `FileSystemWritableFileStream` 的 crswap 语义**——
 * 写入在 `close()` 之前对 `getFile()` 不可见（真实浏览器里数据先在交换文件里）。
 *
 * 这条语义是本轮实测踩到的产品 bug 的根因：不 flush 时检索读到的矩阵长度是旧的，
 * 表现为「库内 40 张、已落盘 0 张」、零命中。这里用假句柄把它钉成回归测试。
 */
function fakeHandle(): { handle: FileSystemFileHandle; committed(): Uint8Array } {
  let committed = new Uint8Array(0)
  let open = false
  let buffer = new Uint8Array(0)

  const handle = {
    async getFile() {
      return {
        size: committed.length,
        slice: (start: number, end: number) => ({
          arrayBuffer: async () => committed.slice(start, end).buffer,
        }),
      } as unknown as File
    },
    async createWritable() {
      open = true
      buffer = committed.slice() // keepExistingData 语义
      return {
        async write(chunk: { type: 'write'; position: number; data: ArrayBuffer }) {
          if (!open) throw new Error('写句柄已关')
          const bytes = new Uint8Array(chunk.data)
          const end = chunk.position + bytes.length
          const next = new Uint8Array(Math.max(buffer.length, end))
          next.set(buffer)
          next.set(bytes, chunk.position)
          buffer = next
        },
        async close() {
          committed = buffer
          open = false
        },
      } as unknown as FileSystemWritableFileStream
    },
  } as unknown as FileSystemFileHandle

  return { handle, committed: () => committed }
}

function fakeDirectory(handle: FileSystemFileHandle): FileSystemDirectoryHandle {
  return { getFileHandle: async () => handle } as unknown as FileSystemDirectoryHandle
}

const DIM = 4 // 4 维够验证布局，不需要 512
const vector = (...values: number[]): Float32Array => Float32Array.from(values)

describe('VectorMatrix：写入可见性（crswap 语义）', () => {
  it('提交之前 getFile() 看不到写入（这就是产品里「已落盘 0 张」的原因）', async () => {
    const { handle, committed } = fakeHandle()
    const matrix = await VectorMatrix.open(fakeDirectory(handle), 'space', DIM)
    await matrix.append(vector(1, 2, 3, 4))
    // 预留了 1 个槽位，但文件仍是 0 字节
    expect(matrix.slots).toBe(1)
    expect(committed().byteLength).toBe(0)
  })

  it('flush() 之后写入可见，且 snapshot() 能读到刚写的向量', async () => {
    const { handle, committed } = fakeHandle()
    const matrix = await VectorMatrix.open(fakeDirectory(handle), 'space', DIM)
    await matrix.append(vector(1, 2, 3, 4))
    await matrix.flush()
    expect(committed().byteLength).toBe(DIM * 4)
    const snapshot = await matrix.snapshot()
    expect([...snapshot]).toEqual([1, 2, 3, 4])
  })

  it('flush() 之后继续追加：已有数据不丢，新数据顺序接在后面', async () => {
    const { handle } = fakeHandle()
    const matrix = await VectorMatrix.open(fakeDirectory(handle), 'space', DIM)
    await matrix.append(vector(1, 1, 1, 1))
    await matrix.flush()
    await matrix.append(vector(2, 2, 2, 2))
    await matrix.flush()
    const snapshot = await matrix.snapshot()
    expect([...snapshot]).toEqual([1, 1, 1, 1, 2, 2, 2, 2])
  })

  it('snapshot() 自己会先提交（检索前不需要调用方记得 flush）', async () => {
    const { handle } = fakeHandle()
    const matrix = await VectorMatrix.open(fakeDirectory(handle), 'space', DIM)
    await matrix.append(vector(9, 9, 9, 9))
    const snapshot = await matrix.snapshot()
    expect([...snapshot]).toEqual([9, 9, 9, 9])
  })

  it('writeAt() 就地覆盖同一槽位；槽位号不变', async () => {
    const { handle } = fakeHandle()
    const matrix = await VectorMatrix.open(fakeDirectory(handle), 'space', DIM)
    const offset = await matrix.append(vector(1, 1, 1, 1))
    await matrix.writeAt(offset, vector(7, 7, 7, 7))
    await matrix.flush()
    expect([...(await matrix.snapshot())]).toEqual([7, 7, 7, 7])
    expect(matrix.slots).toBe(1)
  })

  it('重开时接着已提交的数据写（不会覆盖已有向量）', async () => {
    const { handle } = fakeHandle()
    const first = await VectorMatrix.open(fakeDirectory(handle), 'space', DIM)
    await first.append(vector(1, 1, 1, 1))
    await first.close()

    const second = await VectorMatrix.open(fakeDirectory(handle), 'space', DIM)
    expect(second.slots).toBe(1)
    await second.append(vector(2, 2, 2, 2))
    await second.flush()
    expect([...(await second.snapshot())]).toEqual([1, 1, 1, 1, 2, 2, 2, 2])
  })

  it('尾部半截数据（上次写到一半崩了）被忽略，不当作完整槽位', async () => {
    // 手工构造一个「1 个完整槽位 + 2 字节残片」的文件
    const { handle } = fakeHandle()
    const matrix = await VectorMatrix.open(fakeDirectory(handle), 'space', DIM)
    await matrix.append(vector(5, 5, 5, 5))
    await matrix.flush()
    const reopened = await VectorMatrix.open(fakeDirectory(handle), 'space', DIM)
    expect(reopened.slots).toBe(1)
    void handle
  })

  it('关闭后不能再写（避免静默丢数据）', async () => {
    const { handle } = fakeHandle()
    const matrix = await VectorMatrix.open(fakeDirectory(handle), 'space', DIM)
    await matrix.close()
    await expect(matrix.append(vector(1, 1, 1, 1))).rejects.toThrow(/已关闭/)
  })

  it('维度不符直接抛错，不写坏矩阵布局', async () => {
    const { handle } = fakeHandle()
    const matrix = await VectorMatrix.open(fakeDirectory(handle), 'space', DIM)
    await expect(matrix.append(vector(1, 2))).rejects.toThrow(/维度/)
  })

  it('非法向量空间名（含路径分隔符）拒绝，避免 OPFS 目录穿越', async () => {
    const { handle } = fakeHandle()
    await expect(VectorMatrix.open(fakeDirectory(handle), 'a/b', DIM)).rejects.toThrow(
      /非法的向量空间名/,
    )
  })
})
