/**
 * 检索延迟页 —— 补测项目计划 §八 的「语义检索响应（1 万张）≤ 300 ms」。
 *
 * 这一项 M0 起初没测，但它和双塔问题直接相关：**文本 query 也会把视觉塔白算一遍**，
 * 所以「查询延迟」很可能比索引延迟更早撞线。
 *
 * 它不需要索引：文本向量化 + 在扁平矩阵上暴力余弦排序就是检索的全部计算。
 * 参数：`?model=&dtype=&vectors=10000&dim=512&runs=10`
 */

import * as Comlink from 'comlink'
import { DEFAULT_DTYPE, DEFAULT_MODEL_ID, modelSpec } from '../src/storage/models'
import type { EmbedService } from '../src/workers/embed.worker'

const params = new URLSearchParams(location.search)
const MODEL_ID = params.get('model') ?? DEFAULT_MODEL_ID
const VECTOR_COUNT = Number(params.get('vectors') ?? 10_000)
const RUNS = Number(params.get('runs') ?? 10)
const TOP_K = 50
const QUERIES = [
  '一只狗在雪地里',
  '海边的日落',
  '夜晚的城市天际线',
  'a red flower closeup',
  '老式汽车',
]

const DTYPES = ['q4f16', 'fp16', 'fp32'] as const
const DTYPE = DTYPES.find((candidate) => candidate === params.get('dtype')) ?? DEFAULT_DTYPE

const output = document.getElementById('out')

function render(payload: unknown): void {
  if (output !== null) output.textContent = JSON.stringify(payload, null, 2)
  ;(window as unknown as { __QUERY_RESULT: unknown }).__QUERY_RESULT = payload
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 100) / 100
}

/** 归一化随机向量即可代表索引内容：余弦排序的成本只与规模有关，与向量取值无关 */
function syntheticIndex(count: number, dim: number): Float32Array {
  const matrix = new Float32Array(count * dim)
  let seed = 42
  for (let index = 0; index < matrix.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    matrix[index] = seed / 0x7fffffff - 0.5
  }
  for (let row = 0; row < count; row += 1) {
    let norm = 0
    for (let column = 0; column < dim; column += 1) {
      const value = matrix[row * dim + column] ?? 0
      norm += value * value
    }
    norm = Math.sqrt(norm)
    for (let column = 0; column < dim; column += 1) {
      matrix[row * dim + column] = (matrix[row * dim + column] ?? 0) / norm
    }
  }
  return matrix
}

/** 暴力余弦 top-k：§7.1 自实现向量检索的那一层 */
function topK(
  matrix: Float32Array,
  query: Float32Array,
  count: number,
  dim: number,
  k: number,
): number[] {
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
}

async function main(): Promise<void> {
  const dim = modelSpec(MODEL_ID).dim
  render({ phase: 'load', model: MODEL_ID, dtype: DTYPE })

  const embed = Comlink.wrap<EmbedService>(
    new Worker(new URL('../src/workers/embed.worker.ts', import.meta.url), { type: 'module' }),
  )
  const model = await embed.init({ modelId: MODEL_ID, dtype: DTYPE, device: 'webgpu' })

  const textTimings: number[] = []
  let vector: Float32Array | null = null
  for (let run = 0; run < RUNS; run += 1) {
    const query = QUERIES[run % QUERIES.length] ?? 'query'
    const started = performance.now()
    vector = await embed.embedText(query)
    textTimings.push(performance.now() - started)
  }

  const matrixStarted = performance.now()
  const matrix = syntheticIndex(VECTOR_COUNT, dim)
  const matrixBuildMs = Math.round(performance.now() - matrixStarted)

  const searchTimings: number[] = []
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now()
    topK(matrix, vector ?? new Float32Array(dim), VECTOR_COUNT, dim, TOP_K)
    searchTimings.push(performance.now() - started)
  }

  const textMs = median(textTimings)
  const searchMs = median(searchTimings)
  render({
    model,
    vectors: VECTOR_COUNT,
    dim,
    matrixBuildMs,
    textEmbedMs: { median: textMs, timings: textTimings.map((value) => Math.round(value)) },
    vectorSearchMs: { median: searchMs, timings: searchTimings.map((value) => Math.round(value)) },
    totalMedianMs: Math.round((textMs + searchMs) * 100) / 100,
    withinBudget: textMs + searchMs <= 300,
  })
}

await main()
