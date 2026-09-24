import { env } from '@huggingface/transformers'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DTYPE,
  DEFAULT_MODEL_ID,
  DERIVED_MODEL_BASE,
  configureModelRuntime,
  modelBytes,
  modelSpec,
} from '../../src/storage/models'

describe('模型目录（纯函数部分）', () => {
  it('默认模型的目录项与 dtype 档位齐全', () => {
    const spec = modelSpec()
    expect(spec.id).toBe(DEFAULT_MODEL_ID)
    expect(spec.dim).toBe(512)
    expect(Object.keys(spec.dtypes).sort()).toEqual(['fp16', 'fp32', 'q4f16'])
    expect(DEFAULT_DTYPE).toBe('q4f16')
  })

  it('未知模型立即抛错，而不是回落到默认模型', () => {
    expect(() => modelSpec('nope/not-a-model')).toThrow(/未知模型/)
  })

  it('modelBytes 是档位内所有文件之和（界面上的首启下载量就是它）', () => {
    const spec = modelSpec()
    const expected = spec.dtypes.q4f16.reduce((total, file) => total + file.bytes, 0)
    expect(modelBytes(DEFAULT_MODEL_ID, 'q4f16')).toBe(expected)
    // q4f16 明显小于 fp32：默认档位选错的代价就是这个差距
    expect(modelBytes(DEFAULT_MODEL_ID, 'q4f16')).toBeLessThan(modelBytes(DEFAULT_MODEL_ID, 'fp32'))
  })

  it('派生产物目录是 public 下的同源路径（不是外链）', () => {
    expect(DERIVED_MODEL_BASE.startsWith('/')).toBe(true)
    expect(DERIVED_MODEL_BASE).not.toMatch(/^https?:/)
  })
})

describe('configureModelRuntime', () => {
  it('把 ORT 的 wasm 运行时钉到同源资源，而不是留成 CDN 默认值', () => {
    configureModelRuntime()
    const wasm = env.backends.onnx.wasm
    expect(wasm).toBeDefined()
    const wasmPaths = wasm?.wasmPaths as { wasm?: string } | undefined
    expect(wasmPaths?.wasm).toBeDefined()
    // 关键断言：不能是 CDN（transformers.js 的默认值就是 jsdelivr，冷缓存首访会真发请求）
    expect(String(wasmPaths?.wasm)).not.toMatch(/^https?:\/\//)
  })

  it('remoteHost 只在显式给出时覆盖（默认留给 transformers.js 的 HF 默认值）', () => {
    configureModelRuntime({ remoteHost: 'https://hf-mirror.com' })
    expect(env.remoteHost).toBe('https://hf-mirror.com')
    configureModelRuntime()
    expect(env.allowLocalModels).toBe(false)
    expect(env.useBrowserCache).toBe(true)
  })
})
