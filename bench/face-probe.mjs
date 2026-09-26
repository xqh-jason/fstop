/**
 * 人脸链探针的驱动器：打开 /bench/faces.html，把页面里逐段计时与错误读出来。
 *
 * 用法：先起 dev server，再
 *   node bench/face-probe.mjs            # WebGPU
 *   PROBE_MODEL=wasm node bench/face-probe.mjs
 */
import { chromium } from '@playwright/test'
import path from 'node:path'

const PORT = Number(process.env.PROBE_PORT ?? 5198)
const BASE = `http://127.0.0.1:${PORT}`
const MODE = process.env.PROBE_MODE ?? 'sweep'
const IMAGE = process.env.PROBE_IMAGE ?? 'obama-01.jpg'
const PROFILE = path.resolve('.cache', 'bench-profile')
const TIMEOUT = Number(process.env.PROBE_TIMEOUT ?? 600) * 1000

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  args: ['--use-webgpu', '--enable-dawn-features=use_dxc'],
})
const page = context.pages()[0] ?? (await context.newPage())
page.on('console', (message) => console.log(`[console:${message.type()}] ${message.text()}`))
page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`))
page.on('requestfailed', (request) =>
  console.log(
    `[requestfailed] ${request.url().slice(0, 120)} — ${request.failure()?.errorText ?? ''}`,
  ),
)
page.on('response', (response) => {
  const url = response.url()
  if (url.includes('huggingface') || url.endsWith('.onnx')) {
    console.log(`[response] ${response.status()} ${url.slice(0, 120)}`)
  }
})

await page.goto(`${BASE}/bench/faces.html?mode=${MODE}&image=${IMAGE}`, { waitUntil: 'load' })
// Vite 发现新依赖（探针页首次引入 comlink）会做一次依赖预构建并**整页重载**，
// 这一下会把 evaluate 的执行上下文打掉——先给它时间安定，再开始读状态。
await new Promise((resolve) => setTimeout(resolve, 4000))

async function readState() {
  // 重载期间 evaluate 会抛「Execution context was destroyed」，重试即可（不是探针失败）
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await page.evaluate(() => ({
        text: document.querySelector('#out')?.textContent ?? '',
        probe: document.body.dataset.probe ?? '',
      }))
    } catch (error) {
      console.log(
        `（页面重载中，重试：${error instanceof Error ? error.message.slice(0, 60) : ''}）`,
      )
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  throw new Error('页面一直取不到状态')
}

const started = Date.now()
let last = ''
for (;;) {
  if (Date.now() - started > TIMEOUT) {
    console.log(`\n超时（${String(TIMEOUT / 1000)} s）。当前输出：`)
    console.log(last)
    await context.close()
    process.exit(1)
  }
  const state = await readState()
  if (state.text !== last) {
    // 只打印新增的行，避免刷屏
    const previous = last.split('\n')
    const current = state.text.split('\n')
    for (const line of current.slice(previous.length - 1)) if (line.trim() !== '') console.log(line)
    last = state.text
  }
  if (state.probe !== '') {
    console.log(`\n探针结束：${state.probe}`)
    await context.close()
    process.exit(state.probe === 'done' ? 0 : 1)
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
