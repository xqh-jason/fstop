/**
 * query → 目标照片的匹配规则。
 *
 * 两种 ground truth 格式并存，**语义必须一致**，所以放在一处：
 * - 老格式（`quality-queries.json`）：`match` 是**文件名前缀**（不含扩展名），
 *   匹配 `file.startsWith(match + '-')`——样例文件是 `主题-序号-...jpg`，一个主题命中多张。
 * - 新格式（`corpus-queries.json`）：`match` 是**完整文件名（含扩展名）**，按精确匹配；
 *   也允许数组（一条 query 对应多张近重复照片）。
 *
 * 判据是「模式串是否带图片扩展名」，不是「调用方来自哪个文件」——
 * 之前 quality 页自己写了一份只做前缀匹配的版本，遇到新格式直接「没有命中任何照片」，
 * 而 exported 页那份是对的。两份实现就是这类 bug 的温床。
 */

const IMAGE_EXTENSION = /\.(jpe?g|png|webp|tiff?|heic|heif)$/i

export interface QueryLike {
  readonly id: string
  readonly match: string | readonly string[]
}

/** 把 `match` 统一成模式数组 */
export function matchesOf(match: string | readonly string[]): readonly string[] {
  return typeof match === 'string' ? [match] : match
}

/** 单个模式是否命中某个文件 */
export function patternHits(pattern: string, file: string): boolean {
  return IMAGE_EXTENSION.test(pattern) ? file === pattern : file.startsWith(`${pattern}-`)
}

/**
 * 每条 query 的目标文件列表。**命中为空即抛错**：ground truth 配置错了要立刻失败，
 * 而不是静默地把它当成「检索失败」——那会把配置错误伪装成质量下降。
 */
export function targetsOf(
  queries: readonly QueryLike[],
  files: readonly string[],
): readonly (readonly string[])[] {
  return queries.map((query) => {
    const patterns = matchesOf(query.match)
    const targets = files.filter((file) => patterns.some((pattern) => patternHits(pattern, file)))
    if (targets.length === 0) {
      throw new Error(`query ${query.id} 的 match 没有命中任何照片：${patterns.join(' / ')}`)
    }
    return targets
  })
}
