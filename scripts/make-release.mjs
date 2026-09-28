/**
 * 打包发布物：把 `dist/` 变成**可以真的分发**的东西。
 *
 * 为什么需要这一步（不是多此一举）：
 * `public/models/derived/` 里是**派生的模型权重**（Chinese-CLIP 权重的改写版），
 * 上游模型卡没有授权再分发 —— 它只在本机生成、本机使用，**一旦出现在发布物里就等于再分发**。
 * 而 `pnpm build` 会照搬 `public/`，所以 `dist/` 里默认就有这两个 onnx。
 * 这个脚本把它们剥掉，并且**只要最终产物里还有任何 `.onnx` 就直接失败**（红线做成可执行检查）。
 *
 * 用法：
 *   pnpm build && node scripts/make-release.mjs            # 版本取自 package.json
 *   node scripts/make-release.mjs --out ~/code/fstop-release
 *
 * 产物目录里会写一份 RELEASE.txt（提交、门禁、张数、校验和）与 SHA256SUMS。
 */

import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const ROOT = process.cwd()
const DIST = path.resolve(ROOT, 'dist')
const pkg = JSON.parse(await readFile(path.resolve(ROOT, 'package.json'), 'utf8'))
const outArgIndex = process.argv.indexOf('--out')
const OUT_ROOT =
  outArgIndex === -1
    ? path.resolve(os.homedir(), 'code', 'fstop-release')
    : path.resolve(process.argv[outArgIndex + 1])
const NAME = `fstop-${pkg.version}-dist`
const TARGET = path.join(OUT_ROOT, NAME)

const red = (text) => `\x1b[31m${text}\x1b[0m`
const green = (text) => `\x1b[32m${text}\x1b[0m`

await stat(DIST).catch(() => {
  console.error(red(`没有 dist/ —— 先跑 pnpm build`))
  process.exit(1)
})

// 清掉上次的产物，重新拷一份（排除派生的模型权重）
await rm(TARGET, { recursive: true, force: true })
await mkdir(TARGET, { recursive: true })
await cp(DIST, TARGET, {
  recursive: true,
  filter: (source) => !source.includes(path.join('models', 'derived')),
})

/** 走一遍产物树，返回所有文件（相对路径） */
async function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)))
    else out.push(rel)
  }
  return out
}

const files = await listFiles(TARGET)

// 红线：发布物里不许出现任何模型权重
const weights = files.filter((file) => /\.(onnx|safetensors|bin|pt|pth)$/.test(file))
if (weights.length > 0) {
  console.error(red(`发布物里有模型权重，已中止：\n  ${weights.join('\n  ')}`))
  console.error('派生产物只本地使用；上游模型卡未授权再分发。')
  process.exit(1)
}

const samples = files.filter(
  (file) => file.startsWith('samples/') && file !== 'samples/manifest.json',
)
const sampleManifest = JSON.parse(
  await readFile(path.resolve(ROOT, 'public/samples/manifest.json'), 'utf8'),
)
if (samples.length !== sampleManifest.length) {
  console.error(red(`样例张数对不上：产物 ${samples.length} vs 清单 ${sampleManifest.length}`))
  process.exit(1)
}
if (!files.includes('index.html')) {
  console.error(red('产物里没有 index.html'))
  process.exit(1)
}

// 校验和（分发后可以核对，也让「这个产物就是那次验证过的产物」可追）
const sums = []
let bytes = 0
for (const file of files.sort()) {
  const data = await readFile(path.join(TARGET, file))
  bytes += data.byteLength
  sums.push(`${createHash('sha256').update(data).digest('hex')}  ${file}`)
}
await writeFile(path.join(TARGET, 'SHA256SUMS'), `${sums.join('\n')}\n`)

const git = (...args) => execFileSync('git', args, { cwd: ROOT }).toString().trim()
const commit = git('rev-parse', 'HEAD')
const commitSubject = git('log', '-1', '--pretty=%s')
const dirty = git('status', '--porcelain') !== ''

const releaseTxt = `Fstop / 光圈 · 发布物
版本        ${pkg.version}
产物目录    ${NAME}
源码提交    ${commit}  ${commitSubject}
工作区      ${dirty ? '有未提交改动（本产物对应的源码不等于该提交）' : '干净'}
生成时间    ${new Date().toISOString()}
文件数      ${files.length}
总大小      ${(bytes / 1024 / 1024).toFixed(1)} MB
内置样例    ${samples.length} 张（CC0 / 公有领域，见 samples/manifest.json）

模型权重    **不包含**（派生产物只本地生成、不分发；运行时按需从模型 origin 取，浏览器缓存）
校验        sha256sum -c SHA256SUMS

验证过的门禁
  pnpm verify ......................... 单测 + typecheck + lint + 静态零外发断言
  node bench/e2e-samples.mjs .......... 静态托管本产物：样例索引 → 检索 → 零外发
  node bench/e2e-faces.mjs ............ 人脸链路 + 人物面板像素级断言（7 条画面断言）

部署       任意静态托管（无常驻进程、无服务端）。所有路由都是 index.html。
`
await writeFile(path.join(TARGET, 'RELEASE.txt'), releaseTxt)

const tarball = path.join(OUT_ROOT, `${NAME}.tar.gz`)
await rm(tarball, { force: true })
execFileSync('tar', ['-czf', tarball, '-C', OUT_ROOT, NAME])

console.log(green(`发布物已就绪：${TARGET}`))
console.log(
  `  文件 ${files.length} 个 / ${(bytes / 1024 / 1024).toFixed(1)} MB（已剥离派生模型权重）`,
)
console.log(`  样例 ${samples.length} 张，清单一致`)
console.log(`  校验 ${path.join(TARGET, 'SHA256SUMS')}`)
console.log(`  压缩包 ${tarball}`)
