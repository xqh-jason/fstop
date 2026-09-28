#!/usr/bin/env node
/**
 * 生成 `THIRD_PARTY_NOTICES.md`。
 *
 * 为什么必须有这个文件：我们**分发构建产物**，产物里打包了 MIT / Apache-2.0 / BSD 等许可的第三方代码，
 * 这些许可都要求「保留版权与许可声明」。清单一旦手写就会悄悄过期 —— NOTICE §3 曾经写着
 * 「依赖尚未引入，接入时补全」，而依赖其实早就装好了。所以这里从**真实依赖图**生成，不许手改。
 *
 * 真相源 = `pnpm licenses list --prod --json`（pnpm 自己解析 lockfile 得到的生产依赖图）。
 *
 *   node scripts/make-third-party-notices.mjs          # 写入 THIRD_PARTY_NOTICES.md
 *   node scripts/make-third-party-notices.mjs --check   # 只校验是否与依赖图一致（门禁用）
 */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const OUTPUT = path.resolve('THIRD_PARTY_NOTICES.md')

/**
 * 生产依赖图里**只用于 Node 侧、不会进入浏览器产物**的包。
 * 判据不是「猜」：`dist/` 里对这些名字的引用数为 0（构建产物只含浏览器可用的部分）。
 * 其中 `@img/sharp-libvips-*` 是 LGPL-3.0-or-later —— 因为不随产物分发，不触发 LGPL 的再分发义务。
 */
const NODE_ONLY = [/^sharp$/, /^@img\/sharp-/, /^onnxruntime-node$/, /^@napi-rs\//]

/** 许可正文按许可 id 取一份，让文件自洽（Apache-2.0 明确要求附许可副本）。 */
const LICENSE_TEXT_IDS = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-3-Clause',
  'BSD-2-Clause',
  'ISC',
  'LGPL-3.0-or-later',
  '(MIT OR CC0-1.0)',
])

function graph() {
  const raw = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const byLicense = JSON.parse(raw)
  const flat = []
  for (const [license, entries] of Object.entries(byLicense)) {
    for (const entry of entries) {
      const version = (entry.versions ?? []).sort().at(-1) ?? '?'
      flat.push({
        name: entry.name,
        version,
        license,
        dir: (entry.paths ?? [])[0] ?? null,
      })
    }
  }
  flat.sort((a, b) => a.name.localeCompare(b.name))
  return flat
}

async function licenseTextOf(dir) {
  if (dir === null) return null
  let names
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const file = names.find((n) => /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i.test(n))
  if (file === undefined) return null
  const text = await readFile(path.join(dir, file), 'utf8')
  return { file, text: text.trim() }
}

function render(packages, texts) {
  const shipped = packages.filter((p) => !NODE_ONLY.some((re) => re.test(p.name)))
  const nodeOnly = packages.filter((p) => NODE_ONLY.some((re) => re.test(p.name)))
  const rows = (list) =>
    list.map((p) => `| \`${p.name}\` | ${p.version} | ${p.license} |`).join('\n')

  // 缺正文的许可不能静默漏掉：要么附正文，要么点名说清为什么没有。
  const missing = [...LICENSE_TEXT_IDS].filter((id) => !texts.has(id)).sort()
  const textsSection =
    [...LICENSE_TEXT_IDS]
      .filter((id) => texts.has(id))
      .map((id) => `### ${id}\n\n\`\`\`\n${texts.get(id)}\n\`\`\``)
      .join('\n\n') +
    (missing.length === 0
      ? ''
      : `\n\n以下许可在本地依赖目录里**没有附带正文副本**（这些包不随分发物发布，见 §2），` +
        `故此处只列许可名，不附正文：\n\n${missing.map((id) => `- \`${id}\``).join('\n')}\n`)

  return `# 第三方许可声明（THIRD_PARTY_NOTICES）

本文件列出**本项目分发物中包含的第三方代码**及其许可。Fstop 自身以 MIT 发布（见 \`LICENSE\`），
模型权重的来源与再分发限制另见 \`NOTICE\`。

本文件由 \`scripts/make-third-party-notices.mjs\` 从真实依赖图生成（\`pnpm licenses list --prod\`，
共 ${packages.length} 个生产依赖），**请勿手改**；依赖变更后重新运行脚本，门禁 \`pnpm verify\` 会检查是否过期。

## 1. 随浏览器构建产物分发的第三方代码

下载/部署 \`dist/\` 时，下面这些包以打包形式随产物分发（${shipped.length} 个）。
它们均为宽松许可，要求保留版权与许可声明 —— 正文见本文件末尾。

| 包 | 版本 | 许可 |
| --- | --- | --- |
${rows(shipped)}

## 2. 生产依赖图中只用于 Node 侧、不进入产物的包

这些包存在于生产依赖图（由 \`@huggingface/transformers\` 的 Node 代码路径引入），
但**不会出现在浏览器产物里** —— \`dist/\` 中对这些名字的引用数为 0，用户下载的静态文件里没有它们。
其中 \`@img/sharp-libvips-*\` 是 LGPL-3.0-or-later：因为不分发，不触发 LGPL 的再分发义务。

| 包 | 版本 | 许可 |
| --- | --- | --- |
${rows(nodeOnly)}

## 3. 不随发行物分发的依赖

开发与构建期依赖（Vite、Vitest、ESLint、Prettier、TypeScript、\`@playwright/test\`、\`vue-tsc\` 等）
只用于本仓库的开发与构建，不进入发行物，其许可与版本见 \`pnpm-lock.yaml\` 与各自的 \`package.json\`。

## 4. 本项目自身

| 内容 | 许可 |
| --- | --- |
| Fstop 源码（\`src/\`、\`bench/\`、\`scripts/\`） | MIT（\`LICENSE\`） |
| 内置样例图片（\`public/samples/\`，39 张） | CC0 / 公有领域，逐张来源见 \`public/samples/manifest.json\` |
| 模型权重 | **不随仓库或产物分发**，运行时从模型 origin 拉取，见 \`NOTICE\` |

## 附：许可正文

${textsSection}
`
}

async function main() {
  const packages = graph()
  const texts = new Map()
  for (const pkg of packages) {
    if (!LICENSE_TEXT_IDS.has(pkg.license) || texts.has(pkg.license)) continue
    const found = await licenseTextOf(pkg.dir)
    if (found !== null) texts.set(pkg.license, found.text)
  }
  const content = render(packages, texts)

  if (process.argv.includes('--check')) {
    let current = null
    try {
      current = await readFile(OUTPUT, 'utf8')
    } catch {
      current = null
    }
    if (current !== content) {
      console.error('✗ THIRD_PARTY_NOTICES.md 与依赖图不一致：请运行 `pnpm notices` 重新生成。')
      process.exit(1)
    }
    console.log(`✓ THIRD_PARTY_NOTICES.md 与依赖图一致（${packages.length} 个生产依赖）`)
    return
  }

  await writeFile(OUTPUT, content)
  const shipped = packages.filter((p) => !NODE_ONLY.some((re) => re.test(p.name))).length
  console.log(`✓ 已写入 THIRD_PARTY_NOTICES.md`)
  console.log(
    `  生产依赖 ${packages.length} 个：随产物分发 ${shipped} 个，Node 侧 ${packages.length - shipped} 个`,
  )
}

await main()
