/**
 * 迁移执行 —— 手写迁移数组 + `meta.schema_version`，不引 ORM。见 docs/DESIGN.md。
 *
 * 规则：
 * - 版本号必须是 **从 1 开始连续、递增、不重复** 的链；缺号意味着某个迁移被删掉，
 *   链就不再可重放，直接拒绝打开。
 * - 数据库版本 **高于** 代码期望版本时拒绝打开（用户装了新版又降级），不做任何降级猜测。
 * - 每个迁移的所有语句 + `meta.schema_version` 的写入必须在**同一个事务**里完成，
 *   由调用方（storage/ 的打开流程）负责；崩在中间不会留下半套结构。
 * - 迁移执行器在跑完每个迁移后写 `meta.schema_version = version`。
 */

import { SCHEMA_DDL_V1 } from '../core/model'

export interface Migration {
  readonly version: number
  readonly statements: readonly string[]
}

/** 迁移链。新增结构时**追加**，永不修改已发布的迁移。 */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, statements: SCHEMA_DDL_V1 }]

export class SchemaVersionError extends Error {
  override readonly name = 'SchemaVersionError'
}

function assertIntegerVersion(dbVersion: number, what: string): void {
  if (!Number.isInteger(dbVersion) || dbVersion < 0) {
    throw new SchemaVersionError(`${what} 必须是 ≥ 0 的整数，实际为 ${String(dbVersion)}`)
  }
}

/** 迁移链必须从 1 开始、连续递增且不重复。 */
function assertChain(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    const expected = index + 1
    if (migration.version !== expected) {
      throw new SchemaVersionError(
        `迁移链不连续：第 ${index + 1} 项的版本是 ${migration.version}，期望 ${expected}`,
      )
    }
  })
}

/**
 * 迁移执行的最小契约。浏览器端由 sqlite-wasm 的 `DatabaseSync`（Worker 内）实现，
 * 测试里由 `node:sqlite` 的同名方法实现。
 */
export interface SchemaExecutor {
  exec(sql: string): void
}

/** 代码期望的 schema 版本 = 迁移链末端版本。 */
export function latestMigrationVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  assertChain(migrations)
  return migrations.length
}

/**
 * 返回从 `dbVersion` 到当前代码版本之间待执行的迁移，按版本升序。
 * 若数据库版本高于代码期望版本，抛 `SchemaVersionError`（拒绝打开）。
 */
export function pendingMigrations(
  dbVersion: number,
  migrations: readonly Migration[] = MIGRATIONS,
): readonly Migration[] {
  assertIntegerVersion(dbVersion, '数据库 schema 版本')
  const latest = latestMigrationVersion(migrations)
  if (dbVersion > latest) {
    throw new SchemaVersionError(
      `数据库 schema 版本 ${dbVersion} 高于代码期望的 ${latest}：拒绝打开，请使用更新的版本`,
    )
  }
  return migrations.filter((migration) => migration.version > dbVersion)
}

/**
 * 依次执行待迁移项，每个迁移（语句 + `meta.schema_version` 写入）在**一个事务**内完成，
 * 失败即回滚，不会留下半套结构。返回迁移后的 schema 版本。
 *
 * 连接必须已开启 `PRAGMA foreign_keys = ON`，且调用前没有未完成的事务。
 * 版本号直接插值进 SQL：它来自本文件的迁移数组，`latestMigrationVersion()` 已保证是整数。
 */
export function applyMigrations(
  executor: SchemaExecutor,
  dbVersion: number,
  migrations: readonly Migration[] = MIGRATIONS,
): number {
  const pending = pendingMigrations(dbVersion, migrations)
  for (const migration of pending) {
    executor.exec('BEGIN')
    try {
      for (const statement of migration.statements) executor.exec(statement)
      executor.exec(`UPDATE meta SET schema_version = ${migration.version}`)
      executor.exec('COMMIT')
    } catch (error) {
      executor.exec('ROLLBACK')
      throw error
    }
  }
  return latestMigrationVersion(migrations)
}
