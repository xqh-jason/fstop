#!/usr/bin/env node
/**
 * 模型权重拉取 + 校验 —— 见项目计划 §7.2「权重分发原则」。
 *
 * 仓库**不分发权重**，只提供本脚本与校验值。因此：
 * - 权重落在 `.cache/models/`（已 gitignore），不进仓库、不进 `public/`
 * - `public/models/manifest.json` 记录每个文件的实际字节数、sha256、来源与 dtype 档位
 * - 期望字节数是硬编码的（2026-09-23 实测），上游重新上传会立刻暴露，而不是静默换了权重
 *
 * 用法：
 *   node scripts/fetch-models.mjs                # 默认档 q4f16
 *   node scripts/fetch-models.mjs --dtype fp16   # 质量档
 *   node scripts/fetch-models.mjs --all          # 逐档下载并记录
 *   NODE_USE_ENV_PROXY=1 node scripts/fetch-models.mjs   # 走系统代理（Node fetch 默认不读代理环境变量）
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const CACHE_DIR = path.join(process.cwd(), '.cache', 'models')
const MANIFEST_PATH = path.join(process.cwd(), 'public', 'models', 'manifest.json')
const USER_AGENT = 'fstop-model-fetcher/0.1 (+https://github.com/xqh-jason/fstop)'

/** 每个模型都必须带的配置与分词器文件；少一个，transformers.js 会在运行时才炸 */
const SUPPORT_FILES = [
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
]

/**
 * 权重档位表。`bytes` 为 2026-09-23 从 HF API（`?blobs=true`）实测的**确切字节数**。
 * 体积结论（十进制 MB）：Chinese-CLIP ViT-B/16 是单文件模型，
 * fp32 753.7 / fp16 377.4 / q4f16 131.8 / q4 177.7 / uint8 190.2 / bnb4 167.0。
 */
const MODELS = [
  {
    id: 'Xenova/chinese-clip-vit-base-patch16',
    space: 'chinese-clip-vit-b16',
    dim: 512,
    license: '模型卡未声明 license（同门 chinese-clip-rn50 标 apache-2.0）→ 不再分发，仅脚本拉取',
    dtypes: {
      q4f16: [{ file: 'onnx/model_q4f16.onnx', bytes: 131794439 }],
      fp16: [{ file: 'onnx/model_fp16.onnx', bytes: 377377730 }],
    },
  },
  {
    id: 'Xenova/clip-vit-base-patch32',
    space: 'clip-vit-b32',
    dim: 512,
    license: 'MIT',
    dtypes: {
      q4f16: [
        { file: 'onnx/vision_model_q4f16.onnx', bytes: 53267374 },
        { file: 'onnx/text_model_q4f16.onnx', bytes: 72531963 },
      ],
    },
  },
]

/** @param {string[]} argv */
function parseArgs(argv) {
  const requested = argv.includes('--all')
    ? ['q4f16', 'fp16']
    : argv.includes('--dtype')
      ? [argv[argv.indexOf('--dtype') + 1]]
      : ['q4f16']
  return requested
}

/** 代理链路会偶发 ECONNRESET，重试比让整轮下载作废便宜得多 */
async function withRetry(label, task, attempts = 4) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      console.warn(`  ! ${label} 第 ${attempt}/${attempts} 次失败：${error.message}`)
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
    }
  }
  throw lastError
}

/** @param {string} repo @param {string} file */
async function remoteBytes(repo, file) {
  const url = `https://huggingface.co/${repo}/resolve/main/${file}`
  const response = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok) throw new Error(`HEAD ${response.status} for ${url}`)
  const length = response.headers.get('content-length')
  return length === null ? null : Number(response.headers.get('x-linked-size') ?? length)
}

/** @param {string} repo @param {string} file @param {string} target */
async function downloadFile(repo, file, target) {
  const url = `https://huggingface.co/${repo}/resolve/main/${file}`
  const started = Date.now()
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok || response.body === null) throw new Error(`GET ${response.status} for ${url}`)

  const chunks = []
  let received = 0
  let lastReport = 0
  for await (const chunk of response.body) {
    chunks.push(chunk)
    received += chunk.length
    if (received - lastReport > 16 * 1024 * 1024) {
      lastReport = received
      console.log(`    … ${(received / 1024 / 1024).toFixed(1)} MB`)
    }
  }
  const buffer = Buffer.concat(chunks)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, buffer)
  const seconds = (Date.now() - started) / 1000
  return {
    bytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    seconds: Number(seconds.toFixed(2)),
    megabytesPerSecond: Number((buffer.byteLength / 1024 / 1024 / seconds).toFixed(2)),
  }
}

async function main() {
  const requested = parseArgs(process.argv.slice(2))
  /** @type {Record<string, unknown>[]} */
  const recorded = []
  let totalBytes = 0
  let totalSeconds = 0

  for (const model of MODELS) {
    for (const dtype of requested) {
      const files = model.dtypes[dtype]
      if (!files) continue
      console.log(`\n▶ ${model.id} [${dtype}]`)
      for (const entry of files) {
        const target = path.join(CACHE_DIR, model.space, dtype, path.basename(entry.file))
        const head = await withRetry(`${entry.file} HEAD`, () => remoteBytes(model.id, entry.file))
        if (head !== null && head !== entry.bytes) {
          throw new Error(
            `${entry.file}: 上游体积已变（期望 ${entry.bytes}，实际 ${head}）——先核对再更新本脚本的期望值`,
          )
        }
        const existing = await stat(target).catch(() => null)
        const result =
          existing?.isFile() === true && existing.size === entry.bytes
            ? await fileDigest(target)
            : await withRetry(`${entry.file} GET`, () => downloadFile(model.id, entry.file, target))
        if (result.bytes !== entry.bytes) {
          throw new Error(`${entry.file}: 落盘体积 ${result.bytes} ≠ 期望 ${entry.bytes}`)
        }
        totalBytes += result.bytes
        totalSeconds += 'seconds' in result ? Number(result.seconds) : 0
        console.log(
          `  ✓ ${entry.file.padEnd(34)} ${(result.bytes / 1024 / 1024).toFixed(1)} MB  ${result.sha256.slice(0, 16)}…${'megabytesPerSecond' in result ? `  ${result.megabytesPerSecond} MB/s` : '  (缓存命中)'}`,
        )
        recorded.push({
          model_id: model.id,
          space: model.space,
          dim: model.dim,
          dtype,
          file: entry.file,
          bytes: result.bytes,
          sha256: result.sha256,
          source: `https://huggingface.co/${model.id}/blob/main/${entry.file}`,
          license: model.license,
        })
      }
      for (const file of SUPPORT_FILES) {
        const target = path.join(CACHE_DIR, model.space, dtype, file)
        const result = await downloadFile(model.id, file, target).catch(() => null)
        if (result !== null) console.log(`    + ${file} (${result.bytes} B)`)
      }
    }
  }

  await mkdir(path.dirname(MANIFEST_PATH), { recursive: true })
  await writeFile(
    MANIFEST_PATH,
    `${JSON.stringify({ measured_at: '2026-09-23', models: recorded }, null, 2)}\n`,
  )
  console.log(
    `\n合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB，用时 ${totalSeconds.toFixed(1)} s（未命中缓存的下载），清单 → public/models/manifest.json`,
  )
}

/** @param {string} target */
async function fileDigest(target) {
  const buffer = await readFile(target)
  return {
    bytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

await main()
