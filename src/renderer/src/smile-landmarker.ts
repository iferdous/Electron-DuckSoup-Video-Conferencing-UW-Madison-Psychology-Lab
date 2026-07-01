import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import type { SmileFrame } from './smile-onset'

const localAssetUrl = (path: string): string => new URL(path.replace(/^\/+/, ''), window.location.href).toString()

let faceLandmarkerPromise: Promise<FaceLandmarker> | null = null

export const getSmileFaceLandmarker = (): Promise<FaceLandmarker> => {
  faceLandmarkerPromise ??= FilesetResolver.forVisionTasks(localAssetUrl('mediapipe/wasm/')).then(
    (wasmFileset) =>
      FaceLandmarker.createFromOptions(wasmFileset, {
        baseOptions: {
          modelAssetPath: localAssetUrl('mediapipe/models/face_landmarker.task'),
          delegate: 'CPU'
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.6,
        minFacePresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false
      })
  )
  return faceLandmarkerPromise
}

const categoryScore = (
  categories: Array<{ categoryName?: string; displayName?: string; score?: number }>,
  name: string
): number => categories.find((category) => category.categoryName === name || category.displayName === name)?.score ?? 0

export const sampleSmileFrame = (
  landmarker: FaceLandmarker,
  video: HTMLVideoElement,
  timestampMs: number
): SmileFrame => {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0 || video.videoHeight <= 0) {
    return {
      timestampMs,
      facePresent: false,
      mouthSmileLeft: 0,
      mouthSmileRight: 0,
      jawOpen: 0,
      faceInBounds: false
    }
  }

  const result = landmarker.detectForVideo(video, timestampMs)
  const landmarks = result.faceLandmarks[0]
  const categories = result.faceBlendshapes[0]?.categories ?? []
  if (!landmarks || landmarks.length === 0 || categories.length === 0) {
    return {
      timestampMs,
      facePresent: false,
      mouthSmileLeft: 0,
      mouthSmileRight: 0,
      jawOpen: 0,
      faceInBounds: false
    }
  }

  let minX = 1
  let minY = 1
  let maxX = 0
  let maxY = 0
  for (const point of landmarks) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  const faceWidth = maxX - minX
  const faceHeight = maxY - minY
  const faceInBounds =
    minX >= -0.03 &&
    minY >= -0.03 &&
    maxX <= 1.03 &&
    maxY <= 1.03 &&
    faceWidth >= 0.15 &&
    faceHeight >= 0.2

  return {
    timestampMs,
    facePresent: true,
    mouthSmileLeft: categoryScore(categories, 'mouthSmileLeft'),
    mouthSmileRight: categoryScore(categories, 'mouthSmileRight'),
    jawOpen: categoryScore(categories, 'jawOpen'),
    faceInBounds
  }
}
