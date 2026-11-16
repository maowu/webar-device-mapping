const CAPTURE_SIZE = 32
const FEATURE_MAX_EDGE = 360
const VECTOR_SIZE = CAPTURE_SIZE * CAPTURE_SIZE

const getCameraCanvas = () => {
  const candidates = [
    document.querySelector('canvas.a-canvas'),
    document.querySelector('canvas'),
  ]

  return candidates.find((canvas) => canvas && canvas.width > 0 && canvas.height > 0)
}

const makeEven = (value) => {
  const rounded = Math.round(value)
  return rounded % 2 === 0 ? rounded : rounded - 1
}

export const getFeatureCaptureSize = () => {
  const source = getCameraCanvas()
  const srcW = source?.width || 0
  const srcH = source?.height || 0

  if (!srcW || !srcH) {
    return {width: 320, height: 240}
  }

  if (srcW >= srcH) {
    return {
      width: FEATURE_MAX_EDGE,
      height: makeEven(FEATURE_MAX_EDGE * srcH / srcW),
    }
  }

  return {
    width: makeEven(FEATURE_MAX_EDGE * srcW / srcH),
    height: FEATURE_MAX_EDGE,
  }
}

const normalize = (vector) => {
  const mean = vector.reduce((sum, value) => sum + value, 0) / vector.length
  const centered = vector.map((value) => value - mean)
  const magnitude = Math.sqrt(centered.reduce((sum, value) => sum + value * value, 0)) || 1

  return centered.map((value) => value / magnitude)
}

const GUIDE_IMAGE_MAX_EDGE = 320

// Higher-res snapshot (vs. the 32x32 embedding thumbnail) used as a visual
// alignment guide — shown as a ghost overlay so a Peer can match their camera
// framing to the Master's keyframe, à la 8th Wall / Niantic "spot" alignment.
export const captureGuideImage = () => {
  const source = getCameraCanvas()
  if (!source) return null

  const srcW = source.width || 0
  const srcH = source.height || 0
  if (!srcW || !srcH) return null

  const scale = GUIDE_IMAGE_MAX_EDGE / Math.max(srcW, srcH)
  const width = makeEven(srcW * scale)
  const height = makeEven(srcH * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d').drawImage(source, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', 0.6)
}

export const captureFrameDescriptor = () => {
  const source = getCameraCanvas()

  if (!source) {
    throw new Error('Camera canvas is not ready')
  }

  const canvas = document.createElement('canvas')
  canvas.width = CAPTURE_SIZE
  canvas.height = CAPTURE_SIZE

  const context = canvas.getContext('2d', {willReadFrequently: true})
  context.drawImage(source, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE)

  const pixels = context.getImageData(0, 0, CAPTURE_SIZE, CAPTURE_SIZE).data
  const luminance = new Array(VECTOR_SIZE)

  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 1) {
    luminance[j] = (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) / 255
  }

  return {
    embedding: normalize(luminance),
    image: canvas.toDataURL('image/jpeg', 0.72),
  }
}

export const captureFeatureImageData = () => {
  const source = getCameraCanvas()

  if (!source) {
    throw new Error('Camera canvas is not ready')
  }

  const {width, height} = getFeatureCaptureSize()
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d', {willReadFrequently: true})
  context.drawImage(source, 0, 0, width, height)

  return context.getImageData(0, 0, width, height)
}

export const cosineSimilarity = (a, b) => {
  const length = Math.min(a.length, b.length)
  let score = 0

  for (let i = 0; i < length; i += 1) {
    score += a[i] * b[i]
  }

  return score
}
