/**
 * 人脸端到端：真语料（11 张**带人物标签**的公有领域照片：6 张奥巴马、5 张拜登）上跑完整链路。
 *
 * 断言分三层，每层都对着「用户会骂的点」：
 * 1. **检测**：检出的人脸数 ≥ 照片数的一半（一张单人肖像至少一张脸）
 * 2. **聚类正确性（带标签）**：
 *    - 至少一个组里全是奥巴马照片的脸（同人必须同组）
 *    - 至少一个组里全是拜登照片的脸
 *    - **没有任何组同时含 ≥2 张奥巴马照片的脸与 ≥2 张拜登照片的脸**（不把两个人合成一个人）
 * 3. **命名 / 合并 / 拆分**（用户能操作）：
 *    - 命名后名字留在面板上，且「重新识别」不会把它冲掉（名字是用户资产）
 *    - 合并两组后组数 -1，且保留的是目标组的名字
 *    - 拆出一张脸后组数 +1
 *
 * 用法：先起 dev server（pnpm dev --port 5198 --host 127.0.0.1），
 * 再 node bench/e2e-faces.mjs（首次会从模型 origin 下载人脸模型约 300 MB）
 */
import { chromium } from '@playwright/test'
import { execSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const PORT = Number(process.env.PROBE_PORT ?? 5198)
const BASE = `http://127.0.0.1:${PORT}`
const OPFS_DIR = process.env.PROBE_OPFS ?? 'faces-corpus'
const PROFILE = path.resolve('.cache', 'bench-profile')
const MANIFEST = path.join('bench', 'corpus-faces', 'manifest.json')

const failures = []
function check(label, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
process.on('exit', () => {
  if (failures.length > 0) {
    console.error(`\n端到端失败 ${failures.length} 项：`)
    for (const label of failures) console.error(` - ${label}`)
    process.exitCode = 1
  } else {
    console.log('\n端到端全部通过：人脸检测/聚类/命名/合并/拆分在真语料上行为正确。')
  }
})

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
const personOf = new Map(manifest.files.map((entry) => [entry.file, entry.person]))
const byPerson = manifest.files.reduce((acc, entry) => {
  acc[entry.person] = (acc[entry.person] ?? 0) + 1
  return acc
}, {})
console.log(`语料：${JSON.stringify(byPerson)}（共 ${manifest.files.length} 张）`)

try {
  execSync(`pkill -f "user-data-dir=${PROFILE}"`, { stdio: 'ignore' })
} catch {
  // 没有残留
}
await new Promise((resolve) => setTimeout(resolve, 2000))

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  args: ['--use-webgpu', '--enable-dawn-features=use_dxc'],
})
const page = context.pages()[0] ?? (await context.newPage())
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))
const external = new Set()
page.on('request', (request) => {
  const url = new URL(request.url())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return
  external.add(url.host)
})

// ——— 0. 确定性重置 ———
await page.goto(`${BASE}/vite.svg`, { waitUntil: 'load' })
const cleared = await page.evaluate(
  async (names) => {
    const root = await navigator.storage.getDirectory()
    const gone = []
    for (const name of names) {
      try {
        await root.removeEntry(name, { recursive: true })
        gone.push(name)
      } catch {
        // 本来就没有
      }
    }
    return gone
  },
  ['.fstop-vfs', 'fstop-vectors', 'fstop-thumbs', OPFS_DIR],
)
console.log(`重置：清掉 ${cleared.join(', ') || '（本来就没有）'}`)

// ——— 1. 播种带标签的人脸语料（同一个应用页里做）———
await page.goto(`${BASE}/?root=opfs&opfs=${OPFS_DIR}`, { waitUntil: 'load' })
const seeded = await page.evaluate(
  async ({ files, dir }) => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(dir, { create: true })
    const written = []
    for (const name of files) {
      const response = await fetch(`/bench/corpus-faces/${encodeURIComponent(name)}`)
      if (!response.ok) throw new Error(`语料取不到：${name}（${response.status}）`)
      const blob = await response.blob()
      const writable = await (
        await directory.getFileHandle(name, { create: true })
      ).createWritable()
      await writable.write(blob)
      await writable.close()
      written.push(name)
    }
    return written
  },
  { files: manifest.files.map((entry) => entry.file), dir: OPFS_DIR },
)
check('播种带标签人脸语料', seeded.length === manifest.files.length, `${seeded.length} 张`)

// ——— 2. 先建照片索引（人脸任务依赖库里的照片行）———
await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, {
  timeout: 300_000,
})
await page.locator('button', { hasText: '建立索引' }).click()
await page
  .waitForFunction(
    () => /索引完成/.test(document.querySelector('.status')?.textContent ?? ''),
    undefined,
    {
      timeout: 300_000,
    },
  )
  .catch(async () => {
    const state = await page.evaluate(() => ({
      ready: document.body.dataset.ready,
      text: document.body.innerText.slice(0, 400),
    }))
    console.error(`索引没到终态：${JSON.stringify(state, null, 2)}`)
    throw new Error('索引超时')
  })

// ——— 3. 跑人脸识别（首次会下载人脸模型）———
console.log('跑人脸识别（首次要下载人脸模型，约 300 MB）…')
await page.locator('[data-testid="people-run"]').click()
await page
  .waitForFunction(
    () =>
      /共 \d+ 张人脸|没有检出人脸/.test(document.body.innerText) ||
      /人脸识别中断|初始化失败/.test(document.body.innerText),
    undefined,
    { timeout: 900_000, polling: 1000 },
  )
  .catch(async () => {
    const state = await page.evaluate(() => ({
      status: document.querySelector('.people__status')?.textContent ?? '',
      text: document.body.innerText.slice(0, 600),
    }))
    console.error(`人脸识别没到终态：${JSON.stringify(state, null, 2)}`)
    throw new Error('人脸识别超时')
  })

const panel = await page.evaluate(() => {
  const summary = document.querySelector('[data-testid="people-summary"]')?.textContent ?? ''
  const clusters = [...document.querySelectorAll('.person')].map((node) => ({
    clusterId: Number(node.getAttribute('data-cluster-id')),
    name: node.getAttribute('data-name') ?? '',
    count: Number(
      /(\d+) 张/.exec(node.querySelector('.person__count')?.textContent ?? '')?.[1] ?? 0,
    ),
  }))
  return {
    summary: summary.replace(/\s+/g, ' ').trim(),
    clusters,
    text: document.body.innerText.slice(0, 400),
  }
})
console.log(`面板：${panel.summary}`)
console.log(`分组：${JSON.stringify(panel.clusters)}`)

const faceTotal = Number(/(\d+) 张人脸/.exec(panel.summary)?.[1] ?? 0)
check(
  '检出人脸',
  faceTotal >= manifest.files.length / 2,
  `${faceTotal} 张脸 / ${manifest.files.length} 张照片`,
)
check('分出至少 2 组', panel.clusters.length >= 2, `${panel.clusters.length} 组`)
check(
  '至少一组 ≥2 张（同人同组）',
  panel.clusters.some((cluster) => cluster.count >= 2),
  JSON.stringify(panel.clusters.map((cluster) => cluster.count)),
)

// ——— 4. 带标签的正确性检查：人脸 → 照片 → 人物 ———
// 组节点带 `data-members`（成员照片文件名），标签来自语料 manifest。
//
// **标注口径的坑**：语料里可能有「合影」（一张照片里同时有两个人），按文件名标注会把
// 合影里的另一张脸算成「另一个人」，于是看起来像「把两个人合成了一组」。所以：
// 只在**单脸照片**（这张照片只检出一张脸）上做纯度断言；多脸照片如实列出来，不参与判定。
const purity = await page.evaluate(() =>
  [...document.querySelectorAll('.person')].map((node) => ({
    clusterId: Number(node.getAttribute('data-cluster-id')),
    members: (node.getAttribute('data-members') ?? '').split(',').filter(Boolean),
  })),
)

const faceCountByFile = new Map()
for (const cluster of purity) {
  for (const file of cluster.members) {
    faceCountByFile.set(file, (faceCountByFile.get(file) ?? 0) + 1)
  }
}
const singleFaceFiles = new Set(
  [...faceCountByFile.entries()].filter(([, count]) => count === 1).map(([file]) => file),
)
const multiFaceFiles = [...faceCountByFile.entries()].filter(([, count]) => count > 1)
const multiFaceText =
  multiFaceFiles.length === 0
    ? ''
    : `：${multiFaceFiles.map(([file, count]) => `${file}×${String(count)}`).join(' ')}`
console.log(
  `检出脸的照片：${String(faceCountByFile.size)} 张（单脸 ${String(singleFaceFiles.size)}、` +
    `多脸 ${String(multiFaceFiles.length)}${multiFaceText}）`,
)

const clusterPersons = purity.map((cluster) => {
  const persons = new Set()
  let judged = 0
  for (const file of cluster.members) {
    if (!singleFaceFiles.has(file)) continue
    judged += 1
    const person = personOf.get(file)
    if (person !== undefined) persons.add(person)
  }
  return {
    clusterId: cluster.clusterId,
    files: cluster.members,
    faces: cluster.members.length,
    judged,
    persons: [...persons],
  }
})
for (const cluster of clusterPersons) {
  console.log(
    `  组 ${String(cluster.clusterId)}：${String(cluster.faces)} 张脸（可判定 ${String(cluster.judged)}）` +
      ` [${cluster.persons.join('+')}] ${cluster.files.join(', ')}`,
  )
}

const pureObama = clusterPersons.some(
  (cluster) =>
    cluster.persons.length === 1 && cluster.persons[0] === 'obama' && cluster.judged >= 2,
)
const pureBiden = clusterPersons.some(
  (cluster) =>
    cluster.persons.length === 1 && cluster.persons[0] === 'biden' && cluster.judged >= 2,
)
check(
  '存在「全是奥巴马」的组（≥2 张单脸照片）',
  pureObama,
  JSON.stringify(clusterPersons.map((c) => c.persons)),
)
check(
  '存在「全是拜登」的组（≥2 张单脸照片）',
  pureBiden,
  JSON.stringify(clusterPersons.map((c) => c.persons)),
)

// 关键断言：不把两个人合成一个人（只看单脸照片之间的混合）
const mixed = clusterPersons.filter((cluster) => cluster.persons.length > 1)
check(
  '没有把两个人合成一组',
  mixed.length === 0,
  mixed.length === 0 ? '无混合组' : JSON.stringify(mixed.map((c) => c.files)),
)

// ——— 5. 命名：名字要留住 ———
const targetCluster = panel.clusters[0]
if (targetCluster !== undefined) {
  const id = targetCluster.clusterId
  await ensureOpen(id)
  await page.locator(`[data-testid="people-name-${String(id)}"]`).fill('测试人物')
  await page
    .locator(`[data-testid="people-name-${String(id)}"]`)
    .locator('xpath=following-sibling::button')
    .click()
  await page.waitForFunction(
    (clusterId) =>
      document
        .querySelector(`.person[data-cluster-id="${String(clusterId)}"]`)
        ?.getAttribute('data-name') === '测试人物',
    id,
    { timeout: 30_000 },
  )
  check('命名生效（面板显示新名字）', true, '测试人物')
} else {
  check('命名生效（面板显示新名字）', false, '没有可命名的组')
}

// ——— 6. 合并：组数 -1，保留目标组的名字 ———
const before = await page.evaluate(() => document.querySelectorAll('.person').length)
const mergeInfo = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('.person')]
  return nodes.map((node) => ({
    id: Number(node.getAttribute('data-cluster-id')),
    name: node.getAttribute('data-name') ?? '',
  }))
})
const named = mergeInfo.find((cluster) => cluster.name === '测试人物')
const other = mergeInfo.find((cluster) => cluster.id !== named?.id)
if (named !== undefined && other !== undefined) {
  // 打开「别人」那一组，把它合并到「测试人物」
  await page.locator(`.person[data-cluster-id="${String(other.id)}"] .person__cover`).click()
  await page
    .locator(`[data-testid="people-merge-${String(other.id)}"]`)
    .selectOption(String(named.id))
  await page.locator(`[data-testid="people-merge-go-${String(other.id)}"]`).click()
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.person').length === expected,
    before - 1,
    { timeout: 30_000 },
  )
  const afterNames = await page.evaluate(() =>
    [...document.querySelectorAll('.person')].map((node) => node.getAttribute('data-name')),
  )
  check('合并后组数 -1', true, `${before} → ${before - 1}`)
  check('合并保留目标组的名字', afterNames.includes('测试人物'), afterNames.join(','))
} else {
  check('合并后组数 -1', false, '可合并的组不足')
}

// ——— 7. 拆分：选中一张脸 → 拆成新组（组数 +1）———
/** 确保某一组是展开状态（展开后才有名字输入、成员脸、拆分按钮） */
async function ensureOpen(clusterId) {
  const open = await page.evaluate(
    (id) =>
      document.querySelector(`.person[data-cluster-id="${String(id)}"] .person__body`) !== null,
    clusterId,
  )
  if (!open) {
    await page.locator(`.person[data-cluster-id="${String(clusterId)}"] .person__cover`).click()
    await page
      .locator(`.person[data-cluster-id="${String(clusterId)}"] .person__body`)
      .waitFor({ timeout: 10_000 })
  }
}

const beforeSplit = await page.evaluate(() => document.querySelectorAll('.person').length)
const splitTarget = await page.evaluate(() =>
  Number(document.querySelector('.person')?.getAttribute('data-cluster-id') ?? 0),
)
await ensureOpen(splitTarget)
await page
  .locator(`.person[data-cluster-id="${String(splitTarget)}"] .face`)
  .first()
  .click()
await page
  .locator(`.person[data-cluster-id="${String(splitTarget)}"] button`, { hasText: '拆成新组' })
  .click()
await page
  .waitForFunction(
    (expected) => document.querySelectorAll('.person').length === expected,
    beforeSplit + 1,
    { timeout: 30_000 },
  )
  .catch(() => {})
const afterSplit = await page.evaluate(() => document.querySelectorAll('.person').length)
check('拆出一张脸后组数 +1', afterSplit === beforeSplit + 1, `${beforeSplit} → ${afterSplit}`)

// ——— 7.5 名字必须活过「重新识别」（用户资产不能被重算冲掉）———
await page.locator('[data-testid="people-run"]').click()
await page
  .waitForFunction(() => /共 \d+ 张人脸|没有检出人脸/.test(document.body.innerText), undefined, {
    timeout: 900_000,
    polling: 1000,
  })
  .catch(() => {})
const namesAfter = await page.evaluate(() =>
  [...document.querySelectorAll('.person')].map((node) => node.getAttribute('data-name')),
)
check('重算后名字还在（命名组不被冲掉）', namesAfter.includes('测试人物'), namesAfter.join(','))

// ——— 8. 零外发（只有模型 origin）———
// HF 的权重 302 会落到自己的 CDN（`us.aws.cdn.hf.co`）—— 那是模型 origin，不是外部站点
const MODEL_HOSTS = [
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'hf-mirror.com',
  'hf.co',
]
const offenders = [...external].filter(
  (host) => !MODEL_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)),
)
check(
  '没有模型 origin 之外的外发',
  offenders.length === 0,
  [...external].join(', ') || '无外部请求',
)
check('没有页面未捕获异常', pageErrors.length === 0, pageErrors[0] ?? '无')

await context.close()
