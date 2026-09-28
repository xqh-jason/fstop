/**
 * OPFS 基础操作 —— 只做「拿目录、读写文件、清空」这几件事，不做任何业务判断。
 *
 * 约束：OPFS 只在 Worker 上下文可用，且 **读取也会加锁**，
 * 因此事务与写句柄都必须保持短小；长时间持有 `createWritable` 会阻塞其它读。
 */

export async function opfsDirectory(...segments: string[]): Promise<FileSystemDirectoryHandle> {
  let handle = await navigator.storage.getDirectory()
  for (const segment of segments) {
    handle = await handle.getDirectoryHandle(segment, { create: true })
  }
  return handle
}

export async function writeOpfsFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  data: Blob,
): Promise<number> {
  const handle = await directory.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(data)
  } finally {
    await writable.close()
  }
  return data.size
}

export async function readOpfsFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<File | null> {
  try {
    const handle = await directory.getFileHandle(name)
    return await handle.getFile()
  } catch {
    return null
  }
}

/** 清空目录里的**文件**，保留子目录结构 */
export async function clearOpfsFiles(directory: FileSystemDirectoryHandle): Promise<number> {
  let removed = 0
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === 'file') {
      await directory.removeEntry(name)
      removed += 1
    }
  }
  return removed
}

export async function countOpfsFiles(directory: FileSystemDirectoryHandle): Promise<number> {
  let count = 0
  for await (const [, handle] of directory.entries()) {
    if (handle.kind === 'file') count += 1
  }
  return count
}

/** 递归列出目录下的相对路径，POSIX 分隔符 */
export async function listOpfsFiles(
  directory: FileSystemDirectoryHandle,
  prefix = '',
): Promise<string[]> {
  const paths: string[] = []
  for await (const [name, handle] of directory.entries()) {
    const relative = prefix === '' ? name : `${prefix}/${name}`
    if (handle.kind === 'file') {
      paths.push(relative)
    } else {
      paths.push(...(await listOpfsFiles(handle, relative)))
    }
  }
  return paths
}
