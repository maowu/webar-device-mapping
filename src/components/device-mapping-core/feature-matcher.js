import {loadCustomOpenCv} from '../../config/lib/opencv-loader.js'

const ORB_FEATURES = 900
const ORB_GRID_COLS = 4
const ORB_GRID_ROWS = 3
const ORB_MIN_SELECTED_FEATURES = 520
const MIN_GOOD_MATCHES = 12
const MIN_HOMOGRAPHY_INLIERS = 8
const RATIO_TEST = 0.78

// FAST corner threshold for ORB. OpenCV's default is 20; lowered to 10 so
// weakly-textured / low-contrast targets (a uniform red torii, painted walls)
// still yield corners at their edges and subtle surface variation. Lower =
// more (but less repeatable) features; raise back toward 20 if matching gets
// noisy on rich-texture scenes.
const ORB_FAST_THRESHOLD = 10
// CLAHE (contrast-limited adaptive histogram equalization) pre-pass boosts
// local contrast before ORB, surfacing faint texture (wood grain, weathering,
// paint unevenness) that default ORB misses on uniform surfaces. Set to 0 to
// disable. tileGridSize is fixed at 8x8.
const CLAHE_CLIP_LIMIT = 2.5

let cvPromise = null

// The custom OpenCV build only starts downloading the first time a caller needs
// it (e.g. user taps Scan). Unlike the previous @techstark build, the async
// payload is also trimmed to the APIs used by this file.
const getCv = async () => {
  if (!cvPromise) {
    cvPromise = loadCustomOpenCv().catch((error) => {
      // Don't cache a failed load (e.g. a flaky mobile network dropping the
      // chunk), otherwise every future call reuses the rejected promise.
      cvPromise = null
      throw error
    })
  }

  return cvPromise
}

const keypointsToPlain = (keypoints) => {
  const points = []

  for (let i = 0; i < keypoints.size(); i += 1) {
    const keypoint = keypoints.get(i)
    const point = keypoint.pt
    points.push({
      x: Number(point.x.toFixed(2)),
      y: Number(point.y.toFixed(2)),
      response: Number((keypoint.response || 0).toFixed(4)),
      angle: Number((keypoint.angle || 0).toFixed(2)),
      octave: keypoint.octave || 0,
    })
  }

  return points
}

const selectDistributedKeypointIndices = (keypoints, imageWidth, imageHeight) => {
  const cellWidth = Math.max(1, imageWidth / ORB_GRID_COLS)
  const cellHeight = Math.max(1, imageHeight / ORB_GRID_ROWS)
  const maxPerCell = Math.ceil(ORB_FEATURES / (ORB_GRID_COLS * ORB_GRID_ROWS))
  const cells = new Map()

  keypoints.forEach((point, index) => {
    const col = Math.min(ORB_GRID_COLS - 1, Math.max(0, Math.floor(point.x / cellWidth)))
    const row = Math.min(ORB_GRID_ROWS - 1, Math.max(0, Math.floor(point.y / cellHeight)))
    const key = `${col}:${row}`
    const cell = cells.get(key) || []
    cell.push({index, response: point.response || 0})
    cells.set(key, cell)
  })

  return Array.from(cells.values())
    .flatMap((cell) => cell
      .sort((a, b) => b.response - a.response)
      .slice(0, maxPerCell)
      .map((item) => item.index))
    .slice(0, ORB_FEATURES)
}

const selectOrbKeypointIndices = (keypoints, imageWidth, imageHeight) => {
  const distributed = selectDistributedKeypointIndices(keypoints, imageWidth, imageHeight)
  if (distributed.length >= ORB_MIN_SELECTED_FEATURES) return distributed

  const selected = new Set(distributed)
  keypoints
    .map((point, index) => ({index, response: point.response || 0}))
    .sort((a, b) => b.response - a.response)
    .forEach((item) => {
      if (selected.size < ORB_MIN_SELECTED_FEATURES) selected.add(item.index)
    })

  return Array.from(selected).slice(0, ORB_FEATURES)
}

const descriptorsToPlain = (descriptors, indices = null) => {
  const cols = descriptors.cols
  const data = Array.from(descriptors.data)
  const rows = indices
    ? indices.flatMap((index) => data.slice(index * cols, index * cols + cols))
    : data

  return {
  rows: indices ? indices.length : descriptors.rows,
  cols: descriptors.cols,
  type: descriptors.type(),
  data: rows,
  }
}

export const descriptorAt = (features, index) => {
  const cols = features?.descriptors?.cols
  const data = features?.descriptors?.data
  if (!cols || !data || index < 0) return null

  const start = index * cols
  return data.slice(start, start + cols)
}

const descriptorsFromPlain = (cv, descriptors) => {
  if (!descriptors?.rows || !descriptors?.cols || !descriptors?.data?.length) {
    return null
  }

  return cv.matFromArray(descriptors.rows, descriptors.cols, descriptors.type, descriptors.data)
}

const descriptorsFromRows = (cv, rows) => {
  if (!rows?.length) return null

  return cv.matFromArray(rows.length, rows[0].length, cv.CV_8U, rows.flat())
}

const pointsToMat = (cv, points) => cv.matFromArray(points.length, 1, cv.CV_32FC2, points.flatMap((point) => [
  point.x,
  point.y,
]))

// Ray-based triangulation: finds the midpoint of the common perpendicular between two camera rays.
// Avoids DLT numerical instability when camera translation is large.
// camW: flat 16-element column-major cameraWorldMatrix (THREE.js convention, camera looks along -Z, Y up)
// intrinsics: {fx, fy, cx, cy}
// Projection convention from projectPointToImage: u = cx + fx*(Xc/-Zc), v = cy - fy*(Yc/-Zc)
// So unprojection: lx=(u-cx)/fx, ly=(cy-v)/fy, local dir=[lx,ly,-1] (Zc=-1 for +depth)
const triangulate1Ray = (camWA, camWB, intrinsics, u1, v1, u2, v2) => {
  const {fx, fy, cx, cy} = intrinsics
  // Camera centres in world space (column 3, col-major: indices 12,13,14)
  const pAx = camWA[12], pAy = camWA[13], pAz = camWA[14]
  const pBx = camWB[12], pBy = camWB[13], pBz = camWB[14]

  // Unproject pixel to local camera direction, then rotate to world space
  // col-major element [col*4+row], rotation part cols 0-2
  const toWorld = (cam, lx, ly) => {
    // local dir = [lx, ly, -1]
    const wx = cam[0] * lx + cam[4] * ly - cam[8]
    const wy = cam[1] * lx + cam[5] * ly - cam[9]
    const wz = cam[2] * lx + cam[6] * ly - cam[10]
    const len = Math.sqrt(wx * wx + wy * wy + wz * wz)
    if (len < 1e-12) return null
    return [wx / len, wy / len, wz / len]
  }

  const dA = toWorld(camWA, (u1 - cx) / fx, (cy - v1) / fy)
  const dB = toWorld(camWB, (u2 - cx) / fx, (cy - v2) / fy)
  if (!dA || !dB) return null

  // Closest-point-between-rays: minimise ||(pA+s*dA)-(pB+t*dB)||²
  const wx = pAx - pBx, wy = pAy - pBy, wz = pAz - pBz
  const b = dA[0] * dB[0] + dA[1] * dB[1] + dA[2] * dB[2] // dA·dB (dA,dB are unit)
  const d = dA[0] * wx + dA[1] * wy + dA[2] * wz
  const e = dB[0] * wx + dB[1] * wy + dB[2] * wz
  const denom = 1 - b * b // a=c=1 for unit vectors
  if (Math.abs(denom) < 1e-10) return null // parallel rays
  const s = (b * e - d) / denom
  const t = (e - b * d) / denom

  return {
    x: ((pAx + s * dA[0]) + (pBx + t * dB[0])) * 0.5,
    y: ((pAy + s * dA[1]) + (pBy + t * dB[1])) * 0.5,
    z: ((pAz + s * dA[2]) + (pBz + t * dB[2])) * 0.5,
  }
}

export const triangulatePointsRay = (camWA, camWB, intrinsics, pointsA, pointsB) => {
  if (!pointsA?.length || pointsA.length !== pointsB?.length) return []
  return pointsA.map((ptA, i) => {
    const ptB = pointsB[i]
    return triangulate1Ray(camWA, camWB, intrinsics, ptA.x, ptA.y, ptB.x, ptB.y)
  })
}

const DEFAULT_INTRINSICS = {fx: 288, fy: 288, cx: 160, cy: 120}

const createCameraMatrix = (cv, intrinsics = DEFAULT_INTRINSICS) => cv.matFromArray(3, 3, cv.CV_64F, [
  intrinsics.fx, 0, intrinsics.cx,
  0, intrinsics.fy, intrinsics.cy,
  0, 0, 1,
])

const createDistCoeffs = (cv) => cv.Mat.zeros(4, 1, cv.CV_64F)

const homographyToPlain = (homography) => {
  if (!homography || homography.empty()) return null

  return Array.from(homography.data64F || homography.data32F || [])
}

const getFeatureImageSize = (...features) => {
  const imageSize = features.find((feature) => feature?.imageSize)?.imageSize
  if (imageSize?.width && imageSize?.height) return imageSize

  const keypoints = features.flatMap((feature) => feature?.keypoints || [])
  const maxX = keypoints.reduce((max, point) => Math.max(max, point.x || 0), 1)
  const maxY = keypoints.reduce((max, point) => Math.max(max, point.y || 0), 1)
  return {width: maxX + 1, height: maxY + 1}
}

const estimatePoseCorrection = (homography, imageSize) => {
  if (!homography || homography.length < 9) {
    return {yaw: 0, x: 0, z: 0}
  }

  const angle = Math.atan2(homography[3], homography[0])
  const tx = Math.max(-1, Math.min(1, homography[2] / imageSize.width))
  const ty = Math.max(-1, Math.min(1, homography[5] / imageSize.height))

  return {
    yaw: Number((-angle).toFixed(4)),
    x: Number((-tx * 0.75).toFixed(4)),
    z: Number((ty * 0.75).toFixed(4)),
  }
}

const matToArray = (mat) => Array.from(mat.data64F || mat.data32F || [])

const rodriguesToMatrix = (cv, rvec) => {
  const rotation = new cv.Mat()

  try {
    cv.Rodrigues(rvec, rotation)
    return matToArray(rotation)
  } finally {
    rotation.delete()
  }
}

const matRowsToArray = (mat) => {
  const data = mat.data32S || mat.data
  return data ? Array.from(data) : []
}

const calculateReprojectionError = (cv, objectPoints, imagePoints, rvec, tvec, cameraMatrix, distCoeffs, inlierIndices) => {
  const projected = new cv.Mat()

  try {
    cv.projectPoints(objectPoints, rvec, tvec, cameraMatrix, distCoeffs, projected)
    const projectedData = projected.data32F || projected.data64F || []
    const inlierSet = new Set(inlierIndices)
    const pointErrors = []
    let totalError = 0
    let inlierError = 0
    let maxError = 0
    let inlierCount = 0

    imagePoints.forEach((point, index) => {
      const dx = projectedData[index * 2] - point.x
      const dy = projectedData[index * 2 + 1] - point.y
      const error = Math.sqrt(dx * dx + dy * dy)
      totalError += error
      maxError = Math.max(maxError, error)
      pointErrors.push(Number(error.toFixed(3)))

      if (inlierSet.has(index)) {
        inlierError += error
        inlierCount += 1
      }
    })

    return {
      mean: Number((totalError / imagePoints.length).toFixed(3)),
      inlierMean: Number((inlierCount ? inlierError / inlierCount : 0).toFixed(3)),
      max: Number(maxError.toFixed(3)),
      pointErrors,
    }
  } finally {
    projected.delete()
  }
}

const estimateRelativePose = (cv, srcMat, dstMat, intrinsics) => {
  const cameraMatrix = createCameraMatrix(cv, intrinsics)
  const essentialMask = new cv.Mat()
  const poseMask = new cv.Mat()
  const rotation = new cv.Mat()
  const translation = new cv.Mat()
  let essential = null
  let distCoeffs = null

  try {
    essential = cv.findEssentialMat(srcMat, dstMat, cameraMatrix, cv.RANSAC, 0.999, 1, essentialMask)
    if (!essential || essential.empty()) {
      return null
    }

    if (typeof cv.recoverPose !== 'function') {
      return null
    }

    let poseInliers
    try {
      // Signature exposed by the former full @techstark build.
      poseInliers = cv.recoverPose(
        essential, srcMat, dstMat, cameraMatrix, rotation, translation, poseMask
      )
    } catch {
      // The slim binding selects the stereo-camera overload instead of the
      // E-first overload. It estimates E and pose together; both cameras use
      // the same intrinsics and zero distortion in our current model.
      distCoeffs = createDistCoeffs(cv)
      poseInliers = cv.recoverPose(
        srcMat, dstMat,
        cameraMatrix, distCoeffs,
        cameraMatrix, distCoeffs,
        essential, rotation, translation,
        cv.RANSAC, 0.999, 1, poseMask
      )
    }
    return {
      inliers: poseInliers,
      rotation: matToArray(rotation),
      translation: matToArray(translation),
    }
  } catch (error) {
    return null
  } finally {
    cameraMatrix.delete()
    essentialMask.delete()
    poseMask.delete()
    rotation.delete()
    translation.delete()
    essential?.delete()
    distCoeffs?.delete()
  }
}

// Apply a CLAHE contrast pre-pass in place on a grayscale Mat. No-op (and
// safe) if disabled or if this OpenCV build lacks CLAHE; failures fall back to
// the un-equalized image rather than breaking feature extraction.
const applyClahe = (cv, gray) => {
  if (!CLAHE_CLIP_LIMIT) return
  let clahe = null
  let tileSize = null
  try {
    tileSize = new cv.Size(8, 8)
    clahe = typeof cv.createCLAHE === 'function'
      ? cv.createCLAHE(CLAHE_CLIP_LIMIT, tileSize)
      : new cv.CLAHE(CLAHE_CLIP_LIMIT, tileSize)
    clahe.apply(gray, gray)
  } catch {
    // CLAHE unavailable in this build — proceed with the plain grayscale.
  } finally {
    clahe?.delete?.()
    tileSize?.delete?.()
  }
}

export const extractOrbFeatures = async (imageData) => {
  const cv = await getCv()
  const source = cv.matFromImageData(imageData)
  const gray = new cv.Mat()
  const mask = new cv.Mat()
  const keypoints = new cv.KeyPointVector()
  const descriptors = new cv.Mat()
  // Full ORB constructor so the FAST threshold can be lowered; the other args
  // are OpenCV's defaults (scaleFactor 1.2, nlevels 8, edgeThreshold 31,
  // firstLevel 0, WTA_K 2, HARRIS score, patchSize 31). scoreType uses the
  // numeric literal 0 (== HARRIS_SCORE) rather than cv.ORB_HARRIS_SCORE, which
  // isn't reliably exposed as a constant in this OpenCV.js build — passing
  // undefined there would throw and break all feature extraction.
  const orb = new cv.ORB(ORB_FEATURES, 1.2, 8, 31, 0, 2, 0, 31, ORB_FAST_THRESHOLD)

  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY)
    applyClahe(cv, gray)
    orb.detectAndCompute(gray, mask, keypoints, descriptors)
    const plainKeypoints = keypointsToPlain(keypoints)
    const selectedIndices = selectOrbKeypointIndices(plainKeypoints, imageData.width, imageData.height)

    return {
      imageSize: {
        width: imageData.width,
        height: imageData.height,
      },
      keypoints: selectedIndices.map((index) => plainKeypoints[index]),
      descriptors: descriptorsToPlain(descriptors, selectedIndices),
      distribution: {
        rawKeypoints: plainKeypoints.length,
        selectedKeypoints: selectedIndices.length,
        grid: `${ORB_GRID_COLS}x${ORB_GRID_ROWS}`,
      },
    }
  } finally {
    source.delete()
    gray.delete()
    mask.delete()
    keypoints.delete()
    descriptors.delete()
    orb.delete()
  }
}

export const matchOrbFeatures = async (currentFeatures, keyframeFeatures, intrinsics) => {
  const cv = await getCv()
  const currentDescriptors = descriptorsFromPlain(cv, currentFeatures?.descriptors)
  const keyframeDescriptors = descriptorsFromPlain(cv, keyframeFeatures?.descriptors)

  if (!currentDescriptors || !keyframeDescriptors) {
    currentDescriptors?.delete()
    keyframeDescriptors?.delete()
    return {goodMatches: 0, inliers: 0, accepted: false}
  }

  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false)
  const knnMatches = new cv.DMatchVectorVector()
  const srcPoints = []
  const dstPoints = []
  const goodMatches = []

  try {
    matcher.knnMatch(currentDescriptors, keyframeDescriptors, knnMatches, 2)

    for (let i = 0; i < knnMatches.size(); i += 1) {
      const pair = knnMatches.get(i)
      if (pair.size() < 2) continue

      const best = pair.get(0)
      const second = pair.get(1)

      if (best.distance < second.distance * RATIO_TEST) {
        const currentPoint = currentFeatures.keypoints[best.queryIdx]
        const keyframePoint = keyframeFeatures.keypoints[best.trainIdx]
        srcPoints.push(currentFeatures.keypoints[best.queryIdx])
        dstPoints.push(keyframeFeatures.keypoints[best.trainIdx])
        goodMatches.push({
          queryIdx: best.queryIdx,
          trainIdx: best.trainIdx,
          distance: Number(best.distance.toFixed(2)),
          currentPoint,
          keyframePoint,
        })
      }
    }

    if (srcPoints.length < MIN_GOOD_MATCHES) {
      return {goodMatches: srcPoints.length, inliers: 0, matches: goodMatches, accepted: false}
    }

    const srcMat = pointsToMat(cv, srcPoints)
    const dstMat = pointsToMat(cv, dstPoints)
    const mask = new cv.Mat()

    try {
      const homography = cv.findHomography(srcMat, dstMat, cv.RANSAC, 4, mask)
      const plainHomography = homographyToPlain(homography)
      const inliers = mask.data.reduce((sum, value) => sum + (value ? 1 : 0), 0)
      const relativePose = estimateRelativePose(cv, srcMat, dstMat, intrinsics)
      const imageSize = getFeatureImageSize(keyframeFeatures, currentFeatures)

      homography.delete()
      return {
        goodMatches: srcPoints.length,
        inliers,
        homography: plainHomography,
        correction: estimatePoseCorrection(plainHomography, imageSize),
        relativePose,
        matches: goodMatches,
        accepted: inliers >= MIN_HOMOGRAPHY_INLIERS,
      }
    } finally {
      srcMat.delete()
      dstMat.delete()
      mask.delete()
    }
  } finally {
    currentDescriptors.delete()
    keyframeDescriptors.delete()
    matcher.delete()
    knnMatches.delete()
  }
}

export const solvePnPFromMapPoints = async (mapPoints, imagePoints, intrinsics) => {
  if (!mapPoints?.length || mapPoints.length < 6 || mapPoints.length !== imagePoints.length) {
    return {accepted: false, inliers: 0}
  }

  const cv = await getCv()
  const objectPoints = cv.matFromArray(mapPoints.length, 1, cv.CV_32FC3, mapPoints.flatMap((point) => [
    point.x,
    point.y,
    point.z,
  ]))
  const imagePointMat = pointsToMat(cv, imagePoints)
  const cameraMatrix = createCameraMatrix(cv, intrinsics)
  const distCoeffs = createDistCoeffs(cv)
  const rvec = new cv.Mat()
  const tvec = new cv.Mat()
  const inliers = new cv.Mat()

  let inlierObjPoints = null
  let inlierImgPoints = null

  try {
    const solved = cv.solvePnPRansac(
      objectPoints,
      imagePointMat,
      cameraMatrix,
      distCoeffs,
      rvec,
      tvec,
      false,
      300,
      6,
      0.99,
      inliers,
      cv.SOLVEPNP_ITERATIVE
    )

    const inlierIndices = matRowsToArray(inliers)

    // Refine with deterministic solve on inliers only — reduces yaw jitter vs raw RANSAC
    if (inlierIndices.length >= 8) {
      try {
        const inlierMapPts = inlierIndices.map((i) => mapPoints[i])
        const inlierImgPts = inlierIndices.map((i) => imagePoints[i])
        inlierObjPoints = cv.matFromArray(inlierMapPts.length, 1, cv.CV_32FC3,
          inlierMapPts.flatMap((p) => [p.x, p.y, p.z]))
        inlierImgPoints = pointsToMat(cv, inlierImgPts)
        cv.solvePnP(inlierObjPoints, inlierImgPoints, cameraMatrix, distCoeffs,
          rvec, tvec, true, cv.SOLVEPNP_ITERATIVE)
      } catch (_) {
        // fall through — keep RANSAC result
      }
    }

    const reprojectionError = calculateReprojectionError(
      cv,
      objectPoints,
      imagePoints,
      rvec,
      tvec,
      cameraMatrix,
      distCoeffs,
      inlierIndices
    )

    return {
      accepted: Boolean(solved) && inliers.rows >= 8,
      inliers: inliers.rows || 0,
      inlierIndices,
      reprojectionError,
      rotation: rodriguesToMatrix(cv, rvec),
      rvec: matToArray(rvec),
      tvec: matToArray(tvec),
    }
  } catch (error) {
    return {accepted: false, inliers: 0}
  } finally {
    inlierObjPoints?.delete()
    inlierImgPoints?.delete()
    objectPoints.delete()
    imagePointMat.delete()
    cameraMatrix.delete()
    distCoeffs.delete()
    rvec.delete()
    tvec.delete()
    inliers.delete()
  }
}

export const matchGlobalMapDescriptors = async (currentFeatures, mapPoints) => {
  const descriptorRows = []
  const validPoints = []

  for (const point of mapPoints || []) {
    if (!point.descriptor?.length) continue
    descriptorRows.push(point.descriptor)
    validPoints.push(point)
  }

  if (!descriptorRows.length) return []

  const cv = await getCv()
  const currentDescriptors = descriptorsFromPlain(cv, currentFeatures?.descriptors)
  const mapDescriptors = descriptorsFromRows(cv, descriptorRows)
  if (!currentDescriptors || !mapDescriptors) {
    currentDescriptors?.delete()
    mapDescriptors?.delete()
    return []
  }

  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false)
  const knnMatches = new cv.DMatchVectorVector()
  const matches = []

  try {
    matcher.knnMatch(currentDescriptors, mapDescriptors, knnMatches, 2)

    for (let i = 0; i < knnMatches.size(); i += 1) {
      const pair = knnMatches.get(i)
      if (pair.size() < 2) continue

      const best = pair.get(0)
      const second = pair.get(1)
      if (best.distance >= second.distance * RATIO_TEST) continue

      matches.push({
        mapPoint: validPoints[best.trainIdx],
        imagePoint: currentFeatures.keypoints[best.queryIdx],
        queryIdx: best.queryIdx,
        distance: Number(best.distance.toFixed(2)),
      })
    }

    return matches
  } finally {
    currentDescriptors.delete()
    mapDescriptors.delete()
    matcher.delete()
    knnMatches.delete()
  }
}
