import { describe, expect, it } from 'vitest'
import { contentHashOf } from '../../src/core/content-hash'
import {
  extensionOf,
  isPhotoFile,
  joinRelPath,
  normalizeRelPath,
  shouldSkipDirectory,
} from '../../src/core/photo-files'
import {
  FileSystemAccessSource,
  type DirectoryHandleLike,
  type HandleLike,
  resolveFileHandle,
} from '../../src/storage/photo-source-fsa'

/** 假目录树：在 node 里驱动真实遍历逻辑（FSA 的句柄无法在单测里构造） */
type FakeTree = { [name: string]: FakeTree | Uint8Array }

function fakeDirectory(name: string, tree: FakeTree): DirectoryHandleLike {
  return {
    kind: 'directory',
    name,
    async *entries(): AsyncIterable<[string, HandleLike]> {
      for (const [entryName, value] of Object.entries(tree)) {
        yield [
          entryName,
          value instanceof Uint8Array
            ? fakeFile(entryName, value)
            : fakeDirectory(entryName, value),
        ]
      }
    },
    async getDirectoryHandle(child: string): Promise<DirectoryHandleLike> {
      const value = tree[child]
      if (!(value instanceof Object) || value instanceof Uint8Array) {
        throw new Error(`目录不存在：${child}`)
      }
      return fakeDirectory(child, value)
    },
    async getFileHandle(child: string): Promise<never> {
      const value = tree[child]
      if (!(value instanceof Uint8Array)) throw new Error(`文件不存在：${child}`)
      return fakeFile(child, value) as never
    },
  }
}

function fakeFile(name: string, bytes: Uint8Array) {
  return {
    kind: 'file' as const,
    name,
    async getFile(): Promise<File> {
      return new File([bytes as BlobPart], name, { lastModified: 1_700_000_000_000 })
    },
  }
}

describe('photo-files：文件名规则', () => {
  it('认扩展名，且大小写不敏感', () => {
    for (const name of [
      'a.jpg',
      'A.JPG',
      'b.Jpeg',
      'c.PNG',
      'd.heic',
      'e.HEIF',
      'f.avif',
      'g.gif',
      'h.webp',
      'i.tif',
    ]) {
      expect(isPhotoFile(name)).toBe(true)
    }
  })

  it('不认非照片与「看起来像」的名字', () => {
    for (const name of ['a.txt', 'b.pdf', 'noext', 'jpg', '.jpg', 'a.jpg.txt', 'x.mov', 'y.psd']) {
      expect(isPhotoFile(name)).toBe(false)
    }
  })

  it('扩展名解析：点开头与结尾的点都不算扩展名', () => {
    expect(extensionOf('a.JPG')).toBe('jpg')
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('trailing.')).toBe('')
    expect(extensionOf('noext')).toBe('')
    expect(extensionOf('archive.tar.gz')).toBe('gz')
  })

  it('点开头的目录与系统垃圾目录不进', () => {
    for (const name of [
      '.git',
      '.Trash',
      '.Spotlight-V100',
      'node_modules',
      '@eaDir',
      '$RECYCLE.BIN',
      '#recycle',
    ]) {
      expect(shouldSkipDirectory(name)).toBe(true)
    }
    for (const name of ['2024', '照片', 'Photos', 'DCIM']) {
      expect(shouldSkipDirectory(name)).toBe(false)
    }
  })

  it('路径拼接一律用 /（Windows 上不会混进反斜杠）', () => {
    expect(joinRelPath('', 'a.jpg')).toBe('a.jpg')
    expect(joinRelPath('2024', 'a.jpg')).toBe('2024/a.jpg')
    expect(joinRelPath('2024/旅行', 'a.jpg')).toBe('2024/旅行/a.jpg')
    expect(normalizeRelPath('a//b/./c.jpg')).toBe('a/b/c.jpg')
    expect(normalizeRelPath('/a/b/')).toBe('a/b')
  })
})

describe('FileSystemAccessSource：遍历', () => {
  const tree: FakeTree = {
    '顶层.JPG': new Uint8Array([1, 2, 3]),
    'notes.txt': new Uint8Array([1]),
    '2024': {
      'a.jpg': new Uint8Array([4, 5, 6]),
      'b.HEIC': new Uint8Array([7, 8, 9]),
      '.hidden': { 'c.jpg': new Uint8Array([1]) },
      node_modules: { 'd.jpg': new Uint8Array([1]) },
    },
    旅行: { 西湖: { 'e.png': new Uint8Array([10]) } },
  }

  async function listAll(maxDepth?: number): Promise<string[]> {
    const source = new FileSystemAccessSource('root', fakeDirectory('root', tree), { maxDepth })
    const paths: string[] = []
    for await (const ref of source.list()) paths.push(ref.relPath)
    return paths.sort()
  }

  it('递归产出照片，跳过非照片、隐藏目录与垃圾目录', async () => {
    expect(await listAll()).toEqual(['2024/a.jpg', '2024/b.HEIC', '旅行/西湖/e.png', '顶层.JPG'])
  })

  it('深度上限生效（用户误选主目录时不会爬遍整台机器）', async () => {
    expect(await listAll(1)).toEqual(['2024/a.jpg', '2024/b.HEIC', '顶层.JPG'])
  })

  it('遍历是惰性的：消费前不产出（契约要求「不得先读进内存」）', async () => {
    const source = new FileSystemAccessSource('root', fakeDirectory('root', tree))
    const iterator = source.list()[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value?.relPath).toBe('顶层.JPG') // 根目录里第一个是文件
  })

  it('目录列举中途失败只跳过该层，其余照片照常索引', async () => {
    const errors: string[] = []
    const broken: DirectoryHandleLike = {
      ...fakeDirectory('root', tree),
      async *entries(): AsyncIterable<[string, HandleLike]> {
        yield ['a.jpg', fakeFile('a.jpg', new Uint8Array([1])) as unknown as HandleLike]
        throw new Error('目录被拔了')
      },
    }
    const source = new FileSystemAccessSource('root', broken, {
      onDirectoryError: (relPath, error) => errors.push(`${relPath}:${String(error)}`),
    })
    const paths: string[] = []
    for await (const ref of source.list()) paths.push(ref.relPath)
    expect(paths).toEqual(['a.jpg'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/目录被拔了/)
  })

  it('stat 给出 size / mtime / 内容哈希', async () => {
    const source = new FileSystemAccessSource('root', fakeDirectory('root', tree))
    const stat = await source.stat({ rootId: 'root', relPath: '2024/a.jpg' })
    expect(stat.size).toBe(3)
    expect(stat.mtime).toBe(1_700_000_000_000)
    expect(stat.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('read 按相对路径取到字节；路径不存在时抛错', async () => {
    const source = new FileSystemAccessSource('root', fakeDirectory('root', tree))
    const blob = await source.read({ rootId: 'root', relPath: '2024/a.jpg' })
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]))
    await expect(source.read({ rootId: 'root', relPath: '2024/nope.jpg' })).rejects.toThrow(
      /文件不存在/,
    )
  })

  it('resolveFileHandle 只向下走段名：`..` 不会被解析成上一级', async () => {
    const root = fakeDirectory('root', tree)
    await expect(resolveFileHandle(root, '../secret.jpg')).rejects.toThrow(/目录不存在|文件不存在/)
    await expect(resolveFileHandle(root, '')).rejects.toThrow(/空路径/)
  })
})

describe('contentHashOf：身份必须便宜', () => {
  it('大文件只读首尾各 64 KB，不整读', async () => {
    const slices: [number, number][] = []
    const size = 20 * 1024 * 1024
    const blob = {
      size,
      slice(start = 0, end = size) {
        slices.push([start, end])
        return new Blob([new Uint8Array(Math.min(end - start, 4096))])
      },
    }
    await contentHashOf(blob)
    expect(slices).toHaveLength(2)
    expect(slices[0]![1] - slices[0]![0]).toBe(64 * 1024)
    expect(slices[1]![0]).toBe(size - 64 * 1024)
  })

  it('小文件只切一次（≤ 2 × 64 KB）', async () => {
    let calls = 0
    const size = 1000
    const blob = {
      size,
      slice(start = 0, end = size) {
        calls += 1
        return new Blob([new Uint8Array(end - start)])
      },
    }
    await contentHashOf(blob)
    expect(calls).toBe(1)
  })

  it('内容相同、mtime 不同 → 哈希相同（备份恢复不该触发重算）', async () => {
    const bytes = new Uint8Array(200_000).fill(7)
    const a = new File([bytes as BlobPart], 'a.jpg', { lastModified: 1 })
    const b = new File([bytes as BlobPart], 'a.jpg', { lastModified: 2_000_000_000_000 })
    expect(await contentHashOf(a)).toBe(await contentHashOf(b))
  })

  it('大小不同但首尾相同 → 哈希不同（size 进了哈希）', async () => {
    const head = new Uint8Array(64 * 1024).fill(1)
    const middle = new Uint8Array(1000).fill(2)
    const tail = new Uint8Array(64 * 1024).fill(3)
    const a = new Blob([head as BlobPart, middle as BlobPart, tail as BlobPart])
    const b = new Blob([
      head as BlobPart,
      new Uint8Array(2000).fill(2) as BlobPart,
      tail as BlobPart,
    ])
    expect(await contentHashOf(a)).not.toBe(await contentHashOf(b))
  })

  it('同一位置内容变了 → 哈希不同（就地替换要能被识别）', async () => {
    const a = new Blob([new Uint8Array(300_000).fill(1) as BlobPart])
    const b = new Blob([new Uint8Array(300_000).fill(2) as BlobPart])
    expect(await contentHashOf(a)).not.toBe(await contentHashOf(b))
  })
})
