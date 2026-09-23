import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../../src/core/model'
import {
  SchemaVersionError,
  latestMigrationVersion,
  pendingMigrations,
  type Migration,
} from '../../src/storage/migrations'

const chain: readonly Migration[] = [
  { version: 1, statements: [] },
  { version: 2, statements: [] },
  { version: 3, statements: [] },
]

describe('迁移链校验', () => {
  it('代码期望的版本就是已发布迁移链的末端', () => {
    expect(latestMigrationVersion()).toBe(SCHEMA_VERSION)
    expect(latestMigrationVersion(chain)).toBe(3)
  })

  it('跳号、重复或不是从 1 开始的链一律拒绝（链必须可重放）', () => {
    expect(() =>
      latestMigrationVersion([
        { version: 1, statements: [] },
        { version: 3, statements: [] },
      ]),
    ).toThrow(SchemaVersionError)
    expect(() =>
      latestMigrationVersion([
        { version: 1, statements: [] },
        { version: 1, statements: [] },
      ]),
    ).toThrow(SchemaVersionError)
    expect(() => latestMigrationVersion([{ version: 2, statements: [] }])).toThrow(
      SchemaVersionError,
    )
  })
})

describe('待迁移项计算', () => {
  it('全新数据库返回整条链，按版本升序', () => {
    expect(pendingMigrations(0, chain).map((migration) => migration.version)).toEqual([1, 2, 3])
  })

  it('已是最新版本时没有任何待迁移项', () => {
    expect(pendingMigrations(3, chain)).toEqual([])
    expect(pendingMigrations(SCHEMA_VERSION)).toEqual([])
  })

  it('落后时只返回更新的那部分，已完成的不再重放', () => {
    expect(pendingMigrations(1, chain).map((migration) => migration.version)).toEqual([2, 3])
  })

  it('数据库版本高于代码期望时拒绝打开', () => {
    expect(() => pendingMigrations(4, chain)).toThrow(SchemaVersionError)
    expect(() => pendingMigrations(SCHEMA_VERSION + 1)).toThrow(/高于/)
  })

  it('非法版本号被拒绝', () => {
    for (const version of [-1, 1.5, Number.NaN]) {
      expect(() => pendingMigrations(version, chain)).toThrow(SchemaVersionError)
    }
  })
})
