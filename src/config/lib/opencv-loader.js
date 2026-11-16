// Keep the generated OpenCV artifact behind a dynamic import so landing and AR
// startup do not download/initialize WASM until feature matching is requested.
// The candidate is checked into the repository to make production builds
// reproducible and independent of @techstark/opencv-js release changes.

const waitForLegacyRuntime = (module) => new Promise((resolve, reject) => {
  module.onRuntimeInitialized = () => resolve(module)
  module.onAbort = (reason) => reject(new Error(`OpenCV initialization aborted: ${reason}`))
})

const resolveOpenCvExport = async (imported) => {
  // Webpack may expose a CommonJS/UMD value as either the namespace itself or
  // `default`. Current custom builds return a Promise; modularized Emscripten
  // builds can instead export an async factory function.
  let module = imported?.default || imported
  module = await Promise.resolve(module)

  if (typeof module === 'function' && !module.Mat) {
    module = await module()
  }

  if (module?.Mat) return module
  if (module && 'onRuntimeInitialized' in module) return waitForLegacyRuntime(module)

  throw new Error('Custom OpenCV loaded but did not expose the expected cv.Mat API')
}

export const loadCustomOpenCv = () => import(
  /* webpackChunkName: "opencv-slim" */
  '../../../scripts/opencv-slim-build/opencv-slim-candidate.js'
).then(resolveOpenCvExport)

