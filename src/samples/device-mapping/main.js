import '../../shared/base.css'
import './style.css'
import sceneHtml from './scene.html'
import {appendDiagnostic, exportDiagnostics, resetDiagnostics} from './diagnostics.js'
import {createMappingEngine} from '../../components/device-mapping-core/engine.js'
import {getFeatureCaptureSize} from '../../components/device-mapping-core/vision.js'
import {
  downloadMapBundle,
  exportMapBundleAsFile,
  shareMapBundle,
} from '../../components/device-mapping-core/share.js'

const VERSION = 'v4.9.31'

const uiState = {
  placementArmed: false,
  mapOverlayEnabled: false,
  liveMapOverlayEnabled: false,
  featureOverlayEnabled: false,
}

let engine = null

const setStatus = (message = '') => {
  document.getElementById('dm-status').textContent = message
}

const getCameraObject3D = () => {
  const cameraEl = document.getElementById('camera')
  const root = cameraEl?.object3D || null
  if (root) root.userData.projectionCamera = cameraEl.getObject3D('camera')
  return root
}

// Copy text to the clipboard, falling back to a hidden textarea + execCommand
// for browsers/contexts where navigator.clipboard is unavailable.
const copyTextToClipboard = async (text) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the legacy fallback below.
    }
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    return true
  } catch {
    return false
  }
}

// Lightweight confirm dialog styled to match the panel.
const showConfirmModal = ({title, sub, confirmLabel = 'Confirm', cancelLabel = 'Cancel'}) => new Promise((resolve) => {
  const backdrop = document.getElementById('dm-modal-backdrop')
  document.getElementById('dm-modal-title').textContent = title
  document.getElementById('dm-modal-sub').textContent = sub || ''
  const confirmBtn = document.getElementById('dm-modal-confirm')
  const cancelBtn = document.getElementById('dm-modal-cancel')
  confirmBtn.textContent = confirmLabel
  cancelBtn.textContent = cancelLabel

  const close = (result) => {
    backdrop.hidden = true
    confirmBtn.removeEventListener('click', onConfirm)
    cancelBtn.removeEventListener('click', onCancel)
    backdrop.removeEventListener('click', onBackdrop)
    resolve(result)
  }
  const onConfirm = () => close(true)
  const onCancel = () => close(false)
  const onBackdrop = (event) => { if (event.target === backdrop) close(false) }

  confirmBtn.addEventListener('click', onConfirm)
  cancelBtn.addEventListener('click', onCancel)
  backdrop.addEventListener('click', onBackdrop)
  backdrop.hidden = false
})

const showAlignGuide = () => {
  const guideImage = engine?.getMap()?.guideImage
  if (!guideImage) return
  document.getElementById('dm-align-guide-img').src = guideImage
  document.getElementById('dm-align-guide').hidden = false
}

const hideAlignGuide = () => {
  document.getElementById('dm-align-guide').hidden = true
}

const setRelocalizeMethod = (method, label) => {
  const element = document.getElementById('dm-method')
  if (!element) return

  element.innerHTML = `<span class="dm-method-dot"></span>${label}`
  element.className = `dm-method dm-method-${method}`
}

// Progressive disclosure: tag the panel with the current flow stage so CSS can
// hide actions that aren't usable yet (Place/Relocalize/Generate-code only make
// sense once a map exists). Keeps an idle master panel down to Scan + More
// instead of showing every control at once.
const refreshUiStage = () => {
  const panel = document.getElementById('dm-panel')
  if (!panel) return
  panel.classList.toggle('has-map', !!engine?.getMap())
  panel.classList.toggle('has-keyframes', (engine?.getKeyframes().length || 0) > 0)
  panel.classList.toggle('is-scanning', !!engine?.isScanning())
}

const updateCount = () => {
  const mapText = engine?.getMap() ? ' / map ready' : ' / no map'
  document.getElementById('dm-count').textContent = `${engine?.getKeyframes().length || 0} keyframes${mapText}`
  document.getElementById('dm-eyebrow').textContent = `DEVICE MAP ${VERSION}`
  refreshUiStage()
}

const setResults = (matches = []) => {
  const results = document.getElementById('dm-results')
  results.innerHTML = ''

  matches.forEach((match, index) => {
    const row = document.createElement('div')
    const featureText = match.feature
      ? ` / matches ${match.feature.goodMatches} / H ${match.feature.inliers} / P ${match.feature.relativePose?.inliers || 0} / PnP ${match.pnp?.inliers || 0}`
      : ''
    row.textContent = `Top ${index + 1}: ${match.keyframe.label} / score ${match.score.toFixed(3)}${featureText}`
    results.appendChild(row)
  })
}

const drawFeaturePoints = (context, features, color, radius) => {
  if (!features?.keypoints?.length) return

  const {width, height} = getFeatureCaptureSize()
  context.fillStyle = color
  context.strokeStyle = 'rgba(7, 17, 12, 0.9)'
  context.lineWidth = 1

  features.keypoints.forEach((point) => {
    const x = (point.x / width) * window.innerWidth
    const y = (point.y / height) * window.innerHeight
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
    context.stroke()
  })
}

const drawFeatureOverlay = () => {
  const canvas = document.getElementById('dm-feature-overlay')
  if (!canvas) return

  const context = canvas.getContext('2d')
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.round(window.innerWidth * ratio)
  canvas.height = Math.round(window.innerHeight * ratio)
  context.scale(ratio, ratio)
  context.clearRect(0, 0, window.innerWidth, window.innerHeight)

  if (!uiState.featureOverlayEnabled) return

  drawFeaturePoints(context, engine.getReferenceFeatures(), 'rgba(251, 191, 36, 0.82)', 3.2)
  drawFeaturePoints(context, engine.getLastFeatures(), 'rgba(134, 239, 172, 0.94)', 2.2)
}

const clearMapDebug = () => {
  const root = document.getElementById('map-debug-root')
  if (!root) return

  root.innerHTML = ''
  while (root.object3D.children.length > 0) {
    const child = root.object3D.children[0]
    root.object3D.remove(child)
    child.geometry?.dispose?.()
    child.material?.dispose?.()
  }
}

const drawMapPoint = (pose, color, size = 0.035) => {
  const root = document.getElementById('map-debug-root')
  if (!root) return

  const point = document.createElement('a-sphere')
  point.setAttribute('radius', size)
  point.setAttribute('color', color)
  point.setAttribute('position', `${pose.x} ${pose.y} ${pose.z}`)
  root.appendChild(point)
}

const drawMapPointCloud = (poses, color, size, colors = null) => {
  const root = document.getElementById('map-debug-root')
  if (!root || !poses.length) return

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(
    poses.flatMap((pose) => [pose.x, pose.y, pose.z]),
    3
  ))

  if (colors?.length === poses.length) {
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(
      colors.flatMap((c) => [c.r, c.g, c.b]),
      3
    ))
  }

  const material = new THREE.PointsMaterial({
    color: colors ? 0xffffff : color,
    vertexColors: Boolean(colors),
    size,
    sizeAttenuation: true,
    depthWrite: false,
  })

  root.object3D.add(new THREE.Points(geometry, material))
}

// Sample per-keypoint RGB colors from the stored 32x32 keyframe thumbnail.
const sampleKeypointColorsFromImage = (image, keypoints, featureWidth, featureHeight) => new Promise((resolve) => {
  const img = new Image()
  img.onload = () => {
    const thumb = 32
    const canvas = document.createElement('canvas')
    canvas.width = thumb
    canvas.height = thumb
    const ctx = canvas.getContext('2d', {willReadFrequently: true})
    ctx.drawImage(img, 0, 0, thumb, thumb)
    const pixels = ctx.getImageData(0, 0, thumb, thumb).data

    const colors = keypoints.map((kp) => {
      const tx = Math.min(thumb - 1, Math.floor(kp.x / featureWidth * thumb))
      const ty = Math.min(thumb - 1, Math.floor(kp.y / featureHeight * thumb))
      const idx = (ty * thumb + tx) * 4
      return {r: pixels[idx] / 255, g: pixels[idx + 1] / 255, b: pixels[idx + 2] / 255}
    })
    resolve(colors)
  }
  img.onerror = () => resolve(null)
  img.src = image
})

const buildColoredMapPointCloud = async (sessionMapMatrix) => {
  const map = engine.getMap()
  if (!map?.points?.length) return

  const {width: fw, height: fh} = getFeatureCaptureSize()
  const colorByKfAndKp = new Map()
  const kpIndicesByKfId = new Map()

  for (const mp of map.points) {
    for (const obs of mp.observations || []) {
      if (!kpIndicesByKfId.has(obs.keyframeId)) kpIndicesByKfId.set(obs.keyframeId, new Set())
      kpIndicesByKfId.get(obs.keyframeId).add(obs.keypointIndex)
    }
  }

  await Promise.all(
    engine.getKeyframes()
      .filter((kf) => kf.image && kf.features?.keypoints?.length && kpIndicesByKfId.has(kf.id))
      .map(async (kf) => {
        const kpIndices = [...kpIndicesByKfId.get(kf.id)]
        const keypoints = kpIndices.map((idx) => kf.features.keypoints[idx]).filter(Boolean)
        const colors = await sampleKeypointColorsFromImage(kf.image, keypoints, fw, fh)
        if (!colors) return
        const byKp = new Map()
        kpIndices.forEach((idx, i) => { if (colors[i]) byKp.set(idx, colors[i]) })
        colorByKfAndKp.set(kf.id, byKp)
      })
  )

  const poses = []
  const colors = []

  for (const mapPoint of map.points) {
    const pose = engine.getWorldPoseFromMap(mapPoint.position, sessionMapMatrix)
    if (!pose) continue
    let color = {r: 0.4, g: 0.4, b: 0.4}
    for (const obs of mapPoint.observations || []) {
      const c = colorByKfAndKp.get(obs.keyframeId)?.get(obs.keypointIndex)
      if (c) {
        color = c
        break
      }
    }
    poses.push(pose)
    colors.push(color)
  }

  drawMapPointCloud(poses, null, 0.05, colors)
}

const drawMapOrigin = (sessionMapMatrix) => {
  const root = document.getElementById('map-debug-root')
  if (!root || !sessionMapMatrix) return

  const position = new THREE.Vector3(0, 0, 0).applyMatrix4(sessionMapMatrix)
  const origin = document.createElement('a-entity')
  origin.setAttribute('position', `${position.x} ${position.y} ${position.z}`)
  origin.innerHTML = `
    <a-sphere radius="0.07" color="#f8fafc" position="0 0 0"></a-sphere>
    <a-ring radius-inner="0.16" radius-outer="0.18" color="#f8fafc" position="0 0 0" rotation="-90 0 0"></a-ring>
    <a-cylinder radius="0.012" height="0.55" color="#ef4444" position="0.275 0 0" rotation="0 0 90"></a-cylinder>
    <a-cone radius-bottom="0.04" height="0.1" color="#ef4444" position="0.6 0 0" rotation="0 0 -90"></a-cone>
    <a-cylinder radius="0.012" height="0.55" color="#22c55e" position="0 0.275 0"></a-cylinder>
    <a-cone radius-bottom="0.04" height="0.1" color="#22c55e" position="0 0.6 0"></a-cone>
    <a-cylinder radius="0.012" height="0.55" color="#3b82f6" position="0 0 0.275" rotation="90 0 0"></a-cylinder>
    <a-cone radius-bottom="0.04" height="0.1" color="#3b82f6" position="0 0 0.6" rotation="90 0 0"></a-cone>
    <a-text value="MAP ORIGIN" color="#f8fafc" width="1.8" align="center" position="0 0.32 0"></a-text>
  `
  root.appendChild(origin)
}

const renderMapDebug = (relocalization = engine?.getLastRelocalization()) => {
  clearMapDebug()
  const sessionMapMatrix = relocalization?.sessionMapMatrix || engine?.getCurrentMapSessionMatrix()
  if (!uiState.mapOverlayEnabled || !sessionMapMatrix) return

  const map = engine.getMap()
  drawMapOrigin(sessionMapMatrix)

  if (map?.points?.length) {
    buildColoredMapPointCloud(sessionMapMatrix)

    const inlierSet = new Set(relocalization?.globalInlierPointIds || [])
    const inlierPoses = (map.points || [])
      .filter((mp) => inlierSet.has(mp.id))
      .map((mp) => engine.getWorldPoseFromMap(mp.position, sessionMapMatrix))
      .filter(Boolean)
    if (inlierPoses.length) drawMapPointCloud(inlierPoses, '#22c55e', 0.09)
    return
  }

  const inlierSet = new Set(relocalization?.pnp?.inlierPointIds || [])
  const keyframes = engine.getKeyframes().filter((keyframe) => keyframe.mapPoints?.length)

  keyframes.forEach((keyframe) => {
    keyframe.mapPoints.slice(0, 120).forEach((mapPoint) => {
      const pose = engine.getMapPointWorldPose(keyframe, mapPoint, sessionMapMatrix)
      if (!pose) return

      const isInlier = keyframe.id === relocalization?.keyframe?.id && inlierSet.has(mapPoint.keypointIndex)
      drawMapPoint(pose, isInlier ? '#22c55e' : '#f97316', isInlier ? 0.045 : 0.028)
    })
  })
}

const createMarker = (pose, color = '#86efac') => {
  const root = document.getElementById('memory-root')
  const marker = document.createElement('a-entity')
  marker.setAttribute('position', `${pose.x} ${pose.y} ${pose.z}`)
  marker.innerHTML = `
    <a-cylinder radius="0.24" height="0.08" color="${color}" position="0 0.04 0"></a-cylinder>
    <a-sphere radius="0.18" color="#f7fbf8" position="0 0.36 0"></a-sphere>
  `
  root.appendChild(marker)
}

const restoreObjects = (relocalization = engine?.getLastRelocalization()) => {
  document.getElementById('memory-root').innerHTML = ''
  const restoredObjects = engine.getObjects()
    .map((objectPose) => engine.poseFromObject(objectPose, relocalization))
    .filter(Boolean)

  restoredObjects.forEach((pose) => createMarker(pose, '#86efac'))
  return restoredObjects.length
}

const setScanUi = (isScanning) => {
  const scanToggle = document.getElementById('dm-scan-toggle')
  scanToggle.classList.toggle('is-recording', isScanning)
  scanToggle.querySelector('.dm-action-label').textContent = isScanning ? 'Stop' : 'Scan'
  document.getElementById('dm-scan-assist').hidden = !isScanning
  refreshUiStage()
}

const renderScanRadar = (litSectors, youDeg, sectorCount) => {
  const radar = document.getElementById('sca-radar')
  if (!radar) return
  const cx = 93
  const cy = 93
  const rOut = 78
  const rIn = 56
  const point = (r, a) => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`
  let svg = ''
  for (let i = 0; i < sectorCount; i += 1) {
    const a0 = (i / sectorCount) * 2 * Math.PI - Math.PI / 2 + 0.05
    const a1 = ((i + 1) / sectorCount) * 2 * Math.PI - Math.PI / 2 - 0.05
    const fill = litSectors.has(i) ? '#ffc23d' : 'rgba(255,255,255,0.08)'
    svg += `<path d="M${point(rOut, a0)}A${rOut} ${rOut} 0 0 1 ${point(rOut, a1)}L${point(rIn, a1)}A${rIn} ${rIn} 0 0 0 ${point(rIn, a0)}Z" fill="${fill}"/>`
  }
  svg += '<rect x="85" y="85" width="16" height="16" rx="2" fill="#4a4031"/>'
  svg += '<text x="93" y="160" text-anchor="middle" fill="#9b958a" font-family="monospace" font-size="9" letter-spacing="1">TARGET</text>'
  if (Number.isFinite(youDeg)) {
    const a = youDeg * Math.PI / 180 - Math.PI / 2
    svg += `<circle cx="${(cx + (rOut + 8) * Math.cos(a)).toFixed(1)}" cy="${(cy + (rOut + 8) * Math.sin(a)).toFixed(1)}" r="6" fill="#5ee6a8"/>`
  }
  radar.innerHTML = svg
}

const updateScanAssist = (assistData) => {
  if (!assistData) {
    setScanUi(false)
    return
  }

  setScanUi(true)
  const {coach, coverage, keyframeCount, mode, moving, progress, sectorCount, sectors, textureOk, youDeg} = assistData
  const msg = document.getElementById('sca-msg')
  msg.textContent = coach.msg
  msg.className = `sca-msg${coach.warn ? ' warn' : ''}`
  document.getElementById('sca-sub').textContent = coach.sub
  document.getElementById('sca-count').textContent = `${keyframeCount} frames · coverage ${Math.round(coverage * 100)}%`

  const fill = document.getElementById('sca-fill')
  fill.style.width = `${Math.round(progress * 100)}%`
  fill.style.background = mode === 'rotate' ? '#ef4444' : '#ffc23d'
  document.getElementById('sca-meter-tx').textContent = assistData.meterText

  const chip = (cls, icon, label) => `<span class="sca-chip ${cls}"><i class="ti ${icon}"></i>${label}</span>`
  document.getElementById('sca-chips').innerHTML = [
    moving ? chip('ok', 'ti-check', 'Moving') : chip('bad', 'ti-alert-triangle', 'Not moving'),
    textureOk ? chip('ok', 'ti-check', 'Texture OK') : chip('bad', 'ti-alert-triangle', 'Low texture'),
    coverage >= 0.8 ? chip('ok', 'ti-check', `Coverage ${Math.round(coverage * 100)}%`) : chip('bad', 'ti-rotate-360', `Coverage ${Math.round(coverage * 100)}%`),
  ].join('')

  renderScanRadar(new Set(sectors), youDeg, sectorCount)
}

const buildLocalMapFromUi = async ({persist = false} = {}) => {
  const buildButton = document.getElementById('dm-build-map')
  buildButton.disabled = true
  try {
    const map = await engine.buildLocalMap()
    if (persist && map) await engine.persistActiveMap()
    renderMapDebug()
    return map
  } finally {
    buildButton.disabled = false
  }
}

const stopScanAndPromptBuild = async () => {
  const keyframeCount = engine.getKeyframes().length
  engine.stopContinuousScan()
  setStatus(`Scan stopped: ${keyframeCount} keyframes`)

  if (keyframeCount === 0) return

  const shouldBuild = await showConfirmModal({
    title: 'Build map now?',
    sub: `Captured ${keyframeCount} keyframes. Building creates a 3D map and localizes you automatically.`,
    confirmLabel: 'Build Map',
    cancelLabel: 'Not yet',
  })
  if (!shouldBuild) return

  const map = await buildLocalMapFromUi()
  if (map) setStatus('Map ready and localized — tap Place to add objects')
}

const armPlacement = () => {
  if (!engine.getMap()) {
    setStatus('Build a Local Map first')
    return
  }

  uiState.placementArmed = true
  setStatus('Tap the ground to place a local AR object')
}

const toggleLiveMapPreview = (enabled) => {
  uiState.liveMapOverlayEnabled = enabled
  if (!enabled) return

  engine.buildLocalMapPreview()
  uiState.mapOverlayEnabled = true
  document.getElementById('dm-map-toggle').checked = true
  renderMapDebug()
}

const bindPlacement = () => {
  document.getElementById('memory-ground').addEventListener('click', async (event) => {
    if (!uiState.placementArmed) return

    const point = event.detail?.intersection?.point
    if (!point) return
    uiState.placementArmed = false
    await engine.placeObject(point)
  })
}

const createEngine = () => createMappingEngine({
  getCameraObject3D,
  callbacks: {
    onStatus: setStatus,
    onMethod: setRelocalizeMethod,
    onDiagnostic: (eventName, payload) => {
      appendDiagnostic(eventName, payload)
      // Deferred one frame to avoid re-entering the engine's scan tick; skip if
      // the user already restarted scanning in the meantime.
      if (eventName === 'scan-limit') {
        requestAnimationFrame(() => {
          if (!engine.isScanning()) stopScanAndPromptBuild()
        })
      }
    },
    onKeyframesChanged: () => {
      updateCount()
      drawFeatureOverlay()
    },
    onScanAssist: updateScanAssist,
    onRelocalized: (relocalization) => {
      hideAlignGuide()
      renderMapDebug(relocalization)
      restoreObjects(relocalization)
      drawFeatureOverlay()
    },
    onObjectsChanged: () => restoreObjects(engine?.getLastRelocalization()),
  },
})

const boot = async () => {
  document.getElementById('ar-root').innerHTML = sceneHtml

  // Keep the overlay UI hidden until 8th Wall reports the camera/AR pipeline is
  // running ('realityready'). The panels are fixed + very high z-index, so if
  // shown immediately they can cover the landing-page "tap to start" prompt on
  // first load and block the camera-permission request — the user then sees the
  // UI but the AR camera never opens (worked around before by opening another
  // sample first to grant permission). A fallback timer reveals the UI anyway if
  // the event never fires (e.g. desktop / no camera).
  const arScene = document.querySelector('a-scene')
  const revealUi = () => document.body.classList.add('dm-ar-ready')
  if (arScene) {
    arScene.addEventListener('realityready', revealUi, {once: true})
    window.setTimeout(revealUi, 8000)
  } else {
    revealUi()
  }

  engine = createEngine()
  await engine.loadPersisted()
  updateCount()
  bindPlacement()
  restoreObjects()

  document.getElementById('dm-align-guide-dismiss').addEventListener('click', hideAlignGuide)
  if (engine.getMap()?.guideImage) showAlignGuide()

  const collapseTab = document.getElementById('dm-collapse-tab')
  const dmPanel = document.getElementById('dm-panel')
  collapseTab.addEventListener('click', () => {
    const collapsed = dmPanel.classList.toggle('is-collapsed')
    collapseTab.setAttribute('aria-expanded', String(!collapsed))
  })

  const roleToggle = document.getElementById('dm-role-toggle')
  const panel = document.querySelector('.dm-panel')
  roleToggle.addEventListener('click', () => {
    const next = roleToggle.dataset.role === 'master' ? 'peer' : 'master'
    roleToggle.dataset.role = next
    roleToggle.textContent = next === 'master' ? 'Master' : 'Peer'
    panel.dataset.role = next
  })

  document.getElementById('dm-scan-toggle').addEventListener('click', () => {
    if (engine.isScanning()) stopScanAndPromptBuild()
    else {
      engine.startContinuousScan()
      setScanUi(true)
    }
  })
  document.getElementById('dm-build-map').addEventListener('click', async () => {
    await buildLocalMapFromUi({persist: true})
  })
  document.getElementById('dm-place').addEventListener('click', armPlacement)
  document.getElementById('dm-restore').addEventListener('click', async () => {
    const result = await engine.relocalize()
    setResults(result?.matches || [])
  })
  document.getElementById('dm-debug-toggle').addEventListener('click', (event) => {
    const panel = document.querySelector('.dm-panel')
    const isOpen = panel.classList.toggle('is-debug-open')
    event.currentTarget.setAttribute('aria-expanded', String(isOpen))
  })
  document.getElementById('dm-feature-toggle').addEventListener('change', (event) => {
    uiState.featureOverlayEnabled = event.target.checked
    drawFeatureOverlay()
  })
  document.getElementById('dm-map-toggle').addEventListener('change', (event) => {
    uiState.mapOverlayEnabled = event.target.checked
    renderMapDebug()
  })
  document.getElementById('dm-live-map-toggle').addEventListener('change', (event) => {
    toggleLiveMapPreview(event.target.checked)
  })
  document.getElementById('dm-clear-objects').addEventListener('click', async () => {
    await engine.clearObjects()
  })
  document.getElementById('dm-export-log').addEventListener('click', exportDiagnostics)

  document.getElementById('dm-export-map').addEventListener('click', () => {
    if (!engine.getMap()) { setStatus('Build a Map first'); return }
    exportMapBundleAsFile(engine.buildBundle(VERSION))
    setStatus('Map exported')
  })

  const shareResult = document.getElementById('dm-share-result')
  const shareCode = document.getElementById('dm-share-code')
  const shareCopyBtn = document.getElementById('dm-share-copy')
  document.getElementById('dm-share-map').addEventListener('click', async () => {
    if (!engine.getMap()) { setStatus('Build a Map first'); return }
    setStatus('Uploading...')
    try {
      const code = await shareMapBundle(engine.buildBundle(VERSION))
      shareCode.textContent = code
      shareResult.hidden = false
      setStatus(`Map shared, code ${code}`)
    } catch (err) {
      setStatus(`Share failed: ${err.message}`)
    }
  })

  shareCopyBtn.addEventListener('click', async () => {
    const code = shareCode.textContent.trim()
    if (!code) return
    await copyTextToClipboard(code)
    const originalLabel = shareCopyBtn.textContent
    shareCopyBtn.textContent = 'Copied'
    shareCopyBtn.classList.add('is-copied')
    setTimeout(() => {
      shareCopyBtn.textContent = originalLabel
      shareCopyBtn.classList.remove('is-copied')
    }, 1400)
  })

  const applyLoadedBundle = (raw, sourceLabel) => {
    engine.applyBundle(raw, sourceLabel)
    setResults([])
    renderMapDebug()
    showAlignGuide()
  }

  document.getElementById('dm-join-map').addEventListener('click', async () => {
    const code = document.getElementById('dm-join-code').value.trim()
    if (code.length < 4) { setStatus('Enter a valid code'); return }
    setStatus(`Downloading Map (${code})...`)
    try {
      const raw = await downloadMapBundle(code)
      applyLoadedBundle(raw, code)
    } catch (err) {
      setStatus(`Load failed: ${err.message}`)
    }
  })

  document.getElementById('dm-import-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    setStatus(`Reading ${file.name}...`)
    try {
      const text = await file.text()
      const raw = JSON.parse(text)
      applyLoadedBundle(raw, file.name)
    } catch (err) {
      setStatus(`Import failed: ${err.message}`)
    } finally {
      event.target.value = ''
    }
  })
  window.addEventListener('resize', () => drawFeatureOverlay())
  document.getElementById('dm-clear').addEventListener('click', async () => {
    await engine.clearAll()
    resetDiagnostics(VERSION)
    uiState.liveMapOverlayEnabled = false
    uiState.placementArmed = false
    document.getElementById('dm-live-map-toggle').checked = false
    setResults([])
    clearMapDebug()
    drawFeatureOverlay()
  })
}

boot()
