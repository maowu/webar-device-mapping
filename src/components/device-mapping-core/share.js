// Injected at build time from .env (see .env.example and README §2).
// Security rules: see database.rules.json and README §2.
const FIREBASE_URL = process.env.FIREBASE_DATABASE_URL || ''

// Alphanumeric chars excluding visually ambiguous: 0/O, I/l/1
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'

const getDeviceId = () => {
  const KEY = 'device-mapping-device-id'
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
    localStorage.setItem(KEY, id)
  }
  return id
}

// Hash deviceId + timestamp (+ optional salt for retry-on-collision) into a short code.
const hashToCode = async (input, length) => {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const view = new Uint8Array(digest)
  let code = ''
  for (let i = 0; i < length; i += 1) {
    code += CODE_CHARS[view[i] % CODE_CHARS.length]
  }
  return code
}

// Derives a code from device id + timestamp, checking Firebase for collisions.
// Grows length (4 → 5 → 6) if repeated collisions occur.
export const generateCode = async (checkExists) => {
  const deviceId = getDeviceId()
  const now = Date.now()

  for (const length of [4, 4, 4, 5, 6]) {
    const salted = `${deviceId}:${now}:${length}:${Math.random()}`
    const code = await hashToCode(salted, length)
    if (!checkExists || !(await checkExists(code))) return code
  }
  throw new Error('Could not generate a unique code, please try again')
}

// --- Binary encoding helpers ---

const uint8ToBase64 = (data) => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  let binary = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

const base64ToUint8 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0))

// Encode {rows, cols, type, data: number[]} → compact {rows,cols,type,d:'base64'}
const encodeDescriptors = (desc) => {
  if (!desc?.data?.length) return desc
  return {rows: desc.rows, cols: desc.cols, type: desc.type, d: uint8ToBase64(desc.data)}
}

const decodeDescriptors = (desc) => {
  if (!desc?.d) return desc
  return {rows: desc.rows, cols: desc.cols, type: desc.type, data: Array.from(base64ToUint8(desc.d))}
}

// Quantize float32 embedding to Int8 + base64 (unit-norm vector → values in ~[-1,1])
const encodeEmbedding = (floats) => {
  if (!floats?.length) return floats
  const max = floats.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1
  const int8 = new Int8Array(floats.map((v) => Math.round((v / max) * 127)))
  return {s: max, d: uint8ToBase64(new Uint8Array(int8.buffer))}
}

const decodeEmbedding = (enc) => {
  if (!enc?.d) return enc
  const int8 = new Int8Array(base64ToUint8(enc.d).buffer)
  return Array.from(int8, (v) => (v * enc.s) / 127)
}

// --- Bundle build / load ---

const stripKeyframe = ({
  // Strip fields not needed for peer relocalization. guideImage is dropped here —
  // only the origin keyframe's copy travels, at the map level (see buildShareBundle),
  // so the bundle carries exactly one alignment photo instead of one per keyframe.
  image, guideImage, cameraPose, createdAt, edgesBuilt, localMap,
  embedding, features, mapPoints,
  ...kf
}) => ({
  ...kf,
  embedding: encodeEmbedding(embedding),
  features: features ? {
    imageSize: features.imageSize,
    keypoints: features.keypoints?.map(({x, y}) => ({x, y})),  // strip response/angle/octave
    descriptors: encodeDescriptors(features.descriptors),
  } : undefined,
  mapPoints: mapPoints?.map(({keypointIndex, position}) => ({keypointIndex, position})),
})

const stripMapPoint = ({position, descriptor, id, observations, observationCount}) => ({
  id,
  position,
  // Preserve the observation count (just a number). The 3D global-map
  // relocalization path filters to points with observationCount >= 2; the full
  // observations array is dropped to keep the bundle small, but without the
  // count every point failed that filter on the peer side, so cross-session 3D
  // relocalization matched 0 points and always fell back to the 2D path.
  observationCount: observationCount ?? observations?.length ?? 0,
  descriptor: encodeDescriptors({rows: 1, cols: descriptor?.length || 32, type: 0, data: descriptor}),
})

export const buildShareBundle = (keyframes, map, objects, version) => ({
  version,
  createdAt: new Date().toISOString(),
  keyframes: keyframes.map(stripKeyframe),
  map: map ? {
    id: map.id,
    originKeyframeId: map.originKeyframeId,
    originCameraWorldMatrix: map.originCameraWorldMatrix,
    localOriginOffset: map.localOriginOffset,
    guideImage: map.guideImage || null,
    points: map.points?.map(stripMapPoint),
  } : null,
  objects,
})

const restoreKeyframe = (kf) => ({
  ...kf,
  embedding: decodeEmbedding(kf.embedding),
  features: kf.features ? {
    ...kf.features,
    descriptors: decodeDescriptors(kf.features.descriptors),
  } : undefined,
})

const restoreMapPoint = (pt) => {
  const decoded = decodeDescriptors(pt.descriptor)
  return {
    ...pt,
    descriptor: decoded?.data || null,
    observations: [],
  }
}

export const loadShareBundle = (bundle) => ({
  keyframes: (bundle.keyframes || []).map(restoreKeyframe),
  map: bundle.map ? {
    ...bundle.map,
    points: (bundle.map.points || []).map(restoreMapPoint),
  } : null,
  objects: bundle.objects || [],
})

// --- Transport ---

const requireFirebaseUrl = () => {
  if (!FIREBASE_URL) throw new Error('Firebase not configured — set FIREBASE_DATABASE_URL in .env (see README §2)')
}

export const codeExists = async (code) => {
  requireFirebaseUrl()
  const res = await fetch(`${FIREBASE_URL}/maps/${code}.json?shallow=true`)
  if (!res.ok) return false
  const data = await res.json()
  return data !== null
}

// Generates a collision-checked code and uploads the bundle under it.
export const shareMapBundle = async (bundle) => {
  requireFirebaseUrl()
  const code = await generateCode(codeExists)
  const res = await fetch(`${FIREBASE_URL}/maps/${code}.json`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(bundle),
  })
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
  return code
}

// Overwrites an existing code's bundle in place (no new code is generated).
// Used by "edit an existing hunt" flows where the caller already owns/knows
// the code and wants the update to replace it rather than create a new one.
export const updateMapBundle = async (code, bundle) => {
  requireFirebaseUrl()
  const res = await fetch(`${FIREBASE_URL}/maps/${code}.json`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(bundle),
  })
  if (!res.ok) throw new Error(`Update failed: ${res.status}`)
  return code
}

export const downloadMapBundle = async (code) => {
  requireFirebaseUrl()
  const res = await fetch(`${FIREBASE_URL}/maps/${code.trim()}.json`)
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)
  const data = await res.json()
  if (!data) throw new Error('No map found for this code')
  return data
}

export const exportMapBundleAsFile = (bundle) => {
  const blob = new Blob([JSON.stringify(bundle)], {type: 'application/json'})
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `device-map-${Date.now()}.json`
  link.click()
  URL.revokeObjectURL(url)
}
