import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DTYPE, discoverDerivedTowers } from '../../src/storage/models'
import { IMAGE_MEAN, IMAGE_STD, rgbaToChw } from '../../src/workers/embed-preprocess'

const MANIFEST = {
  model: 'Xenova/chinese-clip-vit-base-patch16',
  dtype: 'q4f16',
  vision: { file: 'vision192_q4f16.onnx', resolution: 192, tokens: 145, bytes: 49_800_000 },
  text: { file: 'text_q4f16.onnx', bytes: 81_700_000 },
  source: { file: '.cache/models/model_q4f16.onnx', sha256: 'x' },
}

function stubFetch(body: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('discoverDerivedTowers', () => {
  it('正常清单：透传分辨率 / token / 体积', async () => {
    stubFetch(MANIFEST)
    const plan = await discoverDerivedTowers({ modelId: 'Xenova/chinese-clip-vit-base-patch16' })
    expect(plan?.resolution).toBe(192)
    expect(plan?.tokens).toBe(145)
    expect(plan?.vision).toEqual({
      file: 'vision192_q4f16.onnx',
      bytes: 49_800_000,
      sha256: undefined,
    })
    expect(plan?.text.bytes).toBe(81_700_000)
    expect(plan?.base).toBe('/models/derived')
  })

  it('清单不存在（404）→ null，不抛', async () => {
    stubFetch({}, false)
    expect(await discoverDerivedTowers()).toBeNull()
  })

  it('请求本身失败（离线 / 目录不存在）→ null，不抛', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Failed to fetch')
      }),
    )
    expect(await discoverDerivedTowers()).toBeNull()
  })

  it('字段缺失 → null（半成品清单不能当可用产物）', async () => {
    stubFetch({ ...MANIFEST, vision: { file: 'vision192.onnx' } })
    expect(await discoverDerivedTowers()).toBeNull()
  })

  it('分辨率不匹配 → null（不能拿 160² 的产物当 192² 用）', async () => {
    stubFetch(MANIFEST)
    expect(await discoverDerivedTowers({ resolution: 160 })).toBeNull()
    expect(await discoverDerivedTowers({ resolution: 192 })).not.toBeNull()
  })

  it('模型不匹配 → null（切出来的塔只对源模型成立）', async () => {
    stubFetch(MANIFEST)
    expect(await discoverDerivedTowers({ modelId: 'Xenova/clip-vit-base-patch32' })).toBeNull()
  })

  it('清单没写 dtype 时用默认档位', async () => {
    stubFetch({ ...MANIFEST, dtype: undefined })
    expect((await discoverDerivedTowers())?.dtype).toBe(DEFAULT_DTYPE)
  })
})

describe('rgbaToChw', () => {
  it('单像素：三通道按 (v/255 - mean)/std 归一化', () => {
    const data = rgbaToChw(new Uint8ClampedArray([255, 128, 0, 255]), 1)
    expect(data.length).toBe(3)
    expect(data[0]).toBeCloseTo((255 / 255 - (IMAGE_MEAN[0] ?? 0)) / (IMAGE_STD[0] ?? 1), 6)
    expect(data[1]).toBeCloseTo((128 / 255 - (IMAGE_MEAN[1] ?? 0)) / (IMAGE_STD[1] ?? 1), 6)
    expect(data[2]).toBeCloseTo((0 / 255 - (IMAGE_MEAN[2] ?? 0)) / (IMAGE_STD[2] ?? 1), 6)
  })

  it('CHW 布局：通道优先、行优先', () => {
    // 2×2，四像素红值递增：R=0,1,2,3，其余通道固定
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255])
    const data = rgbaToChw(rgba, 2)
    const area = 4
    for (let index = 0; index < area; index += 1) {
      expect(data[index]).toBeCloseTo((index / 255 - (IMAGE_MEAN[0] ?? 0)) / (IMAGE_STD[0] ?? 1), 6)
    }
    // 通道 1 从 area 开始（不是交织存放）
    expect(data[area]).toBeCloseTo((0 - (IMAGE_MEAN[1] ?? 0)) / (IMAGE_STD[1] ?? 1), 6)
  })

  it('数据不足时抛错（避免读越界后静默产出错向量）', () => {
    expect(() => rgbaToChw(new Uint8ClampedArray(15), 2)).toThrow(/像素数据不足/)
  })
})
