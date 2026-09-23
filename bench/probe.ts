/**
 * M0 探针 —— 一次性回答 §九 第 1/2/3 项里所有「只能靠实测」的未知。
 *
 * 要回答的问题（每一条都对应一个会改变计划的判断）：
 * 1. 显式 dtype 下 transformers.js 到底请求哪些文件、多少字节、耗时多少（第 1 项）
 * 2. Chinese-CLIP 是单文件双塔模型：单会话能否只算图像侧？还是每次都要跑两个塔（第 2 项）
 * 3. 热会话单张向量化延迟是否 ≤ 150 ms（第 2 项，决定后续所有数字）
 * 4. 无头/软件 WebGPU 适配器必须能被识别出来，否则性能数字是假的（§5.2）
 * 5. `createImageBitmap` 能否解开 HEIC（第 3 项）
 *
 * 结果同时写入 `window.__PROBE_RESULT` 与 `#out`，由 Playwright / 浏览器工具抓取。
 */

import { AutoModel, AutoProcessor, env, pipeline } from '@huggingface/transformers'

interface StepResult {
  name: string
  ok: boolean
  ms: number
  detail?: unknown
  error?: string
}

const params = new URLSearchParams(location.search)
const DTYPES = ['q4f16', 'fp16', 'fp32', 'q8'] as const
const DEVICES = ['webgpu', 'wasm'] as const
const DTYPE = DTYPES.find((candidate) => candidate === params.get('dtype')) ?? 'q4f16'
const DEVICE = DEVICES.find((candidate) => candidate === params.get('device')) ?? 'webgpu'
const CHINESE_CLIP = 'Xenova/chinese-clip-vit-base-patch16'
const ENGLISH_CLIP = 'Xenova/clip-vit-base-patch32'

const results: StepResult[] = []
const output = document.getElementById('out')

function render(): void {
  if (output === null) return
  output.textContent = results
    .map((result) => {
      const head = `${result.ok ? '✓' : '✗'} ${result.name}  ${result.ms} ms`
      const body =
        result.error ??
        (result.detail === undefined ? '' : JSON.stringify(result.detail, null, 2).slice(0, 4000))
      return `${head}\n${body}`
    })
    .join('\n\n')
  ;(window as unknown as { __PROBE_RESULT: StepResult[] }).__PROBE_RESULT = results
}

async function step(name: string, run: () => Promise<unknown>): Promise<unknown> {
  const started = performance.now()
  try {
    const detail = await run()
    results.push({ name, ok: true, ms: Math.round(performance.now() - started), detail })
    render()
    return detail
  } catch (error) {
    results.push({
      name,
      ok: false,
      ms: Math.round(performance.now() - started),
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
    render()
    return undefined
  }
}

/** 同一个 origin 的下载在 Resource Timing 里可能因缺 Timing-Allow-Origin 而 transferSize 归零，两个都记 */
function remoteResources(): unknown[] {
  return performance
    .getEntriesByType('resource')
    .filter((entry) => /huggingface\.co|hf\.co/.test(entry.name))
    .map((entry) => ({
      file: entry.name.replace(/^https:\/\/[^/]+\//, ''),
      transferBytes: (entry as PerformanceResourceTiming).transferSize,
      bodyBytes: (entry as PerformanceResourceTiming).encodedBodySize,
      ms: Math.round(entry.duration),
    }))
}

async function sampleImage(): Promise<Blob> {
  const manifest = (await (await fetch('/samples/manifest.json')).json()) as { file: string }[]
  const first = manifest[0]
  if (first === undefined) throw new Error('样例库为空')
  const response = await fetch(`/samples/${first.file}`)
  return response.blob()
}

async function measure(rounds: number, run: () => Promise<unknown>): Promise<number[]> {
  const timings: number[] = []
  for (let index = 0; index < rounds; index += 1) {
    const started = performance.now()
    await run()
    timings.push(Math.round(performance.now() - started))
  }
  return timings
}

function summarize(timings: number[]): { first: number; min: number; median: number } {
  const sorted = [...timings].sort((a, b) => a - b)
  return {
    first: timings[0] ?? 0,
    min: sorted[0] ?? 0,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
  }
}

async function main(): Promise<void> {
  await step('env', async () => ({
    dtype: DTYPE,
    device: DEVICE,
    remoteHost: env.remoteHost,
    allowRemoteModels: env.allowRemoteModels,
    allowLocalModels: env.allowLocalModels,
    useBrowserCache: env.useBrowserCache,
    wasmThreads: env.backends?.onnx?.wasm?.numThreads,
  }))

  await step('webgpu-adapter', async () => {
    const adapter = (await navigator.gpu?.requestAdapter()) ?? null
    if (adapter === null) return { available: false }
    const info = (adapter as unknown as { info?: Record<string, unknown> }).info ?? {}
    return {
      available: true,
      info,
      features: [...adapter.features].slice(0, 8),
      limits: { maxBufferSize: adapter.limits.maxBufferSize },
    }
  })

  env.allowLocalModels = false
  env.useBrowserCache = true

  // ── Chinese-CLIP：单文件双塔，是本轮最关键的未知 ─────────────────────────
  const chineseModel = await step(`load:AutoModel:${CHINESE_CLIP}[${DTYPE}]`, async () => {
    const model = await AutoModel.from_pretrained(CHINESE_CLIP, { dtype: DTYPE, device: DEVICE })
    const session = (model as unknown as { sessions?: Record<string, unknown> }).sessions ?? {}
    return { sessions: Object.keys(session) }
  })

  const chineseProcessor = await step(`load:AutoProcessor:${CHINESE_CLIP}`, () =>
    AutoProcessor.from_pretrained(CHINESE_CLIP),
  )

  const blob = await sampleImage()
  const bitmap = await createImageBitmap(blob)

  if (chineseModel !== undefined) {
    const processor = chineseProcessor as {
      (images: unknown): Promise<Record<string, unknown>>
      tokenizer: (text: string[], options: Record<string, unknown>) => Record<string, unknown>
    }
    const call = chineseModel as unknown as (
      inputs: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>

    const pixelInputs = await processor(bitmap)
    await step('image-embed:chinese-clip (cold)', async () => {
      const started = performance.now()
      const outputs = await call(pixelInputs)
      return {
        wallMs: Math.round(performance.now() - started),
        outputKeys: Object.keys(outputs),
        dims: Object.fromEntries(
          Object.entries(outputs).map(([key, value]) => [
            key,
            (value as { dims?: number[] }).dims ?? null,
          ]),
        ),
      }
    })

    await step('image-embed:chinese-clip (warm ×10)', async () => {
      const timings = await measure(10, () => call(pixelInputs))
      return { ...summarize(timings), timings, resources: remoteResources() }
    })

    const textInputs = processor.tokenizer(['一只狗在雪地里'], { padding: true, truncation: true })
    await step('text-embed:chinese-clip (cold+warm ×10)', async () => {
      const started = performance.now()
      const outputs = await call(textInputs)
      const cold = Math.round(performance.now() - started)
      const timings = await measure(10, () => call(textInputs))
      return {
        coldMs: cold,
        ...summarize(timings),
        outputKeys: Object.keys(outputs),
        dims: Object.fromEntries(
          Object.entries(outputs).map(([key, value]) => [
            key,
            (value as { dims?: number[] }).dims ?? null,
          ]),
        ),
      }
    })
  }

  // ── 英文 CLIP：vision/text 分文件，作为对照 ──────────────────────────────
  const vision = await step(`pipeline:image-feature-extraction:${ENGLISH_CLIP}[${DTYPE}]`, () =>
    pipeline('image-feature-extraction', ENGLISH_CLIP, { dtype: DTYPE, device: DEVICE }),
  )
  await step(`image-embed:${ENGLISH_CLIP} (warm ×10)`, async () => {
    const run = vision as unknown as (image: unknown) => Promise<{ dims: number[] }>
    const timings = await measure(10, () => run(bitmap))
    return { ...summarize(timings), timings, resources: remoteResources() }
  })

  const text = await step(`pipeline:feature-extraction:${ENGLISH_CLIP}[${DTYPE}]`, () =>
    pipeline('feature-extraction', ENGLISH_CLIP, { dtype: DTYPE, device: DEVICE }),
  )
  await step(`text-embed:${ENGLISH_CLIP} (warm ×10)`, async () => {
    const run = text as unknown as (input: string[]) => Promise<{ dims: number[] }>
    const timings = await measure(10, () => run(['a dog in the snow']))
    return { ...summarize(timings), timings }
  })

  // ── 第 3 项：HEIC 解码 ────────────────────────────────────────────────
  await step('heic:createImageBitmap', async () => {
    const candidates = ['/bench-fixtures/sample.heic', '/bench-fixtures/private/iphone.heic']
    for (const url of candidates) {
      const response = await fetch(url)
      if (!response.ok) continue
      const heic = await response.blob()
      const decoded = await createImageBitmap(heic)
      return { url, bytes: heic.size, width: decoded.width, height: decoded.height }
    }
    return { skipped: true, reason: '没有 HEIC 夹具，见 bench/fixtures/README' }
  })

  render()
}

await main()
