import { describe, expect, it } from 'vitest'
import { classifyHost, classifyUrl, summarizeEgress } from '../../src/core/egress-ledger'

describe('classifyHost', () => {
  it('本机地址算 local（含端口与 ::1）', () => {
    expect(classifyHost('127.0.0.1:5198')).toBe('local')
    expect(classifyHost('localhost')).toBe('local')
    expect(classifyHost('[::1]:5198')).toBe('external') // 带方括号的形态不属于本机口径
    expect(classifyHost('192.168.1.7:8000')).toBe('local')
    expect(classifyHost('10.0.0.5')).toBe('local')
    expect(classifyHost('172.16.3.9')).toBe('local')
  })

  it('模型 origin 及其子域算 model', () => {
    expect(classifyHost('huggingface.co')).toBe('model')
    expect(classifyHost('cdn-lfs.huggingface.co')).toBe('model')
    expect(classifyHost('hf-mirror.com')).toBe('model')
  })

  it('其它一律 external（含形近域名，不做后缀包含的宽松匹配）', () => {
    expect(classifyHost('evil-huggingface.co')).toBe('external')
    expect(classifyHost('huggingface.co.evil.com')).toBe('external')
    expect(classifyHost('example.com')).toBe('external')
  })
})

describe('classifyUrl', () => {
  it('blob:/data: 不计入（否则空 host 会被当成外部 origin）', () => {
    expect(classifyUrl('blob:http://127.0.0.1:5198/abc-123')).toBeNull()
    expect(classifyUrl('data:image/jpeg;base64,AAAA')).toBeNull()
  })

  it('非法 URL 返回 null 而不是抛错', () => {
    expect(classifyUrl('not a url')).toBeNull()
    expect(classifyUrl('')).toBeNull()
  })

  it('正常 URL 返回 host 与分类', () => {
    expect(classifyUrl('http://127.0.0.1:5198/?root=opfs')).toEqual({
      host: '127.0.0.1:5198',
      kind: 'local',
    })
    expect(classifyUrl('https://huggingface.co/immich-app/x/resolve/main/model.onnx')).toEqual({
      host: 'huggingface.co',
      kind: 'model',
    })
  })
})

describe('summarizeEgress', () => {
  const resources = [
    { name: 'http://127.0.0.1:5198/' },
    { name: 'http://127.0.0.1:5198/src/app/main.ts' },
    { name: 'http://127.0.0.1:5198/src/app/App.vue' },
    { name: 'blob:http://127.0.0.1:5198/x' },
    { name: 'https://huggingface.co/models/derived/vision192_q4f16.onnx' },
    { name: 'https://cdn-lfs.huggingface.co/repo/file' },
  ]

  it('按 host 聚合、计数降序', () => {
    const summary = summarizeEgress(resources)
    expect(summary.entries.map((entry) => entry.host)).toEqual([
      '127.0.0.1:5198',
      'huggingface.co',
      'cdn-lfs.huggingface.co',
    ])
    expect(summary.entries[0]?.count).toBe(3)
    expect(summary.total).toBe(5) // blob: 不计
  })

  it('没有违规 host 时 violations 为空（承诺成立）', () => {
    expect(summarizeEgress(resources).violations).toEqual([])
  })

  it('出现外部 host 时点名（界面要红着显示，不是藏起来）', () => {
    const summary = summarizeEgress([
      ...resources,
      { name: 'https://telemetry.example.com/beacon' },
    ])
    expect(summary.violations).toEqual(['telemetry.example.com'])
  })

  it('同类 host 只留一条，带最后一条路径作为样例', () => {
    const summary = summarizeEgress([
      { name: 'https://huggingface.co/a/b.onnx' },
      { name: 'https://huggingface.co/c/d.onnx' },
    ])
    expect(summary.entries).toHaveLength(1)
    expect(summary.entries[0]?.sample).toBe('/a/b.onnx')
  })

  it('空输入安全', () => {
    expect(summarizeEgress([])).toEqual({ entries: [], violations: [], total: 0 })
  })
})
