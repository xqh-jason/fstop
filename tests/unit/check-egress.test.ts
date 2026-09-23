import { describe, expect, it } from 'vitest'
import {
  findEgressViolations,
  findExternalOrigins,
  isWhitelisted,
} from '../../scripts/check-egress.mjs'

describe('源码零外发扫描', () => {
  it('识别每一类网络构造，并给出行号', () => {
    const source = [
      `const response = await fetch('/api')`,
      `const socket = new WebSocket(url)`,
      `const stream = new EventSource(url)`,
      `const request = new XMLHttpRequest()`,
      `navigator.sendBeacon(url, body)`,
      `import ort from 'https://cdn.example.com/ort.js'`,
    ].join('\n')

    expect(
      findEgressViolations(source, 'src/app/main.ts').map((v) => `${v.line}:${v.rule}`),
    ).toEqual([
      '1:fetch',
      '2:WebSocket',
      '3:EventSource',
      '4:XMLHttpRequest',
      '5:sendBeacon',
      '6:remote-import',
    ])
  })

  it('不误报名字里含 fetch 的本地函数', () => {
    const source = [
      `prefetch('/a')`,
      `const refetched = true`,
      `import { helper } from './local'`,
    ].join('\n')
    expect(findEgressViolations(source, 'src/shared/env.ts')).toEqual([])
  })

  it('对象上的 fetch 仍然算，不会被词边界漏掉', () => {
    expect(
      findEgressViolations(`client.fetch('/x')`, 'src/ui/CapabilityPanel.vue').map((v) => v.rule),
    ).toEqual(['fetch'])
  })

  it('白名单文件里的模型下载是已声明的，不报', () => {
    expect(isWhitelisted('src/storage/models.ts')).toBe(true)
    expect(findEgressViolations(`await fetch(weightsUrl)`, 'src/storage/models.ts')).toEqual([])
  })

  it('HTML 指向外部 origin 会被拦下，相对路径不会', () => {
    expect(
      findExternalOrigins(`<script src="https://cdn.example.com/x.js"></script>`, 'index.html'),
    ).toHaveLength(1)
    expect(
      findExternalOrigins(`<script type="module" src="/src/app/main.ts"></script>`, 'index.html'),
    ).toEqual([])
  })
})
