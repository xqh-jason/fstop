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
 * M1 在 M0 的「只追加」之上补了三件事（都是产品路径必需的）：
 * - **重开时接着写**：`open()` 按文件现有大小推出下一个槽位。M0 每次运行都是新文件，
 *   从 0 开始追加；产品里重开一次就把已有向量覆盖了（最坏的那种 bug：不报错、只是结果变差）。
 * - **就地覆盖** `writeAt(offset, …)`：照片内容变了要重算，但槽位是固定的
 *   （`UNIQUE (model_id, matrix_offset)`），所以重算必须写回同一槽位，而不是再追加一条。
 * - **读出快照** `snapshot()`：检索侧要遍历整个矩阵算余弦。
 */

export class VectorMatrix {
  private position = 0

  private constructor(
    private readonly handle: FileSystemFileHandle,
    private readonly writable: FileSystemWritableFileStream,
    private readonly dimension: number,
  ) {}

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
    // 保持句柄打开：每张照片都开关一次写句柄会把「入库」成本推高一个量级
    const writable = await handle.createWritable({ keepExistingData: true })
    const matrix = new VectorMatrix(handle, writable, dimension)
    // 接着已有数据往后写；尾部不足一个槽位的半截数据忽略（上次写到一半崩了）
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

  /** 读出整个矩阵（检索侧用；1 万 × 512 × 4 B ≈ 20 MB，放内存里遍历是毫秒级） */
  async snapshot(): Promise<Float32Array> {
    const file = await this.handle.getFile()
    const stride = this.dimension * Float32Array.BYTES_PER_ELEMENT
    const slots = Math.floor(file.size / stride)
    return new Float32Array(await file.slice(0, slots * stride).arrayBuffer())
  }

  get slots(): number {
    return this.position / (this.dimension * Float32Array.BYTES_PER_ELEMENT)
  }

  async close(): Promise<void> {
    await this.writable.close()
  }

  private assertDimension(vector: Float32Array): void {
    if (vector.length !== this.dimension) {
      throw new Error(`向量维度 ${vector.length} ≠ 矩阵维度 ${this.dimension}`)
    }
  }

  private async write(position: number, vector: Float32Array): Promise<void> {
    await this.writable.write({
      type: 'write',
      position,
      data: vector.slice().buffer as ArrayBuffer,
    })
  }
}
