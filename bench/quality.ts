/**
 * 检索质量页 —— M0 收口第 2 项：「中文 query 命中率」（交接说明 §9A2）。
 *
 * 为什么必须有这一页：M0 只测了速度，没测质量；而「双塔拆不拆」（交接说明 §9B）
 * 的真正裁判是检索质量——方案 A（英文单塔）速度最好，但如果中文 query 在它身上
 * 命中率崩掉，就违背了默认模型选型（Chinese-CLIP）的初衷。
 *
 * ground truth：内置 39 张 CC0 样例（`public/samples/`）是按 20 个主题、每主题约 2 张
 * 挑选的（`scripts/fetch-samples.mjs` 的 THEMES）。`bench/quality-queries.json` 为每个
 * 主题写一条「用户口吻」的中英 query；个别样例与主题名不符（bird-water-02 实为货轮
 * 日落、bicycle-street 无实车），已按**实际图片内容**拆成单图目标并逐张人工核实。
 * 命中定义：目标文件（该主题的全部样例）按余弦得分进入 top-k。
 *
 * 指标：Recall@1/5/10（最优目标排名 ≤ k 的 query 占比）与 MRR（1/最优排名的均值）。
 * zh 与 en 分别统计：zh 是选型裁判，en 用来观察各模型的跨语言表现。
 *
 * 参数：`?model=&dtype=`。结果写入 `window.__QUALITY_RESULT`。
 */

import * as Comlink from 'comlink'
import type { PhotoRef } from '../src/core/photo-source'
import { DEFAULT_DTYPE, DEFAULT_MODEL_ID } from '../src/storage/models'
import { HttpPhotoSource } from './http-photo-source'
import { DEFAULT_DECODE_OPTIONS, decodePhoto } from '../src/workers/decode'
import type { EmbedService } from '../src/workers/embed.worker'
import qualityQueries from './quality-queries.json'
import { targetsOf } from './query-targets'
import corpusQueries from './corpus-queries.json'

const params = new URLSearchParams(location.search)
const MODEL_ID = params.get('model') ?? DEFAULT_MODEL_ID
const DTYPES = ['q4f16', 'fp16', 'fp32'] as const
const DTYPE = DTYPES.find((candidate) => candidate === params.get('dtype')) ?? DEFAULT_DTYPE
const TOP_K = 10

interface QualityQuery {
  readonly id: string
  /** 样例文件名前缀：`file.startsWith(match + '-')`，主题级 target 填主题前缀，单图 target 填到序号 */
  readonly match: string | readonly string[]
  readonly zh: string
  readonly en: string
}

interface QueryOutcome {
  readonly id: string
  readonly targets: readonly string[]
  /** 目标文件的最优排名（1 起）；null = 目标不在 top-10 */
  readonly bestRank: number | null
  readonly error?: string
  readonly top3: ReadonlyArray<{ file: string; score: number }>
}

interface LangMetrics {
  readonly queries: number
  readonly recallAt1: number
  readonly recallAt5: number
  readonly recallAt10: number
  readonly mrr: number
  readonly perQuery: readonly QueryOutcome[]
}

const output = document.getElementById('out')

function render(payload: unknown): void {
  if (output !== null) output.textContent = JSON.stringify(payload, null, 2)
  ;(window as unknown as { __QUALITY_RESULT: unknown }).__QUALITY_RESULT = payload
  const phase = (payload as { phase?: string }).phase
  console.log(
    phase === undefined ? `done ${JSON.stringify(payload).slice(0, 300)}` : `phase ${phase}`,
  )
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0)
}

/** 暴力余弦 top-k：§7.1 自实现向量检索的那一层（与 query.ts 相同的实现） */
function topK(
  matrix: Float32Array,
  query: Float32Array,
  count: number,
  dim: number,
  k: number,
): ReadonlyArray<{ index: number; score: number }> {
  const scores = new Float32Array(count)
  for (let row = 0; row < count; row += 1) {
    let sum = 0
    const base = row * dim
    for (let column = 0; column < dim; column += 1) {
      sum += (matrix[base + column] ?? 0) * (query[column] ?? 0)
    }
    scores[row] = sum
  }
  return Array.from(scores.keys())
    .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))
    .slice(0, k)
    .map((index) => ({ index, score: Math.round((scores[index] ?? 0) * 1000) / 1000 }))
}

function summarize(outcomes: readonly QueryOutcome[]): LangMetrics {
  const ranked = outcomes.filter((outcome) => outcome.bestRank !== null)
  const hit = (k: number) => ranked.filter((o) => (o.bestRank ?? Infinity) <= k).length
  const total = outcomes.length
  return {
    queries: total,
    recallAt1: ranked.length === 0 ? 0 : Math.round((hit(1) / total) * 1000) / 1000,
    recallAt5: ranked.length === 0 ? 0 : Math.round((hit(5) / total) * 1000) / 1000,
    recallAt10: ranked.length === 0 ? 0 : Math.round((hit(10) / total) * 1000) / 1000,
    mrr:
      ranked.length === 0
        ? 0
        : Math.round(
            (ranked.reduce((sum, o) => sum + 1 / (o.bestRank ?? Infinity), 0) / total) * 1000,
          ) / 1000,
    perQuery: outcomes,
  }
}

async function main(): Promise<void> {
  // 图库与 query 集可换：默认 39 张样例 / 23 条 query（M0 §7），
  // `?gallery=bench/corpus&queries=corpus` 切到 783 张 / 106 条真实语料（M0 §9.9/§9.10 的口径）。
  // 小样例库的「R@1 100%」分不出 100% 与 87%，做决策必须用大图库。
  const GALLERY = params.get('gallery') || ''
  const QUERY_SET = params.get('queries') || 'samples'
  const queries =
    QUERY_SET === 'corpus'
      ? (corpusQueries as readonly QualityQuery[])
      : (qualityQueries as readonly QualityQuery[])
  const sourceRoot = GALLERY === '' ? 'samples' : 'corpus'
  const sourceBase = GALLERY === '' ? 'samples' : GALLERY
  render({ phase: 'load:samples', gallery: sourceBase, queries: queries.length })

  const source = await HttpPhotoSource.open(sourceRoot, location.origin, 0, sourceBase)
  const refs: PhotoRef[] = []
  for await (const ref of source.list()) refs.push(ref)
  const fileToIndex = new Map<string, number>()
  refs.forEach((ref, index) => fileToIndex.set(ref.relPath, index))

  // match → 目标文件（前缀 or 精确，见 bench/query-targets.ts）；配不上一张立即失败
  const targets = targetsOf(
    queries,
    refs.map((ref) => ref.relPath),
  )

  render({ phase: 'load:model', model: MODEL_ID, dtype: DTYPE, samples: refs.length })
  const embed = Comlink.wrap<EmbedService>(
    new Worker(new URL('../src/workers/embed.worker.ts', import.meta.url), { type: 'module' }),
  )
  // `?derived=0` 关掉派生单塔、`?derived=192` 钉住档位——这是「产品路径 vs 产品路径」的对照开关
  const derivedParam = params.get('derived') || null
  const derivedOptions =
    derivedParam === null
      ? {}
      : derivedParam === '0'
        ? { useDerived: false }
        : { derivedResolution: Number(derivedParam) }
  const model = await embed.init({
    modelId: MODEL_ID,
    dtype: DTYPE,
    device: 'webgpu',
    ...derivedOptions,
  })
  const dim = model.dim

  // 烟雾测试：不同文本必须得到不同向量。双塔路径曾把「占位零图」的 image_embeds
  // 当作文本向量返回（所有 query 同一个常量向量，检索结果与文本无关）——
  // 这种 bug 在延迟页上不可见（合成矩阵没有 ground truth），质量页必须在出数前拦住它。
  const smokeA = await embed.embedText('雪地里的狗')
  const smokeB = await embed.embedText('夜晚的城市')
  const identical =
    smokeA.length === smokeB.length && smokeA.every((value, index) => value === smokeB[index])
  if (identical) throw new Error('embedText 对不同文本返回了相同向量：嵌入输出选择有误')

  const matrix = new Float32Array(refs.length * dim)
  const imageTimings: number[] = []
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index]
    if (ref === undefined) continue
    const blob = await source.read(ref)
    const decoded = await decodePhoto(blob, DEFAULT_DECODE_OPTIONS)
    const started = performance.now()
    const vector = await embed.embedImage(decoded.bitmap)
    imageTimings.push(performance.now() - started)
    decoded.bitmap.close()
    matrix.set(vector, index * dim)
    if ((index + 1) % 10 === 0) console.log(`embedded ${index + 1}/${refs.length}`)
  }

  const textTimings: number[] = []
  const metrics: Record<string, LangMetrics> = {}
  for (const lang of ['zh', 'en'] as const) {
    const outcomes: QueryOutcome[] = []
    for (let q = 0; q < queries.length; q += 1) {
      const query = queries[q]
      if (query === undefined) continue
      try {
        const started = performance.now()
        const vector = await embed.embedText(query[lang])
        textTimings.push(performance.now() - started)
        const ranking = topK(matrix, vector, refs.length, dim, TOP_K)
        const targetSet = new Set(targets[q])
        let bestRank: number | null = null
        for (let position = 0; position < ranking.length; position += 1) {
          const hit = ranking[position]
          if (
            bestRank === null &&
            hit !== undefined &&
            targetSet.has(refs[hit.index]?.relPath ?? '')
          ) {
            bestRank = position + 1
          }
        }
        outcomes.push({
          id: query.id,
          targets: targets[q] ?? [],
          bestRank,
          top3: ranking.slice(0, 3).map((hit) => ({
            file: refs[hit.index]?.relPath ?? '',
            score: hit.score,
          })),
        })
      } catch (error) {
        outcomes.push({
          id: query.id,
          targets: targets[q] ?? [],
          bestRank: null,
          error: error instanceof Error ? error.message : String(error),
          top3: [],
        })
      }
    }
    metrics[lang] = summarize(outcomes)
    const m = metrics[lang]
    if (m !== undefined) {
      console.log(
        `${lang}: R@1 ${m.recallAt1} R@5 ${m.recallAt5} R@10 ${m.recallAt10} MRR ${m.mrr}`,
      )
    }
  }

  render({
    model,
    dtype: DTYPE,
    gallery: sourceBase,
    querySet: QUERY_SET,
    samples: refs.length,
    queries: queries.length,
    imageEmbedMs: { median: median(imageTimings) },
    textEmbedMs: { median: median(textTimings) },
    metrics,
  })
}

await main()
