/**
 * 外发账本（M2）—— 把「运行时不外发」从一句口号变成用户能亲眼核对的一屏。
 *
 * 口径（计划 §11.4）：**除模型 origin 外零请求**。这里把页面实际发过的请求按 host 分成三类：
 * - `local`：**页面自己的 origin**（部署后可能是 `https://user.github.io`，不只是 localhost）、
 *   `localhost` / `127.0.0.1` / 内网地址（自己的静态资源）
 * - `model`：模型权重 origin（白名单，冷缓存时下载权重）
 * - `external`：其余一律算**违规**——界面必须红着显示，而不是藏起来
 *
 * ⚠ **必须把页面自己的 origin 当成「本机」**（M3 部署时才暴露的坑）：只看 host 白名单的话，
 * 部署到静态站点后 app 加载自己的 JS/样例照片会被判成 `external`，离线面板对着自己报警 ——
 * 一个会误报的面板等于没有面板。所以分类函数收 `ownOrigin`，页面传 `location.origin`。
 *
 * 为什么在应用内做这件事（而不是只靠测试脚本的 request hook）：
 * 「零外发」是给用户看的承诺，用户手里没有 Playwright。应用自己记账、自己显示，
 * 才是可核对的；同时它和 CI 的静态断言、端到端的运行时断言构成三层互证。
 */

/** 允许出网的模型 origin（与 `bench/e2e-faces.mjs` 的白名单同一份语义） */
export const MODEL_HOSTS: readonly string[] = [
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'hf-mirror.com',
  // HF 的短域与其 CDN：权重文件的 302 会落到 `us.aws.cdn.hf.co` 这类主机上（端到端实测抓到过）。
  // 它仍然是**模型 origin**，不是外部站点，所以白名单收在这里，而不是在断言里放宽。
  'hf.co',
]

export type EgressKind = 'local' | 'model' | 'external'

export interface EgressEntry {
  readonly host: string
  readonly kind: EgressKind
  readonly count: number
  /** 该类里最后一条请求的路径（便于用户核对到底是哪个文件） */
  readonly sample: string
}

export interface EgressSummary {
  readonly entries: readonly EgressEntry[]
  /** 违规 host（`external`），空数组 = 承诺成立 */
  readonly violations: readonly string[]
  readonly total: number
}

/** 判断一个 URL 属于哪一类；非 http(s)（blob:/data:）返回 null，不计数 */
export function classifyUrl(
  rawUrl: string,
  ownOrigin?: string,
): { host: string; kind: EgressKind } | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  // blob:/data: 不产生网络请求（照片墙与结果网格都用 blob: 显示缩略图），
  // 它们的 host 是空串，混进来会被误判成「外部 origin」（实测踩过假红）
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.host
  // 页面自己的 origin 一定是本机：部署后它可能是任意域名（github.io / 自建域名），
  // 白名单式判断在这时会把 app 自己的静态资源算成违规（M3 部署时才暴露）
  if (ownOrigin !== undefined && ownOrigin !== '' && url.origin === ownOrigin) {
    return { host, kind: 'local' }
  }
  return { host, kind: classifyHost(host) }
}

export function classifyHost(host: string): EgressKind {
  // host 可能带端口（`127.0.0.1:5198`），比较用 hostname 部分
  const hostname = host.split(':')[0] ?? host
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return 'local'
  if (isPrivateAddress(hostname)) return 'local'
  if (MODEL_HOSTS.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`))) {
    return 'model'
  }
  return 'external'
}

/** 内网地址也算本机（局域网里的 dev server 不该被报成违规） */
function isPrivateAddress(hostname: string): boolean {
  if (/^10\./.test(hostname) || /^192\.168\./.test(hostname)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true
  if (/^169\.254\./.test(hostname)) return true
  return false
}

/**
 * 把性能时间线里的资源条目聚合成账本。
 *
 * 输入刻意用「只需要 url 字段」的形状：浏览器给的是 `PerformanceResourceTiming`，
 * 测试里给字符串数组，两边都能喂同一个实现（不写第二份分类逻辑）。
 */
export function summarizeEgress(
  resources: readonly { name: string }[],
  ownOrigin?: string,
): EgressSummary {
  const byHost = new Map<string, EgressEntry>()
  for (const resource of resources) {
    const classified = classifyUrl(resource.name, ownOrigin)
    if (classified === null) continue
    const existing = byHost.get(classified.host)
    if (existing === undefined) {
      byHost.set(classified.host, {
        host: classified.host,
        kind: classified.kind,
        count: 1,
        sample: pathOf(resource.name),
      })
    } else {
      byHost.set(classified.host, { ...existing, count: existing.count + 1 })
    }
  }
  const entries = [...byHost.values()].sort((a, b) => b.count - a.count)
  return {
    entries,
    violations: entries.filter((entry) => entry.kind === 'external').map((entry) => entry.host),
    total: entries.reduce((sum, entry) => sum + entry.count, 0),
  }
}

function pathOf(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    return `${url.pathname}${url.search === '' ? '' : '?…'}`
  } catch {
    return rawUrl
  }
}
