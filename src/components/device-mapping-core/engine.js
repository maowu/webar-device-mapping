import {
  descriptorAt,
  extractOrbFeatures,
  matchGlobalMapDescriptors,
  matchOrbFeatures,
  solvePnPFromMapPoints,
  triangulatePointsRay,
} from './feature-matcher.js'
import {
  captureFeatureImageData,
  captureFrameDescriptor,
  captureGuideImage,
  cosineSimilarity,
  getFeatureCaptureSize,
} from './vision.js'
import {
  clearObjects as clearStoredObjects,
  clearSpatialMemory,
  loadKeyframes,
  loadObjects,
  saveKeyframe,
  saveObjectPose,
} from './storage.js'
import {buildShareBundle, loadShareBundle} from './share.js'

// Relocalization acceptance thresholds. These were relaxed (matches 45→38,
// inliers 40→32, ratio 0.5→0.45, 2D inliers 18→16) to make Align succeed from a
// wider range of viewpoints — previously the camera had to nearly reproduce the
// scan's final angle. Only the *overlap* thresholds (how many features must
// match) were loosened; the geometric-consistency guard MAX_GLOBAL_MAP_REPROJECTION_ERROR
// (and the 2D path's MAX_REPROJECTION_ERROR_PX) is kept strict, so a pose is
// still rejected unless it actually reprojects the map points accurately — this
// is what prevents accepting a wrong pose. If wrong placements appear on the
// seeker side, raise these back toward the original values.
const MIN_RELOCALIZE_PNP_INLIERS = 16
const MIN_GLOBAL_MAP_MATCHES = 38
const MIN_GLOBAL_MAP_PNP_INLIERS = 32
const MIN_GLOBAL_MAP_INLIER_RATIO = 0.45
const MAX_GLOBAL_MAP_REPROJECTION_ERROR = 6
const MAX_MAP_POINT_BUCKET_SPREAD = 0.2
const MAX_SESSION_MAP_TRANSLATION_JUMP = 1.5
const MAP_POINT_MIN_DEPTH = 0.25
// Max triangulated map-point depth. A brief experiment capped this at 6m to
// build near-only maps for close targets (e.g. a torii within ~3m), dropping
// low-parallax far background. But in a normal-to-large space most scene points
// sit beyond 6m, so the cap rejected ~96% of triangulations (only ~42 map
// points, relocalization impossible). Restored to 20m — the value proven to
// build dense maps (~9k points). RANSAC PnP already tolerates the weak far
// points, so keeping them is strictly better than discarding real geometry.
const MAP_POINT_MAX_DEPTH = 20.0
const MIN_TRIANGULATION_BASELINE = 0.18
const MIN_TRIANGULATION_ANGLE = 2 * Math.PI / 180
const MAX_TRIANGULATION_BASELINE = 2.5
const MAX_KEYFRAME_TIME_GAP_MS = 600000
const MAX_REPROJECTION_ERROR_PX = 3.0
const NEAR_CAP_DEPTH_RATIO = 0.92
const AUTO_CAPTURE_MOVE_DISTANCE = 0.18
const AUTO_CAPTURE_MIN_INTERVAL_MS = 350
const AUTO_CAPTURE_MAX_KEYFRAMES = 200
const MIN_KEYFRAME_KEYPOINTS = 80
const RECENT_TRIANGULATION_KEYFRAMES = 3
const SCAN_COVERAGE_SECTORS = 24
const SCAN_ROTATE_SPEED = 0.012
const SCAN_MOVE_SPEED_MIN = 0.004
const SCAN_MOVE_SPEED_FAST = 0.05
const SCAN_COVERAGE_READY = 0.8
const SCAN_KEYFRAMES_READY = 18

const CAMERA_INTRINSICS = {
  fx: 288,
  fy: 288,
  cx: 160,
  cy: 120,
}

const RAD2DEG = 180 / Math.PI

const noop = () => {}
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

export const matrixFromArray = (values) => new THREE.Matrix4().fromArray(values)

export const positionToPlain = (position) => ({
  x: Number(position.x.toFixed(4)),
  y: Number(position.y.toFixed(4)),
  z: Number(position.z.toFixed(4)),
})

const invertMatrixArray = (values) => matrixFromArray(values).invert()
const identityMatrixArray = () => new THREE.Matrix4().identity().toArray()

const constrainToGravity = (matrix) => {
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  matrix.decompose(position, quaternion, scale)

  // Use the right axis for yaw because forward becomes unstable when the camera looks steeply up/down.
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion)
  right.y = 0

  const yaw = right.lengthSq() > 0.000001 ? Math.atan2(-right.z, right.x) : 0
  const yawQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)

  return new THREE.Matrix4().compose(position, yawQuaternion, new THREE.Vector3(1, 1, 1))
}

const summarizeDepths = (depths) => {
  if (!depths.length) return {count: 0}
  const sorted = depths.slice().sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    count: sorted.length,
    min: Number(sorted[0].toFixed(3)),
    median: Number(at(0.5).toFixed(3)),
    p90: Number(at(0.9).toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
  }
}

const median = (values) => {
  if (!values.length) return null
  const sorted = values.slice().sort((a, b) => a - b)
  return Number(sorted[Math.floor(sorted.length / 2)].toFixed(3))
}

const decomposeMatrixForLog = (matrix) => {
  if (!matrix) return null
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  matrix.decompose(position, quaternion, scale)
  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'YXZ')
  return {
    translation: positionToPlain(position),
    yawDeg: Number((euler.y * RAD2DEG).toFixed(2)),
    pitchDeg: Number((euler.x * RAD2DEG).toFixed(2)),
    rollDeg: Number((euler.z * RAD2DEG).toFixed(2)),
    scale: positionToPlain(scale),
  }
}

const createInitialState = () => ({
  keyframes: [],
  objects: [],
  activeKeyframe: null,
  map: null,
  mapBuiltInThisSession: false,
  lastRelocalization: null,
  lastFeatures: null,
  referenceFeatures: null,
  continuousScan: false,
  capturing: false,
  lastAutoCapturePosition: null,
  lastAutoCaptureTime: 0,
  continuousRafId: null,
  prevFramePos: null,
  prevFrameQuat: null,
  moveSpeed: 0,
  rotSpeed: 0,
  lastKeypointCount: 0,
  coverageSectors: null,
})

export const createMappingEngine = ({getCameraObject3D = null, callbacks: callbackOptions = {}} = {}) => {
  const state = createInitialState()
  const callbacks = {
    onStatus: noop,
    onMethod: noop,
    onDiagnostic: noop,
    onKeyframesChanged: noop,
    onScanAssist: noop,
    onRelocalized: noop,
    onObjectsChanged: noop,
    ...callbackOptions,
  }

  const emitStatus = (message = '') => callbacks.onStatus(message)
  const emitMethod = (method, label) => callbacks.onMethod(method, label)
  const emitDiagnostic = (eventName, payload) => callbacks.onDiagnostic(eventName, payload)
  const emitKeyframesChanged = (payload = null) => callbacks.onKeyframesChanged(payload)
  const emitObjectsChanged = () => callbacks.onObjectsChanged()
  const emitRelocalized = (relocalization) => callbacks.onRelocalized(relocalization)

  const getCameraRoot = () => getCameraObject3D?.() || null

  const requireCameraRoot = () => {
    const camera = getCameraRoot()
    if (!camera) throw new Error('Camera not ready')
    return camera
  }

  const getProjectionCamera = () => {
    const root = getCameraRoot()
    if (!root) return null
    if (root.userData?.projectionCamera?.projectionMatrix?.elements) return root.userData.projectionCamera
    if (root.projectionMatrix?.elements) return root
    let found = null
    root.traverse?.((object) => {
      if (!found && object.projectionMatrix?.elements) found = object
    })
    return found
  }

  const getCameraWorldMatrix = () => {
    const camera = requireCameraRoot()
    camera.updateMatrixWorld(true)
    return camera.matrixWorld.toArray()
  }

  const getCameraWorldPosition = () => {
    const camera = requireCameraRoot()
    camera.updateMatrixWorld(true)
    return camera.getWorldPosition(new THREE.Vector3())
  }

  const getCameraWorldQuaternion = () => {
    const camera = requireCameraRoot()
    camera.updateMatrixWorld(true)
    return camera.getWorldQuaternion(new THREE.Quaternion())
  }

  const getCameraIntrinsics = () => {
    const {width, height} = getFeatureCaptureSize()
    const e = getProjectionCamera()?.projectionMatrix?.elements
    if (!e) {
      return {
        fx: width * 0.9,
        fy: width * 0.9,
        cx: width / 2,
        cy: height / 2,
      }
    }

    return {
      fx: Math.abs(e[0]) * width / 2,
      fy: Math.abs(e[5]) * height / 2,
      cx: width / 2,
      cy: height / 2,
    }
  }

  const getCameraPose = () => {
    const camera = requireCameraRoot()
    return {
      position: positionToPlain(camera.position),
      rotation: {
        x: Number(camera.rotation.x.toFixed(4)),
        y: Number(camera.rotation.y.toFixed(4)),
        z: Number(camera.rotation.z.toFixed(4)),
      },
    }
  }

  const getCameraLocalPose = (worldPose) => {
    const camera = requireCameraRoot()
    const localPose = new THREE.Vector3(worldPose.x, worldPose.y, worldPose.z)
    camera.worldToLocal(localPose)
    return positionToPlain(localPose)
  }

  const createMapFromKeyframe = (keyframe) => ({
    id: `map-${Date.now()}`,
    originKeyframeId: keyframe.id,
    originCameraWorldMatrix: keyframe.cameraWorldMatrix,
    localOriginOffset: {x: 0, y: 0, z: 0},
    points: [],
    createdAt: new Date().toISOString(),
  })

  const getMapOriginMatrix = () => (
    state.map?.originCameraWorldMatrix ? matrixFromArray(state.map.originCameraWorldMatrix) : null
  )

  const getMapLocalOriginOffset = () => {
    const offset = state.map?.localOriginOffset
    return new THREE.Vector3(offset?.x || 0, offset?.y || 0, offset?.z || 0)
  }

  const getCurrentMapSessionMatrix = () => (
    state.lastRelocalization?.sessionMapMatrix
    || (state.map?.originCameraWorldMatrix ? matrixFromArray(state.map.originCameraWorldMatrix) : null)
  )

  const getMapLocalPose = (worldPose) => {
    if (!state.mapBuiltInThisSession && state.lastRelocalization?.sessionMapMatrix) {
      return positionToPlain(
        new THREE.Vector3(worldPose.x, worldPose.y, worldPose.z)
          .applyMatrix4(state.lastRelocalization.sessionMapMatrix.clone().invert())
      )
    }

    const mapOriginMatrix = getMapOriginMatrix()
    if (!mapOriginMatrix) return null
    // Store the object in the SAME frame the map points are normalized in:
    // calculateMapOriginOffset() / the point cloud use the raw mapOriginMatrix,
    // NOT a gravity-constrained one. Previously this used
    // constrainToGravity(mapOriginMatrix), which removed the origin keyframe's
    // pitch/roll and tilted the object frame relative to the point-cloud frame —
    // so a peer that relocalized accurately into the point cloud saw every
    // object at a stable offset. Using the raw matrix keeps objects and points
    // in one frame. (Same-session rendering bypasses this via the raw-pose path
    // in poseFromObject, so this value now only feeds cross-session/peer.)
    return positionToPlain(
      new THREE.Vector3(worldPose.x, worldPose.y, worldPose.z)
        .applyMatrix4(mapOriginMatrix.clone().invert())
        .sub(getMapLocalOriginOffset())
    )
  }

  const getWorldPoseFromMap = (mapLocalPose, sessionMapMatrix) => {
    if (!mapLocalPose || !sessionMapMatrix) return null

    const worldPose = new THREE.Vector3(mapLocalPose.x, mapLocalPose.y, mapLocalPose.z)
      .applyMatrix4(sessionMapMatrix)
    return positionToPlain(worldPose)
  }

  const getKeyframeLocalPose = (worldPose, keyframe) => {
    if (!keyframe?.cameraWorldMatrix) return null

    const localPose = new THREE.Vector3(worldPose.x, worldPose.y, worldPose.z)
      .applyMatrix4(invertMatrixArray(keyframe.cameraWorldMatrix))
    return positionToPlain(localPose)
  }

  const getKeyframeTransform = (fromKeyframe, toKeyframe) => {
    if (!fromKeyframe?.cameraWorldMatrix || !toKeyframe?.cameraWorldMatrix) return null

    return invertMatrixArray(toKeyframe.cameraWorldMatrix)
      .multiply(matrixFromArray(fromKeyframe.cameraWorldMatrix))
      .toArray()
  }

  const transformWithRecoveredRotation = (fallbackTransform, relativePose) => {
    if (!relativePose?.rotation?.length) return fallbackTransform

    const fallbackMatrix = matrixFromArray(fallbackTransform)
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    fallbackMatrix.decompose(position, quaternion, scale)

    const r = relativePose.rotation
    const rotationMatrix = new THREE.Matrix4()
    rotationMatrix.set(
      r[0], r[1], r[2], 0,
      r[3], r[4], r[5], 0,
      r[6], r[7], r[8], 0,
      0, 0, 0, 1
    )
    rotationMatrix.setPosition(position)

    return rotationMatrix.toArray()
  }

  const findKeyframe = (id) => state.keyframes.find((keyframe) => keyframe.id === id)

  const cameraFromMatrix = (matrixArray) => {
    const matrix = matrixFromArray(matrixArray)
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    matrix.decompose(position, quaternion, scale)
    return {position, quaternion}
  }

  const getPointDepthInCamera = (worldPoint, cameraMatrix) => {
    const localPoint = worldPoint.clone().applyMatrix4(invertMatrixArray(cameraMatrix))
    return -localPoint.z
  }

  const projectPointToImage = (worldPoint, cameraMatrixArray, intrinsics) => {
    const local = worldPoint.clone().applyMatrix4(invertMatrixArray(cameraMatrixArray))
    if (local.z >= 0) return null

    return {
      x: intrinsics.cx + intrinsics.fx * (local.x / -local.z),
      y: intrinsics.cy - intrinsics.fy * (local.y / -local.z),
    }
  }

  const upsertMapPoint = (keyframe, keypointIndex, worldPoint, quality = {}) => {
    keyframe.mapPoints = keyframe.mapPoints || []
    const localPoint = getKeyframeLocalPose(positionToPlain(worldPoint), keyframe)
    if (!localPoint) return
    const depth = -localPoint.z
    if (depth < MAP_POINT_MIN_DEPTH || depth > MAP_POINT_MAX_DEPTH) return

    const reproj = quality.reproj || {}
    keyframe.mapPoints = keyframe.mapPoints.filter((point) => point.keypointIndex !== keypointIndex)
    keyframe.mapPoints.push({
      id: `mp-${keyframe.id}-${keypointIndex}`,
      keypointIndex,
      position: localPoint,
      depth: Number(depth.toFixed(4)),
      triAngleDeg: Number(((quality.angle || 0) * RAD2DEG).toFixed(2)),
      rayGap: Number((quality.rayGap || 0).toFixed(4)),
      reproj: {
        from: Number((reproj.from || 0).toFixed(2)),
        to: Number((reproj.to || 0).toFixed(2)),
        max: Number((reproj.max || 0).toFixed(2)),
      },
    })
  }

  const addSparseMapPoints = async (fromKeyframe, toKeyframe, feature, intrinsics = CAMERA_INTRINSICS) => {
    if (!feature?.matches?.length) return {added: 0, reason: 'no_matches'}
    const fromCamera = cameraFromMatrix(fromKeyframe.cameraWorldMatrix)
    const toCamera = cameraFromMatrix(toKeyframe.cameraWorldMatrix)
    const baseline = fromCamera.position.distanceTo(toCamera.position)
    if (baseline < MIN_TRIANGULATION_BASELINE) return {added: 0, reason: `baseline_low:${baseline.toFixed(3)}`}
    if (baseline > MAX_TRIANGULATION_BASELINE) return {added: 0, reason: `baseline_high:${baseline.toFixed(3)}`}
    if (Math.abs(new Date(fromKeyframe.createdAt) - new Date(toKeyframe.createdAt)) > MAX_KEYFRAME_TIME_GAP_MS) {
      return {added: 0, reason: 'time_gap'}
    }

    const matches = feature.matches.slice(0, 160)
    const worldPoints = triangulatePointsRay(
      fromKeyframe.cameraWorldMatrix,
      toKeyframe.cameraWorldMatrix,
      intrinsics,
      matches.map((match) => match.currentPoint),
      matches.map((match) => match.keyframePoint)
    )

    let added = 0
    let rNaN = 0
    let rDepth = 0
    // Depth-rejection sub-tally so a log can tell "too far" (raise cap / large
    // space) apart from "behind camera or absurdly close" (bad correspondence /
    // pose) — the two failures need opposite fixes.
    let rDepthNeg = 0
    let rDepthNear = 0
    let rDepthFar = 0
    let rNearCap = 0
    let rAngle = 0
    let rReproj = 0
    const depthSampleA = []
    const depthSampleB = []

    matches.forEach((match, index) => {
      const solved = worldPoints[index]
      if (!solved || !Number.isFinite(solved.x) || !Number.isFinite(solved.y) || !Number.isFinite(solved.z)) {
        rNaN += 1
        return
      }
      const worldPoint = new THREE.Vector3(solved.x, solved.y, solved.z)

      const depthA = getPointDepthInCamera(worldPoint, fromKeyframe.cameraWorldMatrix)
      const depthB = getPointDepthInCamera(worldPoint, toKeyframe.cameraWorldMatrix)
      if (depthSampleA.length < 5) {
        depthSampleA.push(Number(depthA.toFixed(3)))
        depthSampleB.push(Number(depthB.toFixed(3)))
      }
      if (
        depthA < MAP_POINT_MIN_DEPTH
        || depthA > MAP_POINT_MAX_DEPTH
        || depthB < MAP_POINT_MIN_DEPTH
        || depthB > MAP_POINT_MAX_DEPTH
      ) {
        rDepth += 1
        if (depthA < 0 || depthB < 0) rDepthNeg += 1
        else if (depthA < MAP_POINT_MIN_DEPTH || depthB < MAP_POINT_MIN_DEPTH) rDepthNear += 1
        else rDepthFar += 1
        return
      }
      if (depthA > MAP_POINT_MAX_DEPTH * NEAR_CAP_DEPTH_RATIO || depthB > MAP_POINT_MAX_DEPTH * NEAR_CAP_DEPTH_RATIO) {
        rNearCap += 1
        return
      }

      const angle = fromCamera.position.clone().sub(worldPoint).angleTo(toCamera.position.clone().sub(worldPoint))
      if (angle < MIN_TRIANGULATION_ANGLE) {
        rAngle += 1
        return
      }

      const fromProjection = projectPointToImage(worldPoint, fromKeyframe.cameraWorldMatrix, intrinsics)
      const toProjection = projectPointToImage(worldPoint, toKeyframe.cameraWorldMatrix, intrinsics)
      if (!fromProjection || !toProjection) {
        rReproj += 1
        return
      }

      const reprojFrom = Math.hypot(fromProjection.x - match.currentPoint.x, fromProjection.y - match.currentPoint.y)
      const reprojTo = Math.hypot(toProjection.x - match.keyframePoint.x, toProjection.y - match.keyframePoint.y)
      if (reprojFrom > MAX_REPROJECTION_ERROR_PX || reprojTo > MAX_REPROJECTION_ERROR_PX) {
        rReproj += 1
        return
      }

      const quality = {
        angle,
        rayGap: 0,
        reproj: {
          from: reprojFrom,
          to: reprojTo,
          max: Math.max(reprojFrom, reprojTo),
        },
      }

      upsertMapPoint(fromKeyframe, match.queryIdx, worldPoint, quality)
      upsertMapPoint(toKeyframe, match.trainIdx, worldPoint, quality)
      added += 1
    })

    return {
      added,
      baseline: Number(baseline.toFixed(3)),
      tried: matches.length,
      rejected: {nan: rNaN, depth: rDepth, nearCap: rNearCap, angle: rAngle, reproj: rReproj},
      depthBreakdown: {negative: rDepthNeg, tooNear: rDepthNear, tooFar: rDepthFar},
      depthSampleA,
      depthSampleB,
    }
  }

  const findGraphTransform = (fromId, toId) => {
    if (!fromId || !toId) return null
    if (fromId === toId) return identityMatrixArray()

    const queue = [{id: fromId, transform: new THREE.Matrix4().identity()}]
    const visited = new Set([fromId])

    while (queue.length > 0) {
      const current = queue.shift()
      const keyframe = findKeyframe(current.id)

      for (const edge of keyframe?.neighbors || []) {
        if (visited.has(edge.to)) continue

        const transform = matrixFromArray(edge.transform).multiply(current.transform)
        if (edge.to === toId) return transform.toArray()

        visited.add(edge.to)
        queue.push({id: edge.to, transform})
      }
    }

    return null
  }

  const collectGlobalMapPoints = () => {
    const stats = {
      rawObservations: 0,
      rejectedDepth: 0,
      rejectedDescriptor: 0,
      rejectedSpread: 0,
      buckets: 0,
      keptPoints: 0,
    }
    if (!state.map?.originKeyframeId) return {points: [], stats}

    const pointBuckets = new Map()
    for (const keyframe of state.keyframes) {
      const keyframeToMap = findGraphTransform(keyframe.id, state.map.originKeyframeId)
      if (!keyframeToMap) continue
      const keyframeToMapMatrix = matrixFromArray(keyframeToMap)

      for (const mapPoint of keyframe.mapPoints || []) {
        stats.rawObservations += 1
        if (!mapPoint.position) {
          stats.rejectedDepth += 1
          continue
        }
        const depth = mapPoint.depth ?? -mapPoint.position?.z
        if (!Number.isFinite(depth) || depth < MAP_POINT_MIN_DEPTH || depth > MAP_POINT_MAX_DEPTH) {
          stats.rejectedDepth += 1
          continue
        }
        const mapPosition = new THREE.Vector3(mapPoint.position.x, mapPoint.position.y, mapPoint.position.z)
          .applyMatrix4(keyframeToMapMatrix)
        const descriptor = descriptorAt(keyframe.features, mapPoint.keypointIndex)
        if (!descriptor) {
          stats.rejectedDescriptor += 1
          continue
        }

        const position = positionToPlain(mapPosition)
        const bucketKey = [
          Math.round(position.x / 0.18),
          Math.round(position.y / 0.18),
          Math.round(position.z / 0.18),
        ].join(':')
        const bucket = pointBuckets.get(bucketKey) || {
          id: `gmp-${bucketKey}`,
          positions: [],
          descriptors: [],
          observations: [],
        }

        bucket.positions.push(position)
        bucket.descriptors.push(descriptor)
        bucket.observations.push({
          keyframeId: keyframe.id,
          keypointIndex: mapPoint.keypointIndex,
        })
        pointBuckets.set(bucketKey, bucket)
      }
    }

    const points = Array.from(pointBuckets.values())
      .filter((bucket) => new Set(bucket.observations.map((observation) => observation.keyframeId)).size >= 2)
      .map((bucket) => {
        const position = bucket.positions.reduce((sum, position) => ({
          x: sum.x + position.x,
          y: sum.y + position.y,
          z: sum.z + position.z,
        }), {x: 0, y: 0, z: 0})
        const bestDescriptor = bucket.descriptors[0]
        const average = {
          x: position.x / bucket.positions.length,
          y: position.y / bucket.positions.length,
          z: position.z / bucket.positions.length,
        }
        const spread = bucket.positions.reduce((maxSpread, position) => Math.max(
          maxSpread,
          new THREE.Vector3(position.x, position.y, position.z).distanceTo(new THREE.Vector3(average.x, average.y, average.z))
        ), 0)

        if (spread > MAX_MAP_POINT_BUCKET_SPREAD) {
          stats.rejectedSpread += 1
          return null
        }

        return {
          id: bucket.id,
          position: {
            x: Number(average.x.toFixed(4)),
            y: Number(average.y.toFixed(4)),
            z: Number(average.z.toFixed(4)),
          },
          descriptor: bestDescriptor,
          observations: bucket.observations,
          observationCount: bucket.observations.length,
          spread: Number(spread.toFixed(4)),
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.observationCount - a.observationCount)
      .slice(0, 600)

    stats.buckets = pointBuckets.size
    stats.keptPoints = points.length
    return {points, stats}
  }

  const calculateMapOriginOffset = (points) => {
    if (!points?.length) return {x: 0, y: 0, z: 0}
    const mapOriginMatrix = getMapOriginMatrix()
    if (!mapOriginMatrix) return {x: 0, y: 0, z: 0}

    const worldPoints = points.map((point) => (
      new THREE.Vector3(point.position.x, point.position.y, point.position.z).applyMatrix4(mapOriginMatrix)
    ))

    const bounds = worldPoints.reduce((box, point) => ({
      minX: Math.min(box.minX, point.x),
      maxX: Math.max(box.maxX, point.x),
      minY: Math.min(box.minY, point.y),
      maxY: Math.max(box.maxY, point.y),
      minZ: Math.min(box.minZ, point.z),
      maxZ: Math.max(box.maxZ, point.z),
    }), {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity,
    })

    const worldOrigin = new THREE.Vector3(
      (bounds.minX + bounds.maxX) / 2,
      bounds.minY,
      (bounds.minZ + bounds.maxZ) / 2
    )
    const localOrigin = worldOrigin.applyMatrix4(mapOriginMatrix.clone().invert())

    return positionToPlain(localOrigin)
  }

  const normalizeMapPointsToOrigin = (points, offset) => points.map((point) => ({
    ...point,
    position: {
      x: Number((point.position.x - offset.x).toFixed(4)),
      y: Number((point.position.y - offset.y).toFixed(4)),
      z: Number((point.position.z - offset.z).toFixed(4)),
    },
  }))

  const collectMapPointDepthStats = () => {
    const depths = []
    for (const keyframe of state.keyframes) {
      for (const mapPoint of keyframe.mapPoints || []) {
        if (Number.isFinite(mapPoint.depth)) depths.push(mapPoint.depth)
      }
    }
    return summarizeDepths(depths)
  }

  const collectTriangulationStats = () => {
    const angles = []
    const rayGaps = []
    const reprojs = []
    for (const keyframe of state.keyframes) {
      for (const mapPoint of keyframe.mapPoints || []) {
        if (Number.isFinite(mapPoint.triAngleDeg)) angles.push(mapPoint.triAngleDeg)
        if (Number.isFinite(mapPoint.rayGap)) rayGaps.push(mapPoint.rayGap)
        if (Number.isFinite(mapPoint.reproj?.max)) reprojs.push(mapPoint.reproj.max)
      }
    }
    return {
      count: angles.length,
      medianAngleDeg: median(angles),
      medianRayGap: median(rayGaps),
      medianReprojMax: median(reprojs),
    }
  }

  const buildPnPInput = (keyframe, feature) => {
    const byKeypoint = new Map((keyframe.mapPoints || []).map((point) => [point.keypointIndex, point.position]))
    const mapPoints = []
    const imagePoints = []
    const pointIds = []

    for (const match of feature?.matches || []) {
      const mapPoint = byKeypoint.get(match.trainIdx)
      if (!mapPoint) continue

      mapPoints.push(mapPoint)
      imagePoints.push(match.currentPoint)
      pointIds.push(match.trainIdx)
    }

    return {mapPoints, imagePoints, pointIds}
  }

  const createRelocalization = (match) => ({
    ...match,
    cameraWorldMatrix: getCameraWorldMatrix(),
  })

  const getGlobalThresholds = (mapPointCount) => {
    const scale = Math.max(0.45, Math.min(1, (mapPointCount || 0) / 300))
    return {
      minMatches: Math.max(20, Math.round(MIN_GLOBAL_MAP_MATCHES * scale)),
      minPnpInliers: Math.max(16, Math.round(MIN_GLOBAL_MAP_PNP_INLIERS * scale)),
    }
  }

  const getGlobalPnpRejectReason = (globalMatches, globalPnp, acceptedMatches = globalMatches, thresholds = null) => {
    const minMatches = thresholds?.minMatches ?? MIN_GLOBAL_MAP_MATCHES
    const minPnpInliers = thresholds?.minPnpInliers ?? MIN_GLOBAL_MAP_PNP_INLIERS

    if (acceptedMatches.length < minMatches) return `filtered matches ${acceptedMatches.length} < ${minMatches}`
    if (!globalPnp.accepted) return 'solvePnP rejected'
    if (globalPnp.inliers < minPnpInliers) return `pnp inliers ${globalPnp.inliers} < ${minPnpInliers}`

    const inlierRatio = globalPnp.inliers / acceptedMatches.length
    if (inlierRatio < MIN_GLOBAL_MAP_INLIER_RATIO) {
      return `pnp inlier ratio ${inlierRatio.toFixed(2)} < ${MIN_GLOBAL_MAP_INLIER_RATIO}`
    }

    const error = globalPnp.reprojectionError?.inlierMean ?? Infinity
    if (error > MAX_GLOBAL_MAP_REPROJECTION_ERROR) {
      return `pnp reprojection ${error}px > ${MAX_GLOBAL_MAP_REPROJECTION_ERROR}px`
    }

    return null
  }

  const getMatrixTranslation = (matrix) => new THREE.Vector3().setFromMatrixPosition(matrix)

  const getSessionMapJumpRejectReason = (sessionMapMatrix) => {
    if (!state.lastRelocalization?.sessionMapMatrix || !sessionMapMatrix) return null

    const previous = getMatrixTranslation(state.lastRelocalization.sessionMapMatrix)
    const current = getMatrixTranslation(sessionMapMatrix)
    const distance = previous.distanceTo(current)

    return distance > MAX_SESSION_MAP_TRANSLATION_JUMP
      ? `session map jump ${distance.toFixed(2)}m > ${MAX_SESSION_MAP_TRANSLATION_JUMP}m`
      : null
  }

  const filterMatchesByPnpInliers = (matches, pnp, maxError) => {
    const pointErrors = pnp?.reprojectionError?.pointErrors || []
    const inlierSet = new Set(pnp?.inlierIndices || [])

    return matches.filter((match, index) => (
      inlierSet.has(index)
      && Number.isFinite(pointErrors[index])
      && pointErrors[index] <= maxError
    ))
  }

  const sessionMapMatrixFromRelocalization = (relocalization) => {
    if (relocalization?.mode === 'global-map' && relocalization.pnp?.accepted) {
      const r = relocalization.pnp.rotation
      const t = relocalization.pnp.tvec
      const cvToThreeCamera = new THREE.Matrix4().makeScale(1, -1, -1)
      const cameraInMap = new THREE.Matrix4()
      cameraInMap.set(
        r[0], r[1], r[2], t[0],
        r[3], r[4], r[5], t[1],
        r[6], r[7], r[8], t[2],
        0, 0, 0, 1
      )
      cameraInMap.premultiply(cvToThreeCamera)

      return constrainToGravity(matrixFromArray(relocalization.cameraWorldMatrix).multiply(cameraInMap))
    }

    const graphTransform = state.map?.originKeyframeId && relocalization?.keyframe?.id
      ? findGraphTransform(state.map.originKeyframeId, relocalization.keyframe.id)
      : null
    const graphMatrix = graphTransform
      ? matrixFromArray(relocalization.cameraWorldMatrix).multiply(matrixFromArray(graphTransform))
      : null

    if (relocalization?.pnp?.accepted && relocalization.pnp.rotation?.length && relocalization.pnp.tvec?.length) {
      const r = relocalization.pnp.rotation
      const t = relocalization.pnp.tvec
      const cvToThreeCamera = new THREE.Matrix4().makeScale(1, -1, -1)
      const cameraInMatchedKeyframe = new THREE.Matrix4()
      cameraInMatchedKeyframe.set(
        r[0], r[1], r[2], t[0],
        r[3], r[4], r[5], t[1],
        r[6], r[7], r[8], t[2],
        0, 0, 0, 1
      )
      cameraInMatchedKeyframe.premultiply(cvToThreeCamera)

      const mapToMatchedKeyframe = graphTransform ? matrixFromArray(graphTransform) : new THREE.Matrix4().identity()
      const offset = getMapLocalOriginOffset()
      const offsetMatrix = new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z)

      return constrainToGravity(
        matrixFromArray(relocalization.cameraWorldMatrix)
          .multiply(cameraInMatchedKeyframe)
          .multiply(mapToMatchedKeyframe)
          .multiply(offsetMatrix)
      )
    }

    return graphMatrix ? constrainToGravity(graphMatrix) : null
  }

  const poseFromObject = (objectPose, relocalization = null) => {
    // Same-session objects (map built this session, not loaded from a bundle)
    // are already expressed in the live world frame, so their raw tapped pose is
    // exactly correct. Round-tripping through mapLocalPose↔sessionMapMatrix here
    // introduces a visible offset — the self-localized sessionMapMatrix is only
    // an approximate inverse of the build-session getMapLocalPose transform — so
    // the placed marker lands away from where the user tapped. Only cross-session
    // (loaded-bundle) objects need the map transform below.
    if (state.mapBuiltInThisSession && objectPose.pose) return objectPose.pose

    if (objectPose.mapLocalPose && relocalization?.sessionMapMatrix) {
      const pose = getWorldPoseFromMap(objectPose.mapLocalPose, relocalization.sessionMapMatrix)
      if (pose) {
        pose.y = objectPose.groundY ?? pose.y
        return pose
      }
    }

    if (!objectPose.keyframeLocalPose || !relocalization?.cameraWorldMatrix) return objectPose.pose

    const graphTransform = findGraphTransform(objectPose.keyframeId, relocalization.keyframe.id)
    if (!graphTransform) return null

    const currentCameraMatrix = matrixFromArray(relocalization.cameraWorldMatrix)
    const localPose = new THREE.Vector3(
      objectPose.keyframeLocalPose.x,
      objectPose.keyframeLocalPose.y,
      objectPose.keyframeLocalPose.z
    ).applyMatrix4(matrixFromArray(graphTransform))
    const worldPose = localPose.applyMatrix4(currentCameraMatrix)
    worldPose.y = objectPose.groundY ?? objectPose.pose.y
    return positionToPlain(worldPose)
  }

  const getRestoredObjectPoses = (relocalization = null) => state.objects
    .map((objectPose) => poseFromObject(objectPose, relocalization))
    .filter(Boolean)

  const getMapPointWorldPose = (keyframe, mapPoint, sessionMapMatrix) => {
    const keyframeToMapOrigin = state.map?.originKeyframeId
      ? findGraphTransform(keyframe.id, state.map.originKeyframeId)
      : null

    if (!keyframeToMapOrigin || !sessionMapMatrix) return null

    const mapLocal = new THREE.Vector3(mapPoint.position.x, mapPoint.position.y, mapPoint.position.z)
      .applyMatrix4(matrixFromArray(keyframeToMapOrigin))
      .sub(getMapLocalOriginOffset())
    const worldPose = mapLocal.applyMatrix4(sessionMapMatrix)

    return positionToPlain(worldPose)
  }

  const buildKeyframeGraphEdges = async (keyframe, candidatePool = null) => {
    keyframe.neighbors = keyframe.neighbors || []
    const pool = (candidatePool || state.keyframes).filter((candidate) => candidate.id !== keyframe.id)
    const scoredCandidates = pool.map((candidate) => ({
      keyframe: candidate,
      score: cosineSimilarity(keyframe.embedding, candidate.embedding),
    }))
    const topCandidates = scoredCandidates.slice().sort((a, b) => b.score - a.score).slice(0, 5)
    const recentIds = new Set(pool.slice(-RECENT_TRIANGULATION_KEYFRAMES).map((candidate) => candidate.id))
    const candidatesById = new Map()

    for (const candidate of topCandidates) candidatesById.set(candidate.keyframe.id, candidate)
    for (const candidate of scoredCandidates) {
      if (recentIds.has(candidate.keyframe.id)) candidatesById.set(candidate.keyframe.id, candidate)
    }

    const candidates = Array.from(candidatesById.values())

    for (const candidate of candidates) {
      const feature = await matchOrbFeatures(keyframe.features, candidate.keyframe.features, getCameraIntrinsics())
      if (!feature.accepted) continue

      const toCandidateFallback = getKeyframeTransform(keyframe, candidate.keyframe)
      const toCandidate = transformWithRecoveredRotation(toCandidateFallback, feature.relativePose)
      const toNewKeyframe = toCandidate ? matrixFromArray(toCandidate).invert().toArray() : null
      if (!toCandidate || !toNewKeyframe) continue
      const triResult = await addSparseMapPoints(keyframe, candidate.keyframe, feature, getCameraIntrinsics())
      const mapPointsAdded = triResult?.added ?? 0

      keyframe.neighbors.push({
        to: candidate.keyframe.id,
        transform: toCandidate,
        inliers: feature.inliers,
        mapPoints: mapPointsAdded,
        score: Number(candidate.score.toFixed(4)),
        tri: triResult,
      })

      candidate.keyframe.neighbors = candidate.keyframe.neighbors || []
      candidate.keyframe.neighbors = candidate.keyframe.neighbors.filter((edge) => edge.to !== keyframe.id)
      candidate.keyframe.neighbors.push({
        to: keyframe.id,
        transform: toNewKeyframe,
        inliers: feature.inliers,
        mapPoints: mapPointsAdded,
        score: Number(candidate.score.toFixed(4)),
      })

      await saveKeyframe(candidate.keyframe)
    }
  }

  const captureKeyframe = async ({auto = false} = {}) => {
    try {
      if (!auto) emitStatus('Extracting ORB keyframe...')
      const descriptor = captureFrameDescriptor()
      const features = await extractOrbFeatures(captureFeatureImageData())
      state.lastKeypointCount = features.keypoints.length
      if (features.keypoints.length < MIN_KEYFRAME_KEYPOINTS) {
        emitStatus(auto ? 'Scanning...' : 'Not enough texture, aim at a detailed area')
        return false
      }

      state.lastFeatures = features
      state.referenceFeatures = features
      const keyframe = {
        id: `kf-${Date.now()}`,
        label: `KF ${state.keyframes.length + 1}`,
        createdAt: new Date().toISOString(),
        cameraPose: getCameraPose(),
        cameraWorldMatrix: getCameraWorldMatrix(),
        neighbors: [],
        features,
        guideImage: captureGuideImage(),
        ...descriptor,
      }

      if (!auto) await buildKeyframeGraphEdges(keyframe)
      keyframe.edgesBuilt = !auto
      await saveKeyframe(keyframe)
      state.keyframes.push(keyframe)
      state.activeKeyframe = keyframe
      emitKeyframesChanged({type: 'capture', auto, keyframe})
      emitDiagnostic('capture-keyframe', {
        keyframe: {
          id: keyframe.id,
          label: keyframe.label,
          cameraPose: keyframe.cameraPose,
          cameraWorldMatrix: keyframe.cameraWorldMatrix,
          keypoints: keyframe.features?.keypoints?.length || 0,
          featureDistribution: keyframe.features?.distribution,
          edges: keyframe.neighbors.length,
          mapPoints: keyframe.mapPoints?.length || 0,
          deferred: auto,
        },
        intrinsics: getCameraIntrinsics(),
        captureSize: getFeatureCaptureSize(),
        mapPointDepthStats: collectMapPointDepthStats(),
        triangulationStats: collectTriangulationStats(),
      })
      if (!auto) emitStatus(`Saved ${keyframe.label} / edges ${keyframe.neighbors.length}`)
      return true
    } catch (error) {
      // Surface the real failure — this used to be swallowed silently, making
      // "scan never accumulates frames" impossible to diagnose from a log alone.
      emitDiagnostic('capture-keyframe-error', {
        auto,
        message: String(error?.message || error),
        stack: String(error?.stack || ''),
      })
      if (!auto) emitStatus('Camera not ready, move the phone and try again')
      return false
    }
  }

  const cameraAzimuthSector = (position, centerX, centerZ) => {
    const azimuth = Math.atan2(position.x - centerX, position.z - centerZ)
    return Math.floor(((azimuth + Math.PI) / (2 * Math.PI)) * SCAN_COVERAGE_SECTORS) % SCAN_COVERAGE_SECTORS
  }

  const getCoverageCenter = () => {
    const positions = state.keyframes.map((keyframe) => cameraFromMatrix(keyframe.cameraWorldMatrix).position)
    if (!positions.length) return null
    const center = positions.reduce((sum, p) => ({x: sum.x + p.x, z: sum.z + p.z}), {x: 0, z: 0})
    return {x: center.x / positions.length, z: center.z / positions.length}
  }

  const updateScanCoverage = () => {
    const center = getCoverageCenter()
    const sectors = new Set()
    if (center) {
      for (const keyframe of state.keyframes) {
        const p = cameraFromMatrix(keyframe.cameraWorldMatrix).position
        sectors.add(cameraAzimuthSector(p, center.x, center.z))
      }
    }
    state.coverageSectors = sectors
  }

  const SCAN_COACH = {
    orbit: {warn: false, msg: 'Good, keep circling the object', sub: 'Keep the target centered, move sideways for parallax so the map gains depth'},
    rotate: {warn: true, msg: "Don't spin in place — sidestep around the object", sub: 'Turning the camera alone builds no depth. Physically walk to view the target from different positions'},
    fast: {warn: true, msg: 'Slow down, the image will blur', sub: 'Moving too fast blurs features. Slow down and move steadily'},
    lowtex: {warn: true, msg: 'Aim at a detailed area', sub: 'Blank walls have no feature points. Point the camera at textured objects with edges/corners'},
    done: {warn: false, msg: 'Coverage sufficient, ready to build map', sub: 'Target captured from multiple angles. Stop scanning and build the 3D map'},
  }

  const emitScanAssist = (current) => {
    const quat = getCameraWorldQuaternion()
    if (state.prevFramePos && state.prevFrameQuat) {
      state.moveSpeed = state.moveSpeed * 0.7 + current.distanceTo(state.prevFramePos) * 0.3
      state.rotSpeed = state.rotSpeed * 0.7 + quat.angleTo(state.prevFrameQuat) * 0.3
    }
    state.prevFramePos = current.clone()
    state.prevFrameQuat = quat.clone()

    const sectors = state.coverageSectors || new Set()
    const coverage = sectors.size / SCAN_COVERAGE_SECTORS
    const textureOk = !state.lastKeypointCount || state.lastKeypointCount >= MIN_KEYFRAME_KEYPOINTS * 1.3
    const moving = state.moveSpeed >= SCAN_MOVE_SPEED_MIN

    let mode = 'orbit'
    if (state.moveSpeed > SCAN_MOVE_SPEED_FAST) mode = 'fast'
    else if (state.rotSpeed > SCAN_ROTATE_SPEED && !moving) mode = 'rotate'
    else if (!textureOk) mode = 'lowtex'
    else if (coverage >= SCAN_COVERAGE_READY && state.keyframes.length >= SCAN_KEYFRAMES_READY) mode = 'done'

    const center = getCoverageCenter()
    const youDeg = center
      ? (cameraAzimuthSector(current, center.x, center.z) + 0.5) / SCAN_COVERAGE_SECTORS * 360
      : NaN
    const parallax = state.lastAutoCapturePosition ? current.distanceTo(state.lastAutoCapturePosition) : 0
    const progress = Math.min(1, parallax / AUTO_CAPTURE_MOVE_DISTANCE)

    callbacks.onScanAssist({
      mode,
      coach: SCAN_COACH[mode],
      keyframeCount: state.keyframes.length,
      coverage,
      progress,
      meterText: mode === 'rotate'
        ? 'Barely moving'
        : (progress >= 1 ? 'Capturing...' : `Next in ${Math.max(0, Math.round((AUTO_CAPTURE_MOVE_DISTANCE - parallax) * 100))}cm`),
      moving,
      textureOk,
      sectors: Array.from(sectors),
      sectorCount: SCAN_COVERAGE_SECTORS,
      youDeg,
    })
  }

  const stopContinuousScan = () => {
    state.continuousScan = false
    if (state.continuousRafId) cancelAnimationFrame(state.continuousRafId)
    state.continuousRafId = null
    state.capturing = false
    state.prevFramePos = null
    state.prevFrameQuat = null
    callbacks.onScanAssist(null)
  }

  const startContinuousScan = () => {
    if (state.continuousScan) return
    state.continuousScan = true
    state.lastAutoCapturePosition = getCameraWorldPosition()
    state.lastAutoCaptureTime = 0
    state.moveSpeed = 0
    state.rotSpeed = 0
    state.prevFramePos = null
    updateScanCoverage()
    emitStatus('Scanning: sidestep around the target')

    const tick = async () => {
      if (!state.continuousScan) return
      if (state.keyframes.length >= AUTO_CAPTURE_MAX_KEYFRAMES) {
        emitDiagnostic('scan-limit', {keyframes: state.keyframes.length})
        stopContinuousScan()
        return
      }

      const current = getCameraWorldPosition()
      emitScanAssist(current)

      if (!state.capturing) {
        const now = performance.now()
        const movedEnough = !state.lastAutoCapturePosition
          || current.distanceTo(state.lastAutoCapturePosition) >= AUTO_CAPTURE_MOVE_DISTANCE

        if (now - state.lastAutoCaptureTime >= AUTO_CAPTURE_MIN_INTERVAL_MS && movedEnough) {
          state.capturing = true
          const ok = await captureKeyframe({auto: true})
          if (ok) {
            state.lastAutoCapturePosition = current.clone()
            state.lastAutoCaptureTime = now
            updateScanCoverage()
          }
          state.capturing = false
        }
      }

      state.continuousRafId = requestAnimationFrame(tick)
    }

    state.continuousRafId = requestAnimationFrame(tick)
  }

  const findTopMatches = () => {
    const descriptor = captureFrameDescriptor()
    const matches = state.keyframes
      .map((keyframe) => ({
        keyframe,
        score: cosineSimilarity(descriptor.embedding, keyframe.embedding),
      }))
      .sort((a, b) => b.score - a.score)

    const activeMatch = state.activeKeyframe
      ? matches.find((match) => match.keyframe.id === state.activeKeyframe.id)
      : null
    const topMatches = matches.slice(0, 3)

    if (activeMatch && activeMatch.score > 0.68 && !topMatches.some((match) => match.keyframe.id === activeMatch.keyframe.id)) {
      return [activeMatch, ...topMatches.slice(0, 2)]
    }

    return topMatches
  }

  const autoSelfLocalize = async () => {
    const originKeyframe = state.keyframes.find((kf) => kf.id === state.map?.originKeyframeId)
    if (!originKeyframe?.mapPoints?.length) return null

    try {
      const mapPoints = originKeyframe.mapPoints.map((pt) => pt.position)
      const imagePoints = originKeyframe.mapPoints.map((pt) => {
        const kp = originKeyframe.features?.keypoints?.[pt.keypointIndex]
        return kp ? {x: kp.x, y: kp.y} : null
      }).filter(Boolean)

      if (mapPoints.length < 18 || imagePoints.length !== mapPoints.length) return null

      const pnp = await solvePnPFromMapPoints(mapPoints, imagePoints, getCameraIntrinsics())
      if (!pnp.accepted || pnp.inliers < 18) return null

      const fakeRelocalization = {
        mode: 'self',
        keyframe: originKeyframe,
        cameraWorldMatrix: originKeyframe.cameraWorldMatrix,
        pnp,
      }
      fakeRelocalization.sessionMapMatrix = sessionMapMatrixFromRelocalization(fakeRelocalization)
      if (!fakeRelocalization.sessionMapMatrix) return null

      fakeRelocalization.restoredCount = getRestoredObjectPoses(fakeRelocalization).length
      state.lastRelocalization = fakeRelocalization
      emitRelocalized(fakeRelocalization)
      emitStatus(`Local Map ready: ${originKeyframe.label} / points ${state.map.points.length} / self-localized`)
      return fakeRelocalization
    } catch (_) {
      emitStatus(`Local Map ready: ${state.map.points.length} points`)
      return null
    }
  }

  const relocalize = async () => {
    if (state.keyframes.length === 0) {
      emitStatus('No keyframes yet')
      emitMethod('idle', 'IDLE')
      return {matches: []}
    }

    try {
      emitStatus('Running ORB matching...')
      emitMethod('idle', 'MATCHING')
      const matches = findTopMatches()
      const currentFeatures = await extractOrbFeatures(captureFeatureImageData())
      state.lastFeatures = currentFeatures

      for (const match of matches) {
        match.feature = await matchOrbFeatures(currentFeatures, match.keyframe.features, getCameraIntrinsics())
        const pnpInput = buildPnPInput(match.keyframe, match.feature)
        match.pnp = await solvePnPFromMapPoints(pnpInput.mapPoints, pnpInput.imagePoints, getCameraIntrinsics())
        match.pnp.inlierPointIds = (match.pnp.inlierIndices || [])
          .map((index) => pnpInput.pointIds[index])
          .filter((id) => id !== undefined)
      }

      const isActiveCandidate = (match) => (
        match.keyframe.id === state.activeKeyframe?.id
        && match.score > 0.68
        && match.feature.accepted
        && match.pnp.accepted
        && match.pnp.inliers >= MIN_RELOCALIZE_PNP_INLIERS
      )
      const isTopCandidate = (match) => (
        match.score > 0.72
        && match.feature.accepted
        && match.pnp.accepted
        && match.pnp.inliers >= MIN_RELOCALIZE_PNP_INLIERS
      )
      const candidates = matches.filter((m) => isActiveCandidate(m) || isTopCandidate(m))
      const accepted = candidates.sort((a, b) => (
        (a.pnp.reprojectionError?.inlierMean ?? 99) - (b.pnp.reprojectionError?.inlierMean ?? 99)
      ))[0] ?? null

      if (accepted) {
        state.activeKeyframe = accepted.keyframe
        state.referenceFeatures = accepted.keyframe.features
        const relocalization = createRelocalization(accepted)
        relocalization.sessionMapMatrix = sessionMapMatrixFromRelocalization(relocalization)
        relocalization.restoredCount = getRestoredObjectPoses(relocalization).length
        state.lastRelocalization = relocalization
        emitRelocalized(relocalization)
        emitDiagnostic('relocalize', {
          accepted: {
            keyframeId: accepted.keyframe.id,
            label: accepted.keyframe.label,
            score: accepted.score,
            feature: {
              goodMatches: accepted.feature?.goodMatches,
              homographyInliers: accepted.feature?.inliers,
              poseInliers: accepted.feature?.relativePose?.inliers,
            },
            pnp: {
              accepted: accepted.pnp?.accepted,
              inliers: accepted.pnp?.inliers,
              reprojectionError: accepted.pnp?.reprojectionError,
              rvec: accepted.pnp?.rvec,
              tvec: accepted.pnp?.tvec,
            },
          },
          cameraWorldMatrix: relocalization.cameraWorldMatrix,
          sessionMapMatrix: relocalization.sessionMapMatrix ? relocalization.sessionMapMatrix.toArray() : null,
          sessionMapDecomposed: decomposeMatrixForLog(relocalization.sessionMapMatrix),
          intrinsics: getCameraIntrinsics(),
          captureSize: getFeatureCaptureSize(),
          restoredCount: relocalization.restoredCount,
          thresholds: {
            minPnpInliers: MIN_RELOCALIZE_PNP_INLIERS,
            activeScore: 0.68,
            topScore: 0.72,
          },
          matches: matches.map((match) => ({
            keyframeId: match.keyframe.id,
            label: match.keyframe.label,
            score: match.score,
            goodMatches: match.feature?.goodMatches,
            homographyInliers: match.feature?.inliers,
            pnpInliers: match.pnp?.inliers,
            pnpAccepted: match.pnp?.accepted,
          })),
        })
        emitMethod('keyframe', '2D KEYFRAME PNP')
        emitStatus(`2D keyframe relocalized: ${accepted.keyframe.label} / restored ${relocalization.restoredCount} / pnp ${accepted.pnp?.inliers || 0}`)
        return {matches, relocalization}
      }

      if (state.map?.points?.length) {
        emitStatus('2D keyframe failed, trying 3D global map...')
        const globalMatches = (await matchGlobalMapDescriptors(currentFeatures, state.map.points))
          .filter((match) => match.distance < 58 && (match.mapPoint.observationCount || 0) >= 2)
          .sort((a, b) => (
            (b.mapPoint.observationCount || 0) - (a.mapPoint.observationCount || 0)
            || a.distance - b.distance
          ))
          .slice(0, 140)
        const intrinsics = getCameraIntrinsics()
        const initialGlobalPnp = globalMatches.length >= 6
          ? await solvePnPFromMapPoints(
            globalMatches.map((match) => match.mapPoint.position),
            globalMatches.map((match) => match.imagePoint),
            intrinsics
          )
          : {accepted: false, inliers: 0}
        const filteredGlobalMatches = filterMatchesByPnpInliers(
          globalMatches,
          initialGlobalPnp,
          MAX_GLOBAL_MAP_REPROJECTION_ERROR
        )
        const globalPnp = filteredGlobalMatches.length >= 6
          ? await solvePnPFromMapPoints(
            filteredGlobalMatches.map((match) => match.mapPoint.position),
            filteredGlobalMatches.map((match) => match.imagePoint),
            intrinsics
          )
          : {accepted: false, inliers: 0}
        const globalThresholds = getGlobalThresholds(state.map.points.length)
        const rejectReason = getGlobalPnpRejectReason(globalMatches, globalPnp, filteredGlobalMatches, globalThresholds)
        const currentCameraWorldMatrix = getCameraWorldMatrix()

        emitDiagnostic('relocalize-global-map', {
          accepted: !rejectReason,
          rejectReason,
          cameraWorldMatrix: currentCameraWorldMatrix,
          intrinsics,
          captureSize: getFeatureCaptureSize(),
          pnp: {
            accepted: globalPnp.accepted,
            inliers: globalPnp.inliers,
            reprojectionError: globalPnp.reprojectionError,
            rvec: globalPnp.rvec,
            tvec: globalPnp.tvec,
          },
          globalMatches: globalMatches.length,
          mapPoints: state.map.points.length,
          thresholds: {
            minGlobalMatches: globalThresholds.minMatches,
            minGlobalPnpInliers: globalThresholds.minPnpInliers,
            minGlobalMapInlierRatio: MIN_GLOBAL_MAP_INLIER_RATIO,
            maxGlobalMapReprojectionError: MAX_GLOBAL_MAP_REPROJECTION_ERROR,
            maxMapPointBucketSpread: MAX_MAP_POINT_BUCKET_SPREAD,
            maxSessionMapTranslationJump: MAX_SESSION_MAP_TRANSLATION_JUMP,
          },
          filteredGlobalMatches: filteredGlobalMatches.length,
        })

        if (!rejectReason) {
          const relocalization = {
            mode: 'global-map',
            keyframe: state.activeKeyframe || state.keyframes.at(-1),
            pnp: globalPnp,
            globalInlierPointIds: (globalPnp.inlierIndices || [])
              .map((index) => filteredGlobalMatches[index]?.mapPoint?.id)
              .filter(Boolean),
            cameraWorldMatrix: currentCameraWorldMatrix,
          }
          relocalization.sessionMapMatrix = sessionMapMatrixFromRelocalization(relocalization)
          const jumpRejectReason = getSessionMapJumpRejectReason(relocalization.sessionMapMatrix)
          if (jumpRejectReason) {
            emitDiagnostic('relocalize-global-map-rejected', {
              rejectReason: jumpRejectReason,
              sessionMapMatrix: relocalization.sessionMapMatrix?.toArray() ?? null,
            })
            emitMethod('rejected', '3D UNSTABLE')
            emitStatus(`Global map unstable: ${jumpRejectReason}`)
          } else {
            relocalization.restoredCount = getRestoredObjectPoses(relocalization).length
            state.lastRelocalization = relocalization
            emitRelocalized(relocalization)
            emitDiagnostic('relocalize-global-map-accepted', {
              cameraWorldMatrix: relocalization.cameraWorldMatrix,
              sessionMapMatrix: relocalization.sessionMapMatrix?.toArray() ?? null,
              sessionMapDecomposed: decomposeMatrixForLog(relocalization.sessionMapMatrix),
              restoredCount: relocalization.restoredCount,
            })
            emitMethod('map', '3D MAP PNP')
            emitStatus(`3D map relocalized / restored ${relocalization.restoredCount} / pnp ${globalPnp.inliers}`)
            return {matches, relocalization}
          }
        } else {
          emitMethod('rejected', '3D REJECTED')
          emitStatus(`Global map rejected: ${rejectReason}`)
        }
      }

      emitMethod('rejected', 'REJECTED')
      emitStatus('Failed stable PnP verification')
      return {matches}
    } catch (error) {
      emitMethod('rejected', 'ERROR')
      emitStatus('Feature matching failed, rescan a keyframe')
      return {matches: state.lastMatches, error}
    }
  }

  const buildDeferredGraphEdges = async () => {
    const total = state.keyframes.length
    let processed = 0
    let skipped = 0
    let totalEdges = 0
    let totalMapPoints = 0
    let firstError = null

    for (let i = 0; i < total; i += 1) {
      const keyframe = state.keyframes[i]
      if (keyframe.edgesBuilt || keyframe.neighbors?.length) {
        keyframe.edgesBuilt = true
        skipped += 1
        continue
      }
      try {
        await buildKeyframeGraphEdges(keyframe, state.keyframes.slice(0, i))
      } catch (err) {
        if (!firstError) firstError = err?.message || String(err)
      }
      keyframe.edgesBuilt = true
      totalEdges += keyframe.neighbors?.length || 0
      totalMapPoints += keyframe.mapPoints?.length || 0
      processed += 1
      await saveKeyframe(keyframe)
      if (i % 3 === 0) {
        emitStatus(`Building graph... (${i + 1}/${total})`)
        await nextFrame()
      }
    }

    const triAgg = {nan: 0, depth: 0, nearCap: 0, angle: 0, reproj: 0, added: 0, tried: 0}
    const depthAgg = {negative: 0, tooNear: 0, tooFar: 0}
    let firstTriSample = null
    for (const kf of state.keyframes) {
      for (const nb of kf.neighbors || []) {
        const t = nb.tri
        if (!t) continue
        triAgg.added += t.added || 0
        triAgg.tried += t.tried || 0
        if (t.rejected) {
          triAgg.nan += t.rejected.nan || 0
          triAgg.depth += t.rejected.depth || 0
          triAgg.nearCap += t.rejected.nearCap || 0
          triAgg.angle += t.rejected.angle || 0
          triAgg.reproj += t.rejected.reproj || 0
        }
        if (t.depthBreakdown) {
          depthAgg.negative += t.depthBreakdown.negative || 0
          depthAgg.tooNear += t.depthBreakdown.tooNear || 0
          depthAgg.tooFar += t.depthBreakdown.tooFar || 0
        }
        if (!firstTriSample && t.tried > 0) {
          firstTriSample = {
            baseline: t.baseline,
            rejected: t.rejected,
            added: t.added,
            depthSampleA: t.depthSampleA,
            depthSampleB: t.depthSampleB,
          }
        }
      }
    }

    emitDiagnostic('build-deferred-edges', {
      total,
      processed,
      skipped,
      totalEdges,
      totalMapPoints,
      firstError,
      triAgg,
      depthAgg,
      firstTriSample,
    })
  }

  const buildLocalMap = async () => {
    const originKeyframe = state.activeKeyframe || state.keyframes.at(0)

    if (!originKeyframe) {
      emitStatus('Scan a keyframe first')
      return null
    }

    if (state.continuousScan) stopContinuousScan()

    emitMethod('idle', 'BUILDING MAP')
    emitStatus(`Building 3D map... (${state.keyframes.length} keyframes)`)
    await nextFrame()

    try {
      await buildDeferredGraphEdges()
      emitStatus(`Triangulating map points... (${state.keyframes.length} keyframes)`)
      await nextFrame()
      state.map = createMapFromKeyframe(originKeyframe)
      state.mapBuiltInThisSession = true
      state.map.guideImage = originKeyframe.guideImage || null
      const globalMap = collectGlobalMapPoints()
      const localOriginOffset = calculateMapOriginOffset(globalMap.points)
      state.map.localOriginOffset = localOriginOffset
      state.map.points = normalizeMapPointsToOrigin(globalMap.points, localOriginOffset)
      state.map.pointStats = globalMap.stats
      emitKeyframesChanged({type: 'build-map', map: state.map})
      emitDiagnostic('build-local-map', {
        map: state.map,
        originKeyframe: {
          id: originKeyframe.id,
          label: originKeyframe.label,
          mapPoints: originKeyframe.mapPoints?.length || 0,
          globalMapPoints: state.map.points.length,
          localOriginOffset,
          pointStats: state.map.pointStats,
        },
        intrinsics: getCameraIntrinsics(),
        captureSize: getFeatureCaptureSize(),
        mapPointDepthStats: collectMapPointDepthStats(),
        triangulationStats: collectTriangulationStats(),
      })
      emitStatus(`Local Map ready: ${originKeyframe.label} / points ${state.map.points.length} / self-localizing...`)
      await autoSelfLocalize()
      return state.map
    } catch (error) {
      emitStatus(`Failed to build Map: ${error.message || error}`)
      emitDiagnostic('build-local-map-error', {message: String(error?.message || error)})
      return null
    }
  }

  const buildLocalMapPreview = () => {
    const originKeyframe = state.activeKeyframe || state.keyframes.at(0)
    if (!originKeyframe) return null

    state.map = createMapFromKeyframe(originKeyframe)
    const globalMap = collectGlobalMapPoints()
    const localOriginOffset = calculateMapOriginOffset(globalMap.points)
    state.map.localOriginOffset = localOriginOffset
    state.map.points = normalizeMapPointsToOrigin(globalMap.points, localOriginOffset)
    state.map.pointStats = globalMap.stats
    emitKeyframesChanged({type: 'live-map-preview', map: state.map})
    emitStatus(`Live map preview / points ${state.map.points.length}`)
    return state.map
  }

  // `metadata` is an optional shallow-merge seam for callers that want to attach
  // extra fields (e.g. custom chest content) onto the saved objectPose. It is
  // additive and backward-compatible: existing single-arg callers are unaffected.
  const placeObject = async (worldPoint, metadata = null) => {
    if (!state.map) {
      emitStatus('Build a Local Map first')
      return null
    }

    if (!worldPoint) return null
    const keyframe = state.activeKeyframe || state.keyframes.at(-1)
    const pose = positionToPlain(worldPoint)
    const objectPose = {
      id: `obj-${Date.now()}`,
      keyframeId: keyframe?.id || null,
      pose,
      groundY: pose.y,
      mapLocalPose: getMapLocalPose(pose),
      keyframeLocalPose: keyframe ? getKeyframeLocalPose(pose, keyframe) : null,
      relativePose: keyframe ? getCameraLocalPose(pose) : null,
      createdAt: new Date().toISOString(),
      ...(metadata || null),
    }

    await saveObjectPose(objectPose)
    state.objects.push(objectPose)
    emitObjectsChanged()

    const placedPos = new THREE.Vector3(pose.x, pose.y, pose.z)
    const camMatrix = getCameraWorldMatrix()
    const zDepth = getPointDepthInCamera(placedPos, camMatrix)
    emitDiagnostic('place-object', {objectPose, zDepth: Number(zDepth.toFixed(3))})
    emitStatus(`Object pose saved｜camera depth ${zDepth.toFixed(2)}m`)
    return objectPose
  }

  const loadPersisted = async () => {
    state.keyframes = await loadKeyframes()
    state.objects = await loadObjects()
    state.activeKeyframe = state.keyframes.at(-1) || null
    state.map = state.keyframes.find((keyframe) => keyframe.localMap)?.localMap || null
    state.mapBuiltInThisSession = false
    state.lastRelocalization = null
    emitKeyframesChanged({type: 'load-persisted'})
    emitObjectsChanged()
    return {keyframes: state.keyframes, objects: state.objects, map: state.map}
  }

  const persistActiveMap = async () => {
    if (!state.activeKeyframe || !state.map) return false
    state.activeKeyframe.localMap = state.map
    await saveKeyframe(state.activeKeyframe)
    return true
  }

  const buildBundle = (version) => buildShareBundle(state.keyframes, state.map, state.objects, version)

  const applyBundle = (raw, sourceLabel = 'bundle') => {
    const bundle = loadShareBundle(raw)
    state.keyframes = bundle.keyframes
    state.map = bundle.map
    state.objects = bundle.objects
    state.mapBuiltInThisSession = false
    state.activeKeyframe = state.keyframes.at(-1) || null
    state.lastRelocalization = null
    state.lastMatches = []
    state.lastFeatures = null
    state.referenceFeatures = null
    emitKeyframesChanged({type: 'apply-bundle', bundle})
    emitObjectsChanged()
    emitStatus(`Map loaded (${sourceLabel}) / ${state.keyframes.length} KF / ${state.map?.points?.length || 0} pts — press Relocalize`)
    return bundle
  }

  const clearObjects = async () => {
    await clearStoredObjects()
    state.objects = []
    emitObjectsChanged()
    emitDiagnostic('clear-objects')
    emitStatus('Placed objects cleared')
  }

  const clearAll = async () => {
    if (state.continuousScan) stopContinuousScan()
    await clearSpatialMemory()
    Object.assign(state, createInitialState())
    emitKeyframesChanged({type: 'clear-all'})
    emitObjectsChanged()
    emitMethod('idle', 'IDLE')
    emitStatus('Local spatial memory cleared')
  }

  return {
    loadPersisted,
    captureKeyframe,
    startContinuousScan,
    stopContinuousScan,
    buildLocalMap,
    autoSelfLocalize,
    relocalize,
    placeObject,
    buildBundle,
    applyBundle,
    clearObjects,
    clearAll,
    buildLocalMapPreview,
    persistActiveMap,
    getKeyframes: () => state.keyframes,
    getMap: () => state.map,
    getObjects: () => state.objects,
    getLastRelocalization: () => state.lastRelocalization,
    getLastFeatures: () => state.lastFeatures,
    getReferenceFeatures: () => state.referenceFeatures,
    isScanning: () => state.continuousScan,
    getWorldPoseFromMap,
    getMapLocalPose,
    poseFromObject,
    getCurrentMapSessionMatrix,
    getMapPointWorldPose,
  }
}
