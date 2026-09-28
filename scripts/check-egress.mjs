#!/usr/bin/env node
/**
 * 零外发静态断言 —— 见 docs/DESIGN.md。
 *
 * 规则：`src/` 与 `index.html` 中除了白名单文件外，不得出现任何发起网络请求的构造。
 * 这条断言把「任何新增网络请求必须显式声明」（docs/DESIGN.md 约定 2）变成机器执行的检查。
 *
 * 用法：`pnpm check:egress`，失败时以退出码 1 结束。
 */

import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** 唯一允许发起网络请求的文件（模型权重下载）。新增条目必须单独评审并同步更新 NOTICE。 */
/**
 * 白名单：允许出现网络调用的文件。
 * - `models.ts`：模型权重的唯一来源（冷缓存时下载权重）；
 * - `photo-source-http.ts`：读**同源**静态文件（内置样例库 `public/samples/`、基准语料），
 *   URL 由调用方传的 `location.origin` 拼出，同源只读；它照样受运行时两层断言检查，
 *   拿不到「免检」待遇（见该文件头部注释）。
 */
export const EGRESS_WHITELIST = ['src/storage/models.ts', 'src/storage/photo-source-http.ts']

/** @typedef {{ file: string, line: number, rule: string, text: string }} Violation */

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.vue', '.js', '.mjs'])

/** 词边界用 `(?<![\w$])` 而不是 `\b`：`prefetch(` 不算，`x.fetch(` 与 `navigator.sendBeacon(` 算。 */
const CODE_RULES = [
  { rule: 'fetch', re: /(?<![\w$])fetch\s*\(/ },
  { rule: 'XMLHttpRequest', re: /(?<![\w$])XMLHttpRequest/ },
  { rule: 'WebSocket', re: /(?<![\w$])WebSocket/ },
  { rule: 'EventSource', re: /(?<![\w$])EventSource/ },
  { rule: 'sendBeacon', re: /(?<![\w$])sendBeacon\s*\(/ },
  { rule: 'remote-import', re: /(?<![\w$])from\s*['"]https?:\/\// },
]

const EXTERNAL_ORIGIN = /(?:src|href)\s*=\s*["']https?:\/\//i

/** @param {string} file @returns {boolean} */
export function isWhitelisted(file) {
  return EGRESS_WHITELIST.includes(file.split(path.sep).join('/'))
}

/**
 * 扫描源码文本，返回所有违例。
 * @param {string} source @param {string} file 仓库相对路径 @returns {Violation[]}
 */
export function findEgressViolations(source, file) {
  if (isWhitelisted(file)) return []
  /** @type {Violation[]} */
  const violations = []
  source.split('\n').forEach((text, index) => {
    for (const { rule, re } of CODE_RULES) {
      if (re.test(text)) violations.push({ file, line: index + 1, rule, text: text.trim() })
    }
  })
  return violations
}

/**
 * 扫描 HTML，返回指向外部 origin 的 `src` / `href`。
 * @param {string} source @param {string} file @returns {Violation[]}
 */
export function findExternalOrigins(source, file) {
  /** @type {Violation[]} */
  const violations = []
  source.split('\n').forEach((text, index) => {
    if (EXTERNAL_ORIGIN.test(text)) {
      violations.push({ file, line: index + 1, rule: 'external-origin', text: text.trim() })
    }
  })
  return violations
}

/** @param {string} dir @returns {Promise<string[]>} */
async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(full)))
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full)
    }
  }
  return files
}

async function main() {
  const root = process.cwd()
  const violations = []

  for (const file of await collectSourceFiles(path.join(root, 'src'))) {
    const relPath = path.relative(root, file)
    violations.push(...findEgressViolations(await readFile(file, 'utf8'), relPath))
  }
  violations.push(
    ...findExternalOrigins(await readFile(path.join(root, 'index.html'), 'utf8'), 'index.html'),
  )

  if (violations.length > 0) {
    console.error('✗ 零外发断言失败：发现未声明的网络访问')
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line}  [${violation.rule}]  ${violation.text}`)
    }
    console.error(`\n白名单：${EGRESS_WHITELIST.join(', ')}`)
    process.exitCode = 1
    return
  }

  console.log('✓ 零外发断言通过：src/ 与 index.html 除白名单外无网络访问')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
