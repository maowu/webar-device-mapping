const assert = require('node:assert/strict')
const path = require('node:path')

const artifactPath = path.join(__dirname, 'opencv-slim-candidate.js')

const requiredApi = [
  'Mat', 'matFromArray', 'matFromImageData', 'Size',
  'cvtColor', 'CLAHE', 'ORB', 'BFMatcher', 'KeyPointVector', 'DMatchVectorVector',
  'solvePnP', 'solvePnPRansac', 'Rodrigues', 'projectPoints',
  'findEssentialMat', 'recoverPose', 'findHomography',
  'COLOR_RGBA2GRAY', 'CV_8U', 'CV_32FC2', 'CV_32FC3', 'CV_64F',
  'NORM_HAMMING', 'RANSAC', 'SOLVEPNP_ITERATIVE',
]

const deleteAll = (...values) => values.forEach((value) => value?.delete?.())

const testOrb = (cv) => {
  const pixels = new Uint8ClampedArray(128 * 128 * 4)
  for (let y = 0; y < 128; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      const offset = (y * 128 + x) * 4
      const value = ((x >> 3) + (y >> 3)) % 2 ? 255 : 0
      pixels[offset] = value
      pixels[offset + 1] = value
      pixels[offset + 2] = value
      pixels[offset + 3] = 255
    }
  }

  const source = cv.matFromImageData({width: 128, height: 128, data: pixels})
  const gray = new cv.Mat()
  const mask = new cv.Mat()
  const keypoints = new cv.KeyPointVector()
  const descriptors = new cv.Mat()
  const orb = new cv.ORB(300, 1.2, 8, 31, 0, 2, 0, 31, 10)

  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY)
    orb.detectAndCompute(gray, mask, keypoints, descriptors)
    assert.ok(keypoints.size() > 0, 'ORB should detect features')
    assert.ok(descriptors.rows > 0, 'ORB should produce descriptors')
  } finally {
    deleteAll(source, gray, mask, keypoints, descriptors, orb)
  }
}

const testHomography = (cv) => {
  const source = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, 1, 0, 1, 1, 0, 1])
  const target = cv.matFromArray(4, 1, cv.CV_32FC2, [2, 3, 4, 3, 4, 5, 2, 5])
  const mask = new cv.Mat()
  let homography
  try {
    homography = cv.findHomography(source, target, cv.RANSAC, 4, mask)
    assert.equal(homography.rows, 3)
    assert.equal(homography.cols, 3)
  } finally {
    deleteAll(source, target, mask, homography)
  }
}

const testSolvePnP = (cv) => {
  const objectPoints = cv.matFromArray(6, 1, cv.CV_32FC3, [
    -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, -0.5, 0, 1, 0.5, 0, 1,
  ])
  const imagePoints = cv.matFromArray(6, 1, cv.CV_32FC2, [
    220, 140, 420, 140, 420, 340, 220, 340, 278.333, 240, 361.667, 240,
  ])
  const camera = cv.matFromArray(3, 3, cv.CV_64F, [500, 0, 320, 0, 500, 240, 0, 0, 1])
  const distCoeffs = cv.Mat.zeros(4, 1, cv.CV_64F)
  const rvec = new cv.Mat()
  const tvec = new cv.Mat()

  try {
    const solved = cv.solvePnP(
      objectPoints, imagePoints, camera, distCoeffs,
      rvec, tvec, false, cv.SOLVEPNP_ITERATIVE
    )
    assert.equal(solved, true)
    assert.equal(rvec.rows, 3)
    assert.equal(tvec.rows, 3)
    assert.ok(Math.abs(tvec.data64F[2] - 5) < 0.05, 'solvePnP should recover camera depth')
  } finally {
    deleteAll(objectPoints, imagePoints, camera, distCoeffs, rvec, tvec)
  }
}

const testRecoverPoseBinding = (cv) => {
  // This test targets the overload shape used by feature-matcher.js. Geometry
  // quality is covered by on-device tests; here we guard against Embind arity
  // regressions that previously made the function impossible to call.
  const points1 = cv.matFromArray(8, 1, cv.CV_32FC2, [
    300, 220, 360, 220, 300, 260, 360, 260,
    280, 200, 380, 200, 280, 280, 380, 280,
  ])
  const points2 = cv.matFromArray(8, 1, cv.CV_32FC2, [
    290, 220, 350, 220, 290, 260, 350, 260,
    270, 200, 370, 200, 270, 280, 370, 280,
  ])
  const camera = cv.matFromArray(3, 3, cv.CV_64F, [500, 0, 320, 0, 500, 240, 0, 0, 1])
  const essentialMask = new cv.Mat()
  const poseMask = new cv.Mat()
  const rotation = new cv.Mat()
  const translation = new cv.Mat()
  const distCoeffs = cv.Mat.zeros(4, 1, cv.CV_64F)
  let essential

  try {
    essential = cv.findEssentialMat(points1, points2, camera, cv.RANSAC, 0.999, 1, essentialMask)
    const inliers = cv.recoverPose(
      points1, points2,
      camera, distCoeffs,
      camera, distCoeffs,
      essential, rotation, translation,
      cv.RANSAC, 0.999, 1, poseMask
    )
    assert.equal(typeof inliers, 'number')
    assert.equal(rotation.rows, 3)
    assert.equal(rotation.cols, 3)
  } finally {
    deleteAll(
      points1, points2, camera, essentialMask, poseMask,
      rotation, translation, distCoeffs, essential
    )
  }
}

const main = async () => {
  const cv = await require(artifactPath)
  requiredApi.forEach((name) => assert.notEqual(cv[name], undefined, `missing cv.${name}`))
  testOrb(cv)
  testHomography(cv)
  testSolvePnP(cv)
  testRecoverPoseBinding(cv)
  console.log(`OpenCV slim smoke test passed (${requiredApi.length} APIs)`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
