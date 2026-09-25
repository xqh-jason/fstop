/**
 * 照片墙的窗口计算 —— `src/core/` 手写区，纯函数，**不碰 DOM**。
 *
 * 为什么单独抽出来：万张级列表的正确性（行边界、列数变化、滚动到底）全在这个函数里，
 * 抽出来才能在 node 单测里覆盖；组件只负责把结果映射成 DOM。
 *
 * 用固定行高（缩略图按固定尺寸渲染）而不是测量真实高度：测量需要读布局，
 * 在虚拟滚动里会引起「滚动 → 测量 → 重排 → 滚动」的回流，且万张级别时每行都要测一遍。
 * 固定行高的代价是图片必须**严格按格子尺寸渲染**（`object-fit: cover`），这一点由 CSS 保证。
 */

export interface WallLayout {
  /** 条目总数（窗口计算的夹紧边界） */
  readonly total: number
  /** 每行几列（由容器宽度与格子尺寸算出，最小 1） */
  readonly columns: number
  /** 行高 = 格子高 + 行间距（px） */
  readonly rowHeight: number
  /** 总行数 */
  readonly rows: number
  /** 滚动内容的撑高（px） */
  readonly spacerHeight: number
}

export interface VisibleRange {
  /** 起始行（含） */
  readonly startRow: number
  /** 结束行（不含） */
  readonly endRow: number
  /** 起始条目下标（含） */
  readonly startIndex: number
  /** 结束条目下标（不含） */
  readonly endIndex: number
}

export function layoutWall(options: {
  readonly total: number
  readonly containerWidth: number
  readonly columnWidth: number
  readonly rowHeight: number
  readonly gap: number
}): WallLayout {
  const total = Math.max(0, Math.floor(options.total))
  const stride = options.columnWidth + options.gap
  const columns = Math.max(1, Math.floor((options.containerWidth + options.gap) / stride))
  const rows = Math.ceil(total / columns)
  return {
    total,
    columns,
    rowHeight: options.rowHeight + options.gap,
    rows,
    spacerHeight: rows * (options.rowHeight + options.gap),
  }
}

/**
 * 可视窗口：只渲染 `[startRow, endRow)` 的行，外加 `overscan` 行缓冲。
 *
 * 缓冲的意义是让滚动时不出现空白（图片解码需要时间）；缓冲太大就退化成整表渲染，
 * 所以默认 2 行。
 */
export function visibleRange(options: {
  readonly scrollTop: number
  readonly viewportHeight: number
  readonly layout: WallLayout
  readonly overscan?: number
}): VisibleRange {
  const overscan = Math.max(0, Math.floor(options.overscan ?? 2))
  const rowHeight = options.layout.rowHeight
  if (rowHeight <= 0 || options.layout.rows === 0) {
    return { startRow: 0, endRow: 0, startIndex: 0, endIndex: 0 }
  }
  const firstVisible = Math.floor(Math.max(0, options.scrollTop) / rowHeight)
  const visibleCount = Math.ceil(Math.max(0, options.viewportHeight) / rowHeight)
  // startRow 也要夹在 [0, rows] 内：滚动位置超过内容高度时（容器比内容矮的瞬间、
  // 或程序化 scrollTop 越界）不能算出 startRow > endRow 的负窗口
  const startRow = Math.min(options.layout.rows, Math.max(0, firstVisible - overscan))
  const endRow = Math.max(
    startRow,
    Math.min(options.layout.rows, firstVisible + visibleCount + overscan + 1),
  )
  const rawStartIndex = startRow * options.layout.columns
  const rawEndIndex = endRow * options.layout.columns
  return {
    startRow,
    endRow,
    startIndex: Math.min(rawStartIndex, options.layout.total),
    endIndex: Math.min(rawEndIndex, options.layout.total),
  }
}
