/**
 * 人脸 Worker —— 检测（SCRFD-34g）+ 对齐（ArcFace 5 点）+ 识别（antelopev2/r100）。
 *
 * 一条链在 Worker 里走完（不是「检测一个 Worker、识别另一个」）：中间产物是**位图与框**，
 * 跨线程传一次就是一次拷贝，而一张 4000×3000 的原图拷贝起来比算它贵。
 *
 * 后处理数学全在 `src/core/face-detect.ts` / `face-align.ts`（有单测），这里只做
 * 「张量 ↔ 画布」的搬运，所以这一层薄、也只有这一层必须真浏览器才能验证。
 *
 * 预处理（letterbox 与 5 点对齐）在 `./face-preprocess.ts` 里，探针页 import 同一份 ——
 * 「探针里 0 张脸」与「产品里 0 张脸」必须是同一个原因，否则基准页的数字描述的不是产品路径。
 */

import * as Comlink from 'comlink'
import { landmarksUsable } from '../core/face-align'
import { normalizeVector } from '../core/face-cluster'
import { decodeDetections, type FaceDetection } from '../core/face-detect'
import {
  FACE_DETECTOR,
  FACE_RECOGNIZER,
  type FaceDetectorSpec,
  type FaceRecognizerSpec,
} from '../storage/models'
import { alignedInput, detectorInput } from './face-preprocess'
import { loadOrt, type OrtSession } from './ort-runtime'

export interface FaceWorkerFace {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly score: number
  readonly embedding: Float32Array
}

export interface FaceWorkerResult {
  readonly width: number
  readonly height: number
  readonly faces: readonly FaceWorkerFace[]
  readonly detectMs: number
  readonly embedMs: number
  /** 检出但**对齐失败**而丢掉的脸（关键点退化），如实上报而不是静默少一张 */
  readonly dropped: number
}

export interface FaceWorkerInit {
  readonly detectorLoadMs: number
  readonly recognizerLoadMs: number
  readonly providers: readonly string[]
}

export interface FaceService {
  init(options?: { executionProviders?: readonly string[] }): Promise<FaceWorkerInit>
  analyze(bitmap: ImageBitmap): Promise<FaceWorkerResult>
}

interface LoadedFaceModels {
  readonly ort: Awaited<ReturnType<typeof loadOrt>>
  readonly detector: OrtSession
  readonly recognizer: OrtSession
  readonly detectorLoadMs: number
  readonly recognizerLoadMs: number
  readonly providers: readonly string[]
}

async function load(options: {
  executionProviders?: readonly string[]
}): Promise<LoadedFaceModels> {
  const ort = await loadOrt()
  const providers = options.executionProviders ?? ['webgpu']
  const detectorSpec: FaceDetectorSpec = FACE_DETECTOR
  const recognizerSpec: FaceRecognizerSpec = FACE_RECOGNIZER

  const detectorStart = performance.now()
  const detector = await ort.InferenceSession.create(detectorSpec.url, {
    executionProviders: providers,
  })
  const detectorLoadMs = Math.round(performance.now() - detectorStart)

  const recognizerStart = performance.now()
  const recognizer = await ort.InferenceSession.create(recognizerSpec.url, {
    executionProviders: providers,
  })
  const recognizerLoadMs = Math.round(performance.now() - recognizerStart)

  return { ort, detector, recognizer, detectorLoadMs, recognizerLoadMs, providers }
}

/** 人脸框的外扩（喂给识别前留一点边距；ArcFace 模板本身已含标准边距，这里只补 0.1） */
function expand(box: FaceDetection['box']): FaceDetection['box'] {
  const width = (box.x2 - box.x1) * 0.1
  const height = (box.y2 - box.y1) * 0.1
  return { x1: box.x1 - width, y1: box.y1 - height, x2: box.x2 + width, y2: box.y2 + height }
}

let service: Promise<LoadedFaceModels> | null = null

async function analyze(models: LoadedFaceModels, bitmap: ImageBitmap): Promise<FaceWorkerResult> {
  const spec = FACE_DETECTOR
  const { tensor, box } = detectorInput(bitmap, spec.inputSize)

  const detectStart = performance.now()
  const outputs = await models.detector.run({
    'input.1': new models.ort.Tensor('float32', tensor, [1, 3, spec.inputSize, spec.inputSize]),
  })
  const detectMs = Math.round(performance.now() - detectStart)

  const detections = decodeDetections(
    {
      imageWidth: bitmap.width,
      imageHeight: bitmap.height,
      strides: spec.strides,
      scores: spec.strides.map(
        (stride) => outputs[`score_${String(stride)}`]?.data ?? new Float32Array(0),
      ),
      boxes: spec.strides.map(
        (stride) => outputs[`bbox_${String(stride)}`]?.data ?? new Float32Array(0),
      ),
      keypoints: spec.strides.map(
        (stride) => outputs[`kps_${String(stride)}`]?.data ?? new Float32Array(0),
      ),
    },
    box,
    { scoreThreshold: spec.scoreThreshold, iouThreshold: spec.iouThreshold },
  )

  const embedStart = performance.now()
  const faces: FaceWorkerFace[] = []
  let dropped = 0
  for (const detection of detections) {
    // 对齐要求 5 个可信关键点；退化的（点挤在一起/共线）如实计入 dropped
    if (!landmarksUsable(detection.landmarks)) {
      dropped += 1
      continue
    }
    const input = alignedInput(bitmap, detection.landmarks, FACE_RECOGNIZER.inputSize)
    const result = await models.recognizer.run({
      'input.1': new models.ort.Tensor('float32', input, [
        1,
        3,
        FACE_RECOGNIZER.inputSize,
        FACE_RECOGNIZER.inputSize,
      ]),
    })
    const output = Object.values(result)[0]
    if (output === undefined) throw new Error('人脸识别模型没有输出')
    const raw = output.data
    if (raw.length !== FACE_RECOGNIZER.dim) {
      throw new Error(
        `人脸向量维度异常：期望 ${String(FACE_RECOGNIZER.dim)}，实际 ${String(raw.length)}`,
      )
    }
    const expanded = expand(detection.box)
    faces.push({
      x1: expanded.x1,
      y1: expanded.y1,
      x2: expanded.x2,
      y2: expanded.y2,
      score: detection.score,
      embedding: normalizeVector(raw.slice()),
    })
  }
  const embedMs = Math.round(performance.now() - embedStart)

  return { width: bitmap.width, height: bitmap.height, faces, detectMs, embedMs, dropped }
}

Comlink.expose({
  async init(options?: { executionProviders?: readonly string[] }): Promise<FaceWorkerInit> {
    const models = await (service ??= load(options ?? {}))
    return {
      detectorLoadMs: models.detectorLoadMs,
      recognizerLoadMs: models.recognizerLoadMs,
      providers: models.providers,
    }
  },
  async analyze(bitmap: ImageBitmap): Promise<FaceWorkerResult> {
    return analyze(await (service ??= load({})), bitmap)
  },
} satisfies FaceService)
