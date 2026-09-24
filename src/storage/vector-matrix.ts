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
 * M0 边界：只实现**顺序追加**。就地更新、压缩、删除都留给 M1（重新索引时直接重建文件更简单）。
 */

export class VectorMatrix {
  private position = 0

  private constructor(
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
    const handle = await directory.getFileHandle(`${space}.f32`, { create: true })
    // 保持句柄打开：每张照片都开关一次写句柄会把「入库」成本推高一个量级
    const writable = await handle.createWritable({ keepExistingData: true })
    return new VectorMatrix(writable, dimension)
  }

  /** 返回槽位下标，也就是要写进 `embeddings.matrix_offset` 的值 */
  async append(vector: Float32Array): Promise<number> {
    if (vector.length !== this.dimension) {
      throw new Error(`向量维度 ${vector.length} ≠ 矩阵维度 ${this.dimension}`)
    }
    const offset = this.position / (this.dimension * Float32Array.BYTES_PER_ELEMENT)
    await this.writable.write({
      type: 'write',
      position: this.position,
      data: vector.slice().buffer as ArrayBuffer,
    })
    this.position += this.dimension * Float32Array.BYTES_PER_ELEMENT
    return offset
  }

  get slots(): number {
    return this.position / (this.dimension * Float32Array.BYTES_PER_ELEMENT)
  }

  async close(): Promise<void> {
    await this.writable.close()
  }
}
