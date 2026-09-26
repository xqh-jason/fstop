/**
 * 向量矩阵 —— 自实现的扁平 `Float32Array` 存储（§7.1 删掉 `sqlite-vec` 后的替代）。
 *
 * 为什么不用数据库存向量：1 万条 512 维向量的余弦排序约 10 MFLOP，在 Worker 内遍历扁平数组
 * 是毫秒级；把它塞进 SQLite 只是给 BLOB 付 I/O 代价。数据库里只留「照片 → 槽位」的映射
 * （`embeddings.matrix_offset`），向量本体顺序写在 OPFS 的一个文件里。
 *
 * 每个 `space`（向量空间）一个文件：原版 CLIP 与 Chinese-CLIP 的图像侧不在同一空间，
 * 共用索引会把检索结果污染成噪声。
 *
 * M1 在 M0 的「只追加」之上补了四件事（都是产品路径必需的）：
 * - **重开时接着写**：`open()` 按文件现有大小推出下一个槽位。M0 每次运行都是新文件，
 *   从 0 开始追加；产品里重开一次就把已有向量覆盖了（最坏的那种 bug：不报错、只是结果变差）。
 * - **就地覆盖** `writeAt(offset, …)`：照片内容变了要重算，但槽位是固定的
 *   （`UNIQUE (model_id, matrix_offset)`），所以重算必须写回同一槽位，而不是再追加一条。
 * - **读出快照** `snapshot()`：检索侧要遍历整个矩阵算余弦。
 * - **攒批提交** `flush()`：**这是产品路径上最容易漏的一条**（实测踩过）——
 *   `FileSystemWritableFileStream` 在 `close()` 之前，写入只落在 OPFS 的 `.crswap` 交换文件里，
 *   `handle.getFile()` 读到的仍是**旧长度（甚至是 0 字节）**。于是：
 *     1. 检索侧 `snapshot()` 看不到任何新向量 → 界面显示「库内 40 张、已落盘 0 张」、零命中；
 *     2. 页面被刷新/关闭时这些未提交的写入可能整体丢失。
 *   修法：不要全程只持一个写句柄。写入按批提交（`flush()` 关掉当前句柄 = 落盘），
 *   下一次写入时再懒开一个（`keepExistingData: true`）。槽位预留仍在内存里同步完成
 *   （见 `append()` 的注释），所以「先预留后写」的不变量不受影响。
 */

export class VectorMatrix {
  private position = 0
  private closed = false
  /** 当前打开的写句柄；null = 已落盘、下次写入时再开 */
  private writable: FileSystemWritableFileStream | null = null

  private constructor(
    private readonly handle: FileSystemFileHandle,
    private readonly dimension: number,
  ) {}

  /** 向量维度（检索/离线面板都要用它把字节数换算成条数，不该各自复制一份） */
  get dim(): number {
    return this.dimension
  }

  static async open(
    directory: FileSystemDirectoryHandle,
    space: string,
    dimension: number,
  ): Promise<VectorMatrix> {
    // space 会变成文件名，必须拒绝路径分隔符：OPFS 的 getFileHandle 对含 '/' 的名字直接抛
    // 「Name is not allowed」。模型 id（如 Xenova/chinese-clip-…）不能直接当文件名用。
    if (/[/\\]/.test(space) || space === '.' || space === '..') {
      throw new Error(`非法的向量空间名：${space}`)
    }
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error(`向量维度必须是正整数，实际为 ${String(dimension)}`)
    }
    const handle = await directory.getFileHandle(`${space}.f32`, { create: true })
    const matrix = new VectorMatrix(handle, dimension)
    // 接着**已提交**的数据往后写；尾部不足一个槽位的半截数据忽略（上次写到一半崩了）
    const existing = await handle.getFile()
    const stride = dimension * Float32Array.BYTES_PER_ELEMENT
    matrix.position = Math.floor(existing.size / stride) * stride
    return matrix
  }

  /** 返回槽位下标，也就是要写进 `embeddings.matrix_offset` 的值 */
  async append(vector: Float32Array): Promise<number> {
    this.assertDimension(vector)
    // 槽位必须**同步预留**再 await 写入：否则并发调用会读到同一个 position，
    // 算出同一个 offset、互相覆盖，最后撞 `UNIQUE (model_id, matrix_offset)`（实测踩过）。
    // 定位写入（显式 position）允许乱序完成，所以先预留、后写是安全的。
    const offset = this.slots
    const position = this.position
    this.position += this.dimension * Float32Array.BYTES_PER_ELEMENT
    await this.write(position, vector)
    return offset
  }

  /** 就地覆盖某个槽位（照片内容变了要重算，但槽位不变） */
  async writeAt(offset: number, vector: Float32Array): Promise<void> {
    this.assertDimension(vector)
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`槽位必须是非负整数，实际为 ${String(offset)}`)
    }
    const stride = this.dimension * Float32Array.BYTES_PER_ELEMENT
    const position = offset * stride
    if (position + stride > this.position) this.position = position + stride
    await this.write(position, vector)
  }

  /**
   * 把已写入的数据提交到文件（关掉写句柄），下次写入时自动重开。
   * 调用时机：每处理完一批任务、以及每次检索读取矩阵之前。
   */
  async flush(): Promise<void> {
    const writable = this.writable
    if (writable === null) return
    this.writable = null
    await writable.close()
  }

  /** 读出整个矩阵（检索侧用；1 万 × 512 × 4 B ≈ 20 MB，放内存里遍历是毫秒级） */
  async snapshot(): Promise<Float32Array> {
    // 先提交未落盘的写入，否则读到的长度是旧的（见文件头「攒批提交」）
    await this.flush()
    const file = await this.handle.getFile()
    const stride = this.dimension * Float32Array.BYTES_PER_ELEMENT
    const slots = Math.floor(file.size / stride)
    return new Float32Array(await file.slice(0, slots * stride).arrayBuffer())
  }

  get slots(): number {
    return this.position / (this.dimension * Float32Array.BYTES_PER_ELEMENT)
  }

  /** 已经提交到文件的槽位数（诊断/测试用；与 `slots` 的差 = 尚未 flush 的写入） */
  async committedSlots(): Promise<number> {
    await this.flush()
    const stride = this.dimension * Float32Array.BYTES_PER_ELEMENT
    return Math.floor((await this.handle.getFile()).size / stride)
  }

  async close(): Promise<void> {
    await this.flush()
    this.closed = true
  }

  private assertDimension(vector: Float32Array): void {
    if (vector.length !== this.dimension) {
      throw new Error(`向量维度 ${vector.length} ≠ 矩阵维度 ${this.dimension}`)
    }
  }

  private async write(position: number, vector: Float32Array): Promise<void> {
    if (this.closed) throw new Error('向量矩阵已关闭，不能再写入')
    // 懒开写句柄：一批写入共用一个句柄（每张照片开关一次会把入库成本推高一个量级）
    this.writable ??= await this.handle.createWritable({ keepExistingData: true })
    await this.writable.write({
      type: 'write',
      position,
      data: vector.slice().buffer as ArrayBuffer,
    })
  }
}
