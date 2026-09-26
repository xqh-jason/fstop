import { describe, expect, it } from 'vitest'
import {
  anchorCenters,
  area,
  clampToImage,
  decodeDetections,
  iou,
  letterbox,
  nms,
  toOriginal,
  type FaceDetection,
} from '../../src/core/face-detect'

const box = (x1: number, y1: number, x2: number, y2: number): FaceDetection['box'] => ({
  x1,
  y1,
  x2,
  y2,
})

describe('letterbox', () => {
  it('长边缩到 inputSize，横图按宽定比例', () => {
    const result = letterbox(1280, 960, 640)
    expect(result.scale).toBeCloseTo(0.5, 6)
    expect(result.contentWidth).toBe(640)
    expect(result.contentHeight).toBe(480)
  })

  it('竖图按高定比例', () => {
    const result = letterbox(960, 1280, 640)
    expect(result.scale).toBeCloseTo(0.5, 6)
    expect(result.contentHeight).toBe(640)
    expect(result.contentWidth).toBe(480)
  })

  it('尺寸非法直接报错（不静默给出 0 比例去算出无穷坐标）', () => {
    expect(() => letterbox(0, 100, 640)).toThrow()
    expect(() => letterbox(100, -1, 640)).toThrow()
  })

  it('坐标换算与缩放互逆', () => {
    const { scale } = letterbox(1280, 960, 640)
    expect(toOriginal(320, scale, 0)).toBeCloseTo(640, 6)
  })
})

describe('anchorCenters', () => {
  it('数量 = 格点 × 每格 anchor', () => {
    expect(anchorCenters(8, 640, 2)).toHaveLength(80 * 80 * 2)
    expect(anchorCenters(16, 640, 2)).toHaveLength(40 * 40 * 2)
    expect(anchorCenters(32, 640, 2)).toHaveLength(20 * 20 * 2)
  })

  it('行优先、同格 anchor 相邻且坐标相同', () => {
    const centers = anchorCenters(32, 640, 2)
    expect(centers[0]).toEqual({ x: 0, y: 0 })
    expect(centers[1]).toEqual({ x: 0, y: 0 })
    expect(centers[2]).toEqual({ x: 32, y: 0 })
  })

  it('与 SCRFD-34g 的真实输出长度一致（12800/3200/800）', () => {
    expect(anchorCenters(8, 640, 2)).toHaveLength(12800)
    expect(anchorCenters(16, 640, 2)).toHaveLength(3200)
    expect(anchorCenters(32, 640, 2)).toHaveLength(800)
  })
})

describe('decodeDetections', () => {
  /**
   * 造一档 stride 输出：第 index 个 anchor 命中，中心偏移与宽高都以**输入像素**给出，
   * 写进张量前除以 stride（模型的 bbox/kps 输出是 stride 相对值，这一步换算错了就会
   * 得到「挤在左上角的小框」——所以测试里显式做，并把两种口径分开）。
   */
  function level(
    stride: number,
    side: number,
    hit: { index: number; dx: number; dy: number; w: number; h: number; score: number },
  ): { scores: Float32Array; boxes: Float32Array; keypoints: Float32Array } {
    const count = side * side * 2
    const scores = new Float32Array(count)
    const boxes = new Float32Array(count * 4)
    const keypoints = new Float32Array(count * 10)
    const toStride = (value: number): number => value / stride
    scores[hit.index] = hit.score
    const base = hit.index * 4
    // 模型输出的是「anchor 中心 → 框边的距离」（左/上/右/下），不是边缘坐标偏移。
    // 框中心在 anchor 右侧 dx 时：l = w/2 - dx、r = w/2 + dx（l + r = w、r - l = 2dx）。
    boxes[base] = toStride(hit.w / 2 - hit.dx)
    boxes[base + 1] = toStride(hit.h / 2 - hit.dy)
    boxes[base + 2] = toStride(hit.w / 2 + hit.dx)
    boxes[base + 3] = toStride(hit.h / 2 + hit.dy)
    // 关键点输出是「相对 anchor 中心的偏移」（加号方向），与 bbox 的距离口径不同
    for (let point = 0; point < 5; point += 1) {
      keypoints[hit.index * 10 + point * 2] = toStride(hit.dx)
      keypoints[hit.index * 10 + point * 2 + 1] = toStride(hit.dy)
    }
    return { scores, boxes, keypoints }
  }

  it('距离乘 stride 后还原到原图坐标（漏乘会得到挤在左上角的小框）', () => {
    // stride 32 的第 0 个 anchor 中心 = (0,0)；给一个 64×64 的框：距离 = 32（像素）/32 = 1
    const data = level(32, 20, { index: 0, dx: 0, dy: 0, w: 32, h: 32, score: 0.9 })
    const detections = decodeDetections(
      {
        imageWidth: 640,
        imageHeight: 640,
        strides: [32],
        scores: [data.scores],
        boxes: [data.boxes],
        keypoints: [data.keypoints],
      },
      letterbox(640, 640, 640),
      { scoreThreshold: 0.5, iouThreshold: 0.4 },
    )
    expect(detections).toHaveLength(1)
    expect(detections[0]?.box).toEqual({ x1: -16, y1: -16, x2: 16, y2: 16 })
    expect(detections[0]?.score).toBeCloseTo(0.9, 6)
  })

  it('低于阈值的候选被丢掉', () => {
    const data = level(32, 20, { index: 0, dx: 0, dy: 0, w: 32, h: 32, score: 0.3 })
    const detections = decodeDetections(
      {
        imageWidth: 640,
        imageHeight: 640,
        strides: [32],
        scores: [data.scores],
        boxes: [data.boxes],
        keypoints: [data.keypoints],
      },
      letterbox(640, 640, 640),
      { scoreThreshold: 0.5, iouThreshold: 0.4 },
    )
    expect(detections).toHaveLength(0)
  })

  it('缩放回原图：640 输入命中 (320,320) 在 1280×960 原图上应是 (640,640)', () => {
    // anchor 网格 stride 8，索引 index 对应 row/col；取 row=40,col=40 → 中心 (320,320)
    const stride = 8
    const index = (40 * 80 + 40) * 2
    const data = level(stride, 80, { index, dx: 0, dy: 0, w: 40, h: 40, score: 0.8 })
    const detections = decodeDetections(
      {
        imageWidth: 1280,
        imageHeight: 960,
        strides: [stride],
        scores: [data.scores],
        boxes: [data.boxes],
        keypoints: [data.keypoints],
      },
      letterbox(1280, 960, 640),
      { scoreThreshold: 0.5, iouThreshold: 0.4 },
    )
    expect(detections).toHaveLength(1)
    const detection = detections[0]
    expect(detection?.box.x1).toBeCloseTo(600, 4)
    expect(detection?.box.y1).toBeCloseTo(600, 4)
    expect(detection?.box.x2).toBeCloseTo(680, 4)
    expect(detection?.box.y2).toBeCloseTo(680, 4)
    expect(detection?.landmarks).toHaveLength(5)
    expect(detection?.landmarks[0]?.x).toBeCloseTo(640, 4)
  })

  it('三档 stride 同时命中时按分数保留、重叠的抑制掉', () => {
    // 同一张脸在 stride 8 与 stride 32 上都被激活：两档的框都落在输入像素 (270,270)-(370,370)
    const high = level(8, 80, {
      index: (40 * 80 + 40) * 2,
      dx: 0,
      dy: 0,
      w: 100,
      h: 100,
      score: 0.9,
    })
    const low = level(32, 20, {
      index: (10 * 20 + 10) * 2,
      dx: 0,
      dy: 0,
      w: 100,
      h: 100,
      score: 0.6,
    })
    const detections = decodeDetections(
      {
        imageWidth: 640,
        imageHeight: 640,
        strides: [8, 32],
        scores: [high.scores, low.scores],
        boxes: [high.boxes, low.boxes],
        keypoints: [high.keypoints, low.keypoints],
      },
      letterbox(640, 640, 640),
      { scoreThreshold: 0.5, iouThreshold: 0.4 },
    )
    expect(detections).toHaveLength(1)
    expect(detections[0]?.score).toBeCloseTo(0.9, 6)
  })

  it('缺关键点输出时只少关键点，不报错（换检测模型时的兼容）', () => {
    const data = level(32, 20, { index: 0, dx: 0, dy: 0, w: 32, h: 32, score: 0.9 })
    const detections = decodeDetections(
      {
        imageWidth: 640,
        imageHeight: 640,
        strides: [32],
        scores: [data.scores],
        boxes: [data.boxes],
        keypoints: [],
      },
      letterbox(640, 640, 640),
      { scoreThreshold: 0.5, iouThreshold: 0.4 },
    )
    expect(detections[0]?.landmarks).toEqual([])
  })
})

describe('iou / area / nms', () => {
  it('面积对负宽高按 0 处理', () => {
    expect(area(box(10, 10, 5, 5))).toBe(0)
    expect(area(box(0, 0, 10, 20))).toBe(200)
  })

  it('IoU：相同框 = 1、不相交 = 0、半重叠有解', () => {
    expect(iou(box(0, 0, 10, 10), box(0, 0, 10, 10))).toBeCloseTo(1, 6)
    expect(iou(box(0, 0, 10, 10), box(20, 20, 30, 30))).toBe(0)
    // 交集 50，并集 150
    expect(iou(box(0, 0, 10, 10), box(5, 0, 15, 10))).toBeCloseTo(50 / 150, 6)
  })

  it('NMS 保高分、抑制重叠', () => {
    const kept = nms(
      [
        { box: box(0, 0, 10, 10), score: 0.7, landmarks: [] },
        { box: box(1, 1, 11, 11), score: 0.9, landmarks: [] },
        { box: box(100, 100, 110, 110), score: 0.5, landmarks: [] },
      ],
      0.4,
    )
    expect(kept.map((item) => item.score)).toEqual([0.9, 0.5])
  })
})

describe('clampToImage', () => {
  it('裁到画面内并取整', () => {
    expect(clampToImage(box(-5.6, 3.2, 20.4, 30.9), 100, 100)).toEqual({
      x: 0,
      y: 3,
      width: 21,
      height: 28,
    })
  })

  it('完全在画面外返回 null', () => {
    expect(clampToImage(box(-50, -50, -10, -10), 100, 100)).toBeNull()
    expect(clampToImage(box(200, 10, 260, 60), 100, 100)).toBeNull()
    expect(clampToImage(box(10, 300, 60, 400), 100, 100)).toBeNull()
  })

  it('亚像素框裁到 1×1 而不是 null（检测框可能很小，丢掉会让人「莫名少一张脸」）', () => {
    expect(clampToImage(box(0.1, 0.1, 0.6, 0.6), 100, 100)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })
  })
})
