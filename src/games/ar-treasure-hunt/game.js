import {createMappingEngine} from '../../components/device-mapping-core/engine.js'
import {
  downloadMapBundle,
  shareMapBundle,
  updateMapBundle,
} from '../../components/device-mapping-core/share.js'
import {
  fetchSpots,
  findNearbySpots,
  getCurrentGps,
  registerSpot,
} from '../../components/device-mapping-core/spots.js'

const VERSION = 'treasure-hunt-v1'
const MIN_CHESTS = 3
const MAX_CHESTS = 5
const DEFAULT_CONTENT = {kind: 'emoji', data: '💎'}
const MAX_IMAGE_EDGE_PX = 1024
const JPEG_QUALITY = 0.72
const GLB_WARN_BYTES = 5 * 1024 * 1024 // 5MB — warn but still allow sharing
// Base size for revealed content at objectPose.scale === 1 and
// objectPose.contentScale === 1. The reveal entity's own scale-up animation
// ends at local scale 1, so its world size equals
// objectPose.scale * CHEST_MATCH_SIZE * objectPose.contentScale (see
// buildRevealEntity / collectChest below). CHEST_MATCH_SIZE is set to roughly
// the chest's own footprint (chestMarkup()'s tap collider is 0.5m wide) so
// that at contentScale=1 the revealed content visually matches the chest's
// size, rather than looking noticeably smaller (the old 0.4m default).
const CHEST_MATCH_SIZE = 0.5
// Clamp range for the "Content size" adjust-panel slider.
const CONTENT_SCALE_MIN = 0.3
const CONTENT_SCALE_MAX = 3

const state = {
  mode: null,
  placementArmed: false,
  relocalized: false,
  chests: new Map(),
  found: new Set(),
  selectedSpotCode: '',
  huntShared: false,
  huntStartedToastShown: false,
  // Set when hide mode was entered via "edit a hunt" (start screen) rather
  // than fresh authoring. editingCode is the code being edited; the master
  // must relocalize into the loaded map (same as a seeker) before spatial
  // edits (placing/moving chests) are meaningful, since they're now in a new
  // physical session relative to the map's origin keyframe.
  editing: false,
  editingCode: '',
  // Ground point captured on tap, held until the content picker is confirmed
  // or skipped (CHANGE 4: "tap ground first, then pick content" flow).
  pendingPlacementPoint: null,
  pickerKind: 'emoji',
  pickerEmoji: DEFAULT_CONTENT.data,
  // CHANGE 5: objectId of the chest currently selected for the adjust panel
  // (hide mode only). Null when nothing is selected / panel is closed.
  selectedChestId: null,
  // Guards alignHunt()'s auto-retry loop against overlapping
  // taps starting a second concurrent loop.
  aligning: false,
}

const ADJUST_POSITION_STEP = 0.05
// Rotation/scale sliders carry their own min/max/step in scene.html; these
// two constants only clamp the persisted scale value.
const ADJUST_SCALE_MIN = 0.5
const ADJUST_SCALE_MAX = 10

let engine = null

const $ = (id) => document.getElementById(id)

const setHidden = (id, hidden) => {
  $(id).hidden = hidden
}

const STATUS_FADE_DELAY_MS = 3500

let statusFadeTimer = null
const setStatus = (message = '') => {
  const status = $('th-status')
  status.textContent = message
  // Auto-fade the status line a few seconds after the last update instead of
  // leaving it on screen permanently. Any subsequent setStatus() call clears
  // the fade and restarts the timer, so it stays visible while actively
  // changing (see CHANGE 1).
  status.classList.remove('th-status--faded')
  window.clearTimeout(statusFadeTimer)
  if (!message) return
  statusFadeTimer = window.setTimeout(() => {
    status.classList.add('th-status--faded')
  }, STATUS_FADE_DELAY_MS)
}

let toastTimer = null
const showToast = (message, durationMs = 2600) => {
  const toast = $('th-toast')
  if (!toast) return
  toast.textContent = message
  toast.hidden = false
  toast.classList.remove('th-toast--visible')
  // Force reflow so the enter animation replays on repeated toasts.
  void toast.offsetWidth
  toast.classList.add('th-toast--visible')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast.classList.remove('th-toast--visible')
    window.setTimeout(() => {
      toast.hidden = true
    }, 200)
  }, durationMs)
}

const setHuntHud = (message = '') => {
  const hud = $('th-hunt-hud')
  if (!hud) return
  hud.textContent = message
  hud.hidden = !message
}

const setMethod = (_method, label = 'IDLE') => {
  $('th-method').textContent = label
}

const setMode = (mode) => {
  state.mode = mode
  $('th-mode').textContent = mode === 'hide' ? 'HIDE' : 'SEEK'
}

const getCameraObject3D = () => {
  const cameraEl = $('camera')
  const root = cameraEl?.object3D || null
  if (root) root.userData.projectionCamera = cameraEl.getObject3D('camera')
  return root
}

const updateCounter = () => {
  const total = state.chests.size || engine?.getObjects().length || 0
  $('th-counter').textContent = `${state.found.size} / ${total} found`
  $('th-share').disabled = state.mode !== 'hide' || total < MIN_CHESTS
  // Editing an existing hunt: placing NEW chests requires the master to have
  // relocalized into the loaded map first (see startEditHunt) — otherwise
  // engine.placeObject would anchor the new chest to an un-aligned, meaningless
  // local pose. Fresh hide authoring has no such gate (there's nothing to
  // relocalize into yet).
  const placementBlockedByEditGate = state.editing && !state.relocalized
  $('th-place').disabled = state.mode !== 'hide' || !engine?.getMap() || total >= MAX_CHESTS || placementBlockedByEditGate
}

const clearChestRoot = () => {
  const root = $('th-chest-root')
  if (!root) return
  root.innerHTML = ''
  while (root.object3D.children.length > 0) {
    const child = root.object3D.children[0]
    root.object3D.remove(child)
    child.geometry?.dispose?.()
    child.material?.dispose?.()
  }
  state.chests.clear()
  // Any selected chest just got removed from the DOM — close the adjust
  // panel so it doesn't point at a stale entity (CHANGE 5).
  state.selectedChestId = null
  setHidden('th-adjust-panel', true)
}

const chestMarkup = () => `
  <a-entity class="th-chest-bob" animation="property: position; from: 0 0 0; to: 0 0.08 0; dir: alternate; dur: 1200; easing: easeInOutSine; loop: true">
    <a-ring radius-inner="0.28" radius-outer="0.34" rotation="-90 0 0" color="#fbbf24" material="opacity: 0.42; transparent: true"></a-ring>
    <a-box position="0 0.16 0" width="0.46" height="0.28" depth="0.34" color="#92400e"></a-box>
    <a-box position="0 0.33 0" width="0.5" height="0.16" depth="0.38" rotation="-10 0 0" color="#b45309"></a-box>
    <a-box position="0 0.2 -0.18" width="0.14" height="0.16" depth="0.035" color="#fbbf24"></a-box>
    <a-cylinder position="-0.18 0.38 0" radius="0.025" height="0.4" rotation="90 0 0" color="#f59e0b"></a-cylinder>
    <a-cylinder position="0.18 0.38 0" radius="0.025" height="0.4" rotation="90 0 0" color="#f59e0b"></a-cylinder>
    <a-light type="point" intensity="0.7" distance="1.5" color="#fbbf24" position="0 0.5 0"></a-light>
  </a-entity>
  <a-box class="cantap" position="0 0.3 0" width="0.5" height="0.6" depth="0.5" material="opacity: 0; transparent: true"></a-box>
`

const createChest = (objectPose, pose) => {
  const root = $('th-chest-root')
  const entity = document.createElement('a-entity')
  entity.dataset.objectId = objectPose.id
  const rotationY = objectPose.rotationY || 0
  const scale = objectPose.scale || 1
  entity.setAttribute('position', `${pose.x} ${pose.y} ${pose.z}`)
  entity.setAttribute('rotation', `0 ${rotationY} 0`)
  entity.setAttribute('scale', `${scale} ${scale} ${scale}`)
  // cantap makes the chest a target for the camera's raycaster (see #camera in
  // scene.html). CHANGE 3: tapping always opens regardless of distance.
  // CHANGE 5: in hide mode, tapping a placed chest instead selects it for the
  // adjust panel (position/rotation/scale) — the two behaviors are
  // disambiguated by state.mode inside onChestTapped.
  //
  // The outer entity has no mesh, and
  // chestMarkup()'s a-box/a-cylinder meshes live on a nested non-cantap child
  // (.th-chest-bob), so the raycaster used to miss the chest entirely and hit
  // #th-ground behind it. chestMarkup() now also renders an invisible
  // "cantap" collider box (0.5 x 0.6 x 0.5, centered on the chest) as a direct
  // child of this entity — a real mesh the raycaster can intersect. A-Frame/
  // DOM click events bubble up from that collider to this outer entity, so
  // the listener below still fires and objectId mapping is unaffected.
  entity.classList.add('cantap')
  entity.innerHTML = chestMarkup()
  entity.addEventListener('click', () => onChestTapped(objectPose.id))
  root.appendChild(entity)
  state.chests.set(objectPose.id, {objectPose, pose, entity, collected: false})
}

const renderChests = (relocalization = engine?.getLastRelocalization()) => {
  clearChestRoot()
  const objects = engine?.getObjects() || []

  objects.forEach((objectPose) => {
    // Fresh hide authoring: render at the exact tapped world point (same as the
    // device-mapping sample's restoreObjects/createMarker). Round-tripping through
    // poseFromObject here would re-project via the session's self-localization and
    // visibly offset the chest from where the hider actually tapped.
    //
    // Seek mode AND edit mode both need poseFromObject: a seeker's session has a
    // different origin and must relocalize into the shared map, and so does a master
    // who re-opened an existing hunt to edit it — they're in a brand-new physical
    // session relative to the map's origin keyframe, exactly like a seeker.
    const pose = (state.mode === 'seek' || state.editing)
      ? engine.poseFromObject(objectPose, relocalization)
      : objectPose.pose
    if (pose) createChest(objectPose, pose)
  })

  updateCounter()
}

// The PiP guide thumbnail and the Align button dock are separate top-level
// elements (see scene.html) but always show/hide together, so tie
// their `hidden` state here in one place.
const showGuide = () => {
  const guideImage = engine?.getMap()?.guideImage
  if (!guideImage) return
  $('th-align-guide-img').src = guideImage
  setHidden('th-align-guide', false)
  setHidden('th-align-dock', false)
}

const hideGuide = () => {
  setHidden('th-align-guide', true)
  setHidden('th-align-dock', true)
}

// Guide starts as a small picture-in-picture thumbnail so the camera feed stays
// visible; tapping the thumbnail enlarges it for a closer look, tapping again
// shrinks it back.
const toggleGuideSize = () => {
  $('th-align-guide').classList.toggle('th-align-guide--expanded')
}

// Compact glass "radar" readiness indicator built from the
// rich onScanAssist payload ({mode, coach, keyframeCount, coverage, progress,
// meterText, moving, textureOk, sectors, sectorCount}), replacing the old
// single text line. Markup is built once (SCAN_ASSIST_SECTOR_COUNT wedges +
// a numeric readout) and only attribute/class values are touched on each
// update, since onScanAssist can fire at a high rate during scanning.
const SCAN_ASSIST_SECTOR_COUNT = 24
const SCAN_ASSIST_RADIUS = 30
const SCAN_ASSIST_READY_COVERAGE = 0.8

// Builds the 24-wedge ring as SVG <path> elements once. Each wedge's fill is
// toggled between "covered"/"uncovered" CSS classes on update rather than
// rebuilding the DOM every frame.
const buildScanAssistRing = () => {
  const svgNs = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNs, 'svg')
  svg.setAttribute('viewBox', '0 0 72 72')
  svg.setAttribute('class', 'th-radar-svg')
  const center = 36
  const outer = SCAN_ASSIST_RADIUS
  const inner = SCAN_ASSIST_RADIUS - 9
  const gap = 0.03 // radians of gap between wedges for visual separation

  for (let i = 0; i < SCAN_ASSIST_SECTOR_COUNT; i++) {
    const a0 = (i / SCAN_ASSIST_SECTOR_COUNT) * Math.PI * 2 - Math.PI / 2 + gap
    const a1 = ((i + 1) / SCAN_ASSIST_SECTOR_COUNT) * Math.PI * 2 - Math.PI / 2 - gap
    const x0o = center + outer * Math.cos(a0)
    const y0o = center + outer * Math.sin(a0)
    const x1o = center + outer * Math.cos(a1)
    const y1o = center + outer * Math.sin(a1)
    const x1i = center + inner * Math.cos(a1)
    const y1i = center + inner * Math.sin(a1)
    const x0i = center + inner * Math.cos(a0)
    const y0i = center + inner * Math.sin(a0)
    const path = document.createElementNS(svgNs, 'path')
    path.setAttribute('d', `M ${x0o} ${y0o} A ${outer} ${outer} 0 0 1 ${x1o} ${y1o} L ${x1i} ${y1i} A ${inner} ${inner} 0 0 0 ${x0i} ${y0i} Z`)
    path.setAttribute('class', 'th-radar-wedge')
    path.dataset.sector = String(i)
    svg.appendChild(path)
  }

  // Center readiness glyph — swaps between a coverage % and a checkmark.
  const centerText = document.createElementNS(svgNs, 'text')
  centerText.setAttribute('x', String(center))
  centerText.setAttribute('y', String(center + 4))
  centerText.setAttribute('class', 'th-radar-center-text')
  centerText.setAttribute('text-anchor', 'middle')
  centerText.textContent = '0%'
  svg.appendChild(centerText)

  return svg
}

const updateScanAssist = (assist) => {
  const panel = $('th-scan-assist')
  if (!assist) {
    panel.hidden = true
    return
  }

  // Build the static ring markup once and reuse it on subsequent calls.
  if (!panel.dataset.built) {
    panel.innerHTML = ''
    panel.appendChild(buildScanAssistRing())
    const readout = document.createElement('div')
    readout.className = 'th-radar-readout'
    readout.innerHTML = `
      <div class="th-radar-state" id="th-radar-state"></div>
      <div class="th-radar-meta" id="th-radar-meta"></div>
    `
    panel.appendChild(readout)
    panel.dataset.built = '1'
  }

  panel.hidden = false

  const isReady = assist.mode === 'done' || (assist.coverage ?? 0) >= SCAN_ASSIST_READY_COVERAGE
  panel.classList.toggle('th-assist--ready', isReady)
  panel.classList.toggle('th-assist--moving', !!assist.moving && !isReady)

  // Fill wedges for covered sectors (rich payload: assist.sectors is an array
  // of ints, one per sector, non-zero meaning "covered").
  const sectors = assist.sectors || []
  panel.querySelectorAll('.th-radar-wedge').forEach((wedge) => {
    const covered = !!sectors[Number(wedge.dataset.sector)]
    wedge.classList.toggle('th-radar-wedge--covered', covered)
  })

  const coveragePct = Math.round((assist.coverage ?? 0) * 100)
  const centerText = panel.querySelector('.th-radar-center-text')
  if (centerText) centerText.textContent = isReady ? '✓' : `${coveragePct}%`

  const stateEl = $('th-radar-state')
  const metaEl = $('th-radar-meta')
  if (stateEl) {
    stateEl.textContent = isReady ? 'READY TO BUILD' : (assist.coach?.msg || 'Keep scanning…')
  }
  if (metaEl) {
    metaEl.textContent = `${assist.keyframeCount ?? 0} kf · ${coveragePct}% coverage`
  }

  // Cue the Build action once scanning is sufficient — the button itself may
  // still be disabled until the scan is explicitly stopped (see
  // stopScanAndEnableBuild), but this highlight tells the hider it's worth
  // stopping now.
  $('th-build').classList.toggle('th-build--cued', isReady)
}

const showVictory = () => {
  $('th-victory-count').textContent = `${state.found.size} treasures collected.`
  setHidden('th-victory', false)
}

// DOM/CSS confetti burst played over the live camera feed for a few
// seconds before the victory panel appears. Gold + multicolor pieces fall
// from above the top edge to below the bottom edge with staggered delays,
// swaying and spinning as they fall. Pure CSS animation; this function only
// creates/removes the piece elements (self-cleaning via a matching timeout).
const CONFETTI_PIECE_COUNT = 54
const CONFETTI_COLORS = ['#fbbf24', '#ffd873', '#f8fafc', '#f87171', '#34d399', '#60a5fa', '#b45309']
const CONFETTI_DURATION_MS = 2800

const launchConfetti = () => {
  const container = $('th-confetti')
  container.innerHTML = ''
  setHidden('th-confetti', false)

  for (let i = 0; i < CONFETTI_PIECE_COUNT; i++) {
    const piece = document.createElement('i')
    const isRound = i % 3 === 0
    piece.className = isRound ? 'th-confetti-piece th-confetti-piece--round' : 'th-confetti-piece'

    const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length]
    const left = Math.random() * 100
    const size = 6 + Math.random() * 8
    const fallDuration = 1800 + Math.random() * 1400
    const swayDuration = 900 + Math.random() * 800
    const delay = Math.random() * 900
    const spinFrom = Math.random() * 360
    const spinTo = spinFrom + 360 + Math.random() * 720

    piece.style.left = `${left}vw`
    piece.style.width = `${size}px`
    piece.style.height = `${isRound ? size : size * 1.5}px`
    piece.style.background = color
    piece.style.animationDuration = `${fallDuration}ms, ${swayDuration}ms, ${fallDuration}ms`
    piece.style.animationDelay = `${delay}ms, ${delay}ms, ${delay}ms`
    piece.style.setProperty('--th-confetti-spin-from', `${spinFrom}deg`)
    piece.style.setProperty('--th-confetti-spin-to', `${spinTo}deg`)
    container.appendChild(piece)
  }

  window.setTimeout(() => {
    setHidden('th-confetti', true)
    container.innerHTML = ''
  }, CONFETTI_DURATION_MS + 900)
}

// On the final chest, celebrate with confetti first and only reveal
// the play-again panel after it's had a few seconds to play out — makes the
// win feel earned instead of an abrupt panel swap.
const celebrateVictory = () => {
  launchConfetti()
  window.setTimeout(showVictory, CONFETTI_DURATION_MS)
}

// Build the revealed-content entity for a chest (CHANGE 4). Falls back to the
// default emoji when a chest has no content attached (e.g. older hunts shared
// before this feature, or objectPose.content missing/malformed).
// `contentScale` (objectPose.contentScale, default 1) scales
// the content's base size (CHEST_MATCH_SIZE) independently of the chest's own
// objectPose.scale — final on-screen size composes as:
//   world size = objectPose.scale (parent entity) * CHEST_MATCH_SIZE * contentScale
// `translucent` renders a dimmed, non-final preview
// copy of the content at the chest while the adjust panel has it selected —
// it skips the pop-in animation and glTF point light so it doesn't look like
// the real reveal or add extra lighting during editing.
const buildRevealEntity = (content, contentScale = 1, {translucent = false} = {}) => {
  const safeContent = content && content.kind && content.data ? content : DEFAULT_CONTENT
  const size = CHEST_MATCH_SIZE * (contentScale || 1)
  const reveal = document.createElement('a-entity')
  // Sit at the chest's own origin (a tiny lift only, so the content
  // doesn't clip into the ground plane) rather than floating 0.9m above it.
  // The old fixed offset was in the reveal's *local* space, which is itself
  // scaled by the parent entity's objectPose.scale — so on a large chest the
  // reveal used to float far above and look detached from where the chest
  // actually was. entry.entity (the parent, see collectChest) carries
  // objectPose.scale, so this small local offset scales together with the
  // rest of the reveal content and stays visually anchored to the chest.
  reveal.setAttribute('position', translucent ? '0 0.32 0' : '0 0.12 0')
  // th-billboard keeps the content facing the camera regardless of chest
  // orientation (registered once in startTreasureHunt, see bottom of file).
  reveal.setAttribute('th-billboard', '')
  if (translucent) {
    // Preview copy: no pop-in, just fade to a dim, semi-transparent hover so
    // it reads as a "ghost" of the real content rather than the final reveal.
    reveal.setAttribute('scale', '1 1 1')
  } else {
    reveal.setAttribute('scale', '0.001 0.001 0.001')
    reveal.setAttribute('animation__scaleup', `property: scale; to: 1 1 1; dur: 420; easing: easeOutBack`)
  }

  if (safeContent.kind === 'image') {
    const plane = document.createElement('a-image')
    plane.setAttribute('src', safeContent.data)
    plane.setAttribute('width', size)
    plane.setAttribute('height', size)
    plane.setAttribute('transparent', 'true')
    if (translucent) plane.setAttribute('opacity', '0.55')
    reveal.appendChild(plane)
  } else if (safeContent.kind === 'glb') {
    const model = document.createElement('a-entity')
    model.setAttribute('gltf-model', safeContent.data)
    model.setAttribute('scale', `${size} ${size} ${size}`)
    // Small fill light riding along with the model so glTF PBR
    // materials (which need more than ambient+directional to read correctly)
    // get an extra nearby source, on top of the scene's hemisphere light.
    // Preview copies skip the extra point light — it's a per-instance light
    // and stacking it during live editing has no benefit and adds cost.
    if (!translucent) model.setAttribute('light', 'type: point; intensity: 0.9; distance: 2; color: #fff3d6')
    if (translucent) model.setAttribute('material', 'opacity: 0.55; transparent: true')
    // Plain A-Frame scenes have no environment map, so glTF PBR
    // materials (especially metallic ones) often render near-black. Clamping
    // metalness on load is a common, cheap workaround that doesn't require
    // adding a full env map pipeline.
    model.addEventListener('model-loaded', () => {
      const mesh = model.getObject3D('mesh')
      if (!mesh) return
      mesh.traverse((node) => {
        const material = node.material
        if (!material) return
        const materials = Array.isArray(material) ? material : [material]
        materials.forEach((mat) => {
          if (typeof mat.metalness === 'number') {
            mat.metalness = Math.min(mat.metalness, 0.4)
          }
          mat.needsUpdate = true
        })
      })
    })
    reveal.appendChild(model)
  } else {
    // Emoji: draw to an offscreen canvas and use it as a plane texture, since
    // A-Frame text geometry doesn't render color emoji glyphs reliably.
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 256
    const ctx = canvas.getContext('2d')
    ctx.font = '190px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(safeContent.data, 128, 140)
    const plane = document.createElement('a-image')
    plane.setAttribute('src', canvas.toDataURL('image/png'))
    plane.setAttribute('width', size)
    plane.setAttribute('height', size)
    plane.setAttribute('transparent', 'true')
    if (translucent) plane.setAttribute('opacity', '0.55')
    reveal.appendChild(plane)
  }

  return reveal
}

// The open effect must NEVER sit between the camera and the
// revealed content. The previous version put sparkle shards and a light beam
// directly in front of the chest at content height (~0.35-0.9m), which is
// exactly where the reveal appears a moment later — visually masking it.
// This version keeps every element either on the ground plane (ring/shards
// skimming outward low, never rising into the content's vertical band) or
// behind the chest relative to camera-facing content (the reveal is
// billboarded to face the camera, so anything that stays near y=0 and
// disperses radially outward reads as "around/behind" rather than "in front
// of" the content). Sequence handled by collectChest's timeouts: this ground
// flash/ring plays FIRST, then the chest model vanishes, THEN the content
// scales in — so nothing is left drifting through the content's airspace by
// the time it appears. Everything self-removes and uses only A-Frame
// primitives/animations, so it stays cheap on an AR session.
const SPARK_COUNT = 10
const SPARK_COLORS = ['#fbbf24', '#ffd873', '#f8fafc', '#fde68a']

const buildOpenBurst = () => {
  const burst = document.createElement('a-entity')

  // Brief ground-level flash — reads as "something happened" without any
  // volumetric beam standing in the content's line of sight.
  const flash = document.createElement('a-light')
  flash.setAttribute('type', 'point')
  flash.setAttribute('intensity', '2.8')
  flash.setAttribute('distance', '2.2')
  flash.setAttribute('color', '#fff7d6')
  flash.setAttribute('position', '0 0.05 0')
  flash.setAttribute('animation', 'property: light.intensity; to: 0; dur: 320; easing: easeOutQuad')
  burst.appendChild(flash)

  // Expanding golden halo ring flat on the ground — the signature "something
  // opened here" cue. Stays pinned to the ground plane (y ~ 0.02) so it can
  // never occlude content that appears above it.
  const shockwave = document.createElement('a-ring')
  shockwave.setAttribute('radius-inner', '0.05')
  shockwave.setAttribute('radius-outer', '0.14')
  shockwave.setAttribute('rotation', '-90 0 0')
  shockwave.setAttribute('position', '0 0.02 0')
  shockwave.setAttribute('material', 'color: #fbbf24; opacity: 0.85; transparent: true; shader: flat; side: double')
  shockwave.setAttribute('animation__expand', 'property: geometry.radiusOuter; to: 1.3; dur: 550; easing: easeOutQuad')
  shockwave.setAttribute('animation__expand2', 'property: geometry.radiusInner; to: 1.1; dur: 550; easing: easeOutQuad')
  shockwave.setAttribute('animation__fade', 'property: material.opacity; to: 0; dur: 550; easing: easeOutQuad')
  burst.appendChild(shockwave)

  // A second, faster inner halo for a punchier "double ring" read.
  const innerRing = document.createElement('a-ring')
  innerRing.setAttribute('radius-inner', '0.02')
  innerRing.setAttribute('radius-outer', '0.08')
  innerRing.setAttribute('rotation', '-90 0 0')
  innerRing.setAttribute('position', '0 0.025 0')
  innerRing.setAttribute('material', 'color: #ffe9a8; opacity: 0.9; transparent: true; shader: flat; side: double')
  innerRing.setAttribute('animation__expand', 'property: geometry.radiusOuter; to: 0.55; dur: 380; easing: easeOutQuad')
  innerRing.setAttribute('animation__expand2', 'property: geometry.radiusInner; to: 0.4; dur: 380; easing: easeOutQuad')
  innerRing.setAttribute('animation__fade', 'property: material.opacity; to: 0; dur: 380; easing: easeOutQuad')
  burst.appendChild(innerRing)

  // Sparkles skim outward low and to the sides (never rising past ~0.25m,
  // well below where the reveal content sits/floats), so they read as
  // ground-hugging shimmer rather than a curtain in front of the content.
  for (let i = 0; i < SPARK_COUNT; i++) {
    const angle = (i / SPARK_COUNT) * Math.PI * 2 + (i % 2 === 0 ? 0.15 : -0.15)
    const outRadius = 0.4 + (i % 3) * 0.14
    const outX = Math.cos(angle) * outRadius
    const outZ = Math.sin(angle) * outRadius
    const outY = 0.04 + (i % 3) * 0.06 // stays low — ground shimmer, not a curtain
    const color = SPARK_COLORS[i % SPARK_COLORS.length]
    const isShard = i % 2 === 0

    const spark = document.createElement(isShard ? 'a-tetrahedron' : 'a-sphere')
    if (isShard) spark.setAttribute('radius', '0.03')
    else spark.setAttribute('radius', '0.025')
    spark.setAttribute('color', color)
    spark.setAttribute('material', 'shader: flat')
    spark.setAttribute('position', '0 0.03 0')
    spark.setAttribute('animation__fly', `property: position; to: ${outX.toFixed(3)} ${outY.toFixed(3)} ${outZ.toFixed(3)}; dur: 420; easing: easeOutCubic`)
    spark.setAttribute('animation__spin', `property: rotation; to: ${(i * 47) % 360} ${(i * 83) % 360} ${(i * 29) % 360}; dur: 420; easing: linear`)
    spark.setAttribute('animation__fade', 'property: material.opacity; from: 1; to: 0; dur: 420; delay: 150; easing: easeInQuad')
    burst.appendChild(spark)
  }

  // Self-remove once the effect finishes, well before the reveal content
  // appears (see collectChest's timing) — nothing lingers to compete with it.
  window.setTimeout(() => burst.remove(), 700)
  return burst
}

// Fades out and removes the chest model subtree (the bobbing group +
// the invisible tap collider) so only the revealed content remains at the
// chest's spot. entry.entity (the anchor holding position/rotation/scale)
// is left in place — only its direct chest-model children are torn down.
const removeChestModel = (entry) => {
  const bob = entry.entity.querySelector('.th-chest-bob')
  const collider = entry.entity.querySelector('.cantap')
  ;[bob, collider].forEach((node) => {
    if (!node) return
    node.setAttribute('animation__vanish', 'property: scale; to: 0.001 0.001 0.001; dur: 300; easing: easeInQuad')
    window.setTimeout(() => node.remove(), 320)
  })
}

const collectChest = (entry) => {
  if (entry.collected) return
  entry.collected = true
  state.found.add(entry.objectPose.id)
  updateCounter()

  // The transient "pop" plays on the chest model subtree only, not on
  // entry.entity. entry.entity carries objectPose position + scale and is
  // also the parent the reveal attaches to — if entry.entity itself were
  // scaled up permanently, the reveal would inherit an inflated 1.6x world
  // scale on top of objectPose.scale. Scoping the pop to `.th-chest-bob`
  // keeps entry.entity exactly at objectPose.scale.
  const bob = entry.entity.querySelector('.th-chest-bob')
  if (bob) {
    bob.setAttribute('animation__pop', 'property: scale; to: 1.35 1.35 1.35; dur: 180; easing: easeOutQuad')
  }
  entry.entity.appendChild(buildOpenBurst())

  // The chest model (box/lid/collider) fades out and is removed,
  // leaving only the reveal behind at this spot.
  window.setTimeout(() => removeChestModel(entry), 180)

  window.setTimeout(() => {
    // Reveal is a direct child of entry.entity, which is untouched at
    // objectPose.scale — so the reveal inherits exactly the chest's world
    // position and objectPose.scale. Its own scale-up animation
    // (buildRevealEntity's animation__scaleup) ends at local scale 1, giving
    // a final world scale of objectPose.scale, not objectPose.scale * 1.6.
    entry.entity.appendChild(buildRevealEntity(entry.objectPose.content, entry.objectPose.contentScale))
  }, 220)

  if (navigator.vibrate) navigator.vibrate(80)
  // Celebrate with confetti before the play-again panel instead of
  // popping #th-victory the instant the last chest opens — gives the just-
  // revealed content a moment on screen and makes the win feel earned.
  if (state.found.size === state.chests.size) celebrateVictory()
}

// CHANGE 3 + CHANGE 5: tap dispatch is mode-dependent so the two features
// don't conflict —
//   HIDE mode (fresh authoring OR editing an existing hunt): tapping a placed
//     chest SELECTS it and opens the adjust panel (position/rotation/scale),
//     it never "opens"/collects. state.editing is hide-mode-only (see
//     startEditHunt), so checking state.mode === 'hide' already covers both.
//   SEEK mode: tapping OPENS the chest via the camera raycaster hitting a
//     `.cantap` chest (see #camera in scene.html) — no walk-proximity gating.
const onChestTapped = (objectId) => {
  const entry = state.chests.get(objectId)
  if (!entry) return
  if (state.mode === 'hide') {
    selectChestForAdjust(objectId)
    return
  }
  if (entry.collected) return

  // Quick springy bounce on the chest model as tap feedback,
  // then open. The tween runs on the chest-bob subtree so it doesn't disturb
  // the anchor's objectPose.scale that the reveal inherits.
  const bob = entry.entity.querySelector('.th-chest-bob')
  if (bob) {
    bob.removeAttribute('animation__tap')
    bob.setAttribute('animation__tap', 'property: scale; from: 1 1 1; to: 1.18 0.86 1.18; dir: alternate; dur: 110; loop: 2; easing: easeOutQuad')
  }
  window.setTimeout(() => collectChest(entry), 200)
}

const createEngine = () => createMappingEngine({
  getCameraObject3D,
  callbacks: {
    onStatus: setStatus,
    onMethod: setMethod,
    onDiagnostic: (eventName) => {
      if (eventName === 'scan-limit') requestAnimationFrame(stopScanAndEnableBuild)
    },
    onScanAssist: updateScanAssist,
    onKeyframesChanged: () => updateCounter(),
    onObjectsChanged: () => {
      if (state.mode === 'hide') renderChests(engine?.getLastRelocalization())
      else updateCounter()
    },
    onRelocalized: (relocalization) => {
      state.relocalized = true
      hideGuide()
      setHidden('th-seek-panel', true)
      renderChests(relocalization)
      if (state.mode === 'seek') {
        if (state.chests.size === 0) {
          setStatus('No treasure objects found in this hunt.')
        } else if (!state.huntStartedToastShown) {
          state.huntStartedToastShown = true
          showToast(`Hunt started — find ${state.chests.size} chests. Tap a chest to open it.`, 3400)
        }
      } else if (state.editing) {
        // Master re-aligned into their own previously-shared map — spatial
        // editing (placing new chests, position nudges) is now unblocked.
        setHidden('th-hide-panel', false)
        updateCounter()
        setHuntHud(`Editing hunt ${state.editingCode}`)
        setStatus(`Aligned. Tap a chest to adjust it, or place a new one.`)
      }
    },
  },
})

const resetHuntState = () => {
  state.placementArmed = false
  state.relocalized = false
  state.huntShared = false
  state.huntStartedToastShown = false
  state.editing = false
  state.editingCode = ''
  state.found.clear()
  clearChestRoot()
  setHuntHud('')
  updateCounter()
}

// Relabels the share button contextually: "Update hunt" while editing an
// existing shared hunt (re-shares to the SAME code), "Share hunt" for a
// brand-new authoring session (generates a new code + registers GPS).
const updateShareButtonLabel = () => {
  $('th-share').textContent = state.editing ? 'Update hunt' : 'Share hunt'
}

const startHideMode = async () => {
  setMode('hide')
  resetHuntState()
  updateShareButtonLabel()
  setHidden('th-start', true)
  setHidden('th-hide-panel', false)
  setHidden('th-hunt-live-bar', true)
  setStatus('Start scanning, move around the room, then stop and build the map.')
  $('th-build').disabled = true
  $('th-place').disabled = true
  $('th-share').disabled = true
}

const startSeekMode = () => {
  setMode('seek')
  resetHuntState()
  setHidden('th-start', true)
  setHidden('th-seek-panel', false)
  // GPS is optional: a share code alone is enough to join (indoor single-venue
  // use). Nearby-spot search — the only GPS consumer on the seek side — runs
  // on demand when the user taps the refresh button.
  setStatus('Enter a hunt code, or search nearby hunts via GPS.')
}

// Entry point for the start screen's "edit a hunt (enter code)" affordance.
// Downloads the existing bundle and loads it into hide mode, but — unlike
// fresh authoring — the master's current AR session has a different physical
// origin than the one the map was built in, so they must relocalize (the
// same align-guide/Align flow a seeker uses) before spatial edits are valid.
// Content/rotation/scale edits on already-placed chests don't depend on the
// live world pose, so those stay available immediately.
const startEditHunt = async (rawCode) => {
  const code = rawCode.trim()
  if (code.length < 4) {
    setStatus('Enter a valid hunt code.')
    return
  }

  $('th-edit-load').disabled = true
  setStatus(`Downloading hunt ${code}...`)
  let bundle = null
  try {
    bundle = await downloadMapBundle(code)
  } catch (error) {
    setStatus(`Load failed: ${error.message}`)
    showToast(`Could not load hunt ${code}.`, 2200)
    $('th-edit-load').disabled = false
    return
  }

  setMode('hide')
  resetHuntState()
  state.editing = true
  state.editingCode = code
  updateShareButtonLabel()
  engine.applyBundle(bundle, code)

  setHidden('th-start', true)
  // Hide panel stays hidden until relocalized (onRelocalized re-shows it) —
  // showing scan/build/place controls before alignment would be misleading
  // since the master hasn't yet re-anchored into the loaded map.
  setHidden('th-hide-panel', true)
  setHidden('th-hunt-live-bar', true)
  setHuntHud(`Editing hunt ${code} — align to the map to edit`)
  setStatus(`Editing hunt ${code} — align to the map to edit.`)
  showGuide()
  $('th-edit-load').disabled = false
}

// Return to the start screen and fully reset engine + persisted spatial memory,
// so hiders/seekers can begin a brand-new hunt without reloading the page.
const startNewHunt = async () => {
  await engine.clearAll()
  state.mode = null
  state.placementArmed = false
  state.relocalized = false
  state.huntShared = false
  state.huntStartedToastShown = false
  state.editing = false
  state.editingCode = ''
  state.found.clear()
  clearChestRoot()
  setHuntHud('')
  hideGuide()
  setHidden('th-hunt-live-bar', true)
  setHidden('th-hide-panel', true)
  setHidden('th-seek-panel', true)
  setHidden('th-victory', true)
  // Defensively clear any leftover confetti pieces/timers so a fast
  // "Play again" tap can't leave stray confetti running into the next hunt.
  setHidden('th-confetti', true)
  $('th-confetti').innerHTML = ''
  setHidden('th-code-wrap', true)
  setHidden('th-start', false)
  $('th-mode').textContent = 'Choose mode'
  setStatus('Start as hider or seeker.')
}

const stopScanAndEnableBuild = () => {
  engine.stopContinuousScan()
  $('th-scan').textContent = 'Start scan'
  $('th-scan').classList.remove('is-scanning')
  $('th-build').disabled = engine.getKeyframes().length === 0
  setStatus(`Scan stopped: ${engine.getKeyframes().length} keyframes captured.`)
}

const toggleScan = () => {
  if (engine.isScanning()) {
    stopScanAndEnableBuild()
    return
  }

  engine.startContinuousScan()
  $('th-scan').textContent = 'Stop scan'
  $('th-scan').classList.add('is-scanning')
  $('th-build').disabled = true
}

const buildMap = async () => {
  $('th-build').disabled = true
  setStatus('Building local map...')
  const map = await engine.buildLocalMap()
  if (!map) {
    $('th-build').disabled = false
    return
  }
  $('th-place').disabled = false
  state.placementArmed = true
  setStatus(`Map ready. Tap the ground to hide ${MIN_CHESTS}-${MAX_CHESTS} chests.`)
}

const armPlacement = () => {
  if (!engine.getMap()) {
    setStatus('Build the map first.')
    return
  }
  if (engine.getObjects().length >= MAX_CHESTS) {
    setStatus('Maximum chests placed.')
    return
  }
  state.placementArmed = true
  setStatus('Tap the ground where the next chest should appear.')
}

// CHANGE 4 UX: "tap ground first, then pick content." Placement feedback is
// immediate (the chest appears right away with the default 💎), then the
// content picker sheet slides up as a lightweight follow-up the hider can
// dismiss/skip. This reads more naturally than "arm content, then tap
// ground" because the hider sees exactly which chest they're customizing.
const bindGroundPlacement = () => {
  $('th-ground').addEventListener('click', async (event) => {
    if (state.mode !== 'hide' || !state.placementArmed) return
    const point = event.detail?.intersection?.point
    if (!point) return

    state.placementArmed = false
    const objectPose = await engine.placeObject(point, {content: DEFAULT_CONTENT, contentScale: 1})
    if (!objectPose) return

    const count = engine.getObjects().length
    // Don't auto-rearm placement: each chest needs an explicit "Place chest"
    // press, so a tap on an existing chest is always a selection.
    setStatus(count < MIN_CHESTS
      ? `Chest ${count} hidden. Place at least ${MIN_CHESTS}. Tap "Place chest" to add another.`
      : `Chest ${count} hidden. Share now, or tap "Place chest" to add up to ${MAX_CHESTS}.`)
    updateCounter()
    openContentPicker(objectPose)
  })
}

// ── CHANGE 4: content picker ──────────────────────────────────────────────

const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result)
  reader.onerror = () => reject(reader.error || new Error('File read failed'))
  reader.readAsDataURL(file)
})

// Downscale + re-encode an image data URL so the shared bundle stays small.
// JPEG is re-encoded at JPEG_QUALITY; PNG is kept (for transparency) but still
// downscaled; animated GIF is kept as-is since re-encoding would drop frames
// (it just won't animate as an AR texture — acceptable per spec).
const downscaleImage = (dataUrl, mimeType) => new Promise((resolve, reject) => {
  if (mimeType === 'image/gif') {
    resolve(dataUrl)
    return
  }
  const img = new Image()
  img.onload = () => {
    const scale = Math.min(1, MAX_IMAGE_EDGE_PX / Math.max(img.width, img.height))
    const width = Math.max(1, Math.round(img.width * scale))
    const height = Math.max(1, Math.round(img.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, width, height)
    const outMime = mimeType === 'image/png' ? 'image/png' : 'image/jpeg'
    resolve(canvas.toDataURL(outMime, outMime === 'image/jpeg' ? JPEG_QUALITY : undefined))
  }
  img.onerror = () => reject(new Error('Image decode failed'))
  img.src = dataUrl
})

const setPickerTab = (kind) => {
  state.pickerKind = kind
  document.querySelectorAll('.th-content-tab').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.kind === kind))
  })
  setHidden('th-content-pane-emoji', kind !== 'emoji')
  setHidden('th-content-pane-image', kind !== 'image')
  setHidden('th-content-pane-glb', kind !== 'glb')
}

const openContentPicker = (objectPose) => {
  state.pendingPlacementPoint = objectPose
  setPickerTab('emoji')
  $('th-glb-warning').hidden = true
  $('th-image-input').value = ''
  $('th-glb-input').value = ''
  $('th-content-picker').classList.remove('th-collapsed') // always open expanded
  setHidden('th-content-picker', false)
  // Focused sub-task: hide the main control panel so the placement panels don't
  // stack on top of it at the bottom of the screen (body.th-placing, CSS).
  document.body.classList.add('th-placing')
}

const closeContentPicker = () => {
  state.pendingPlacementPoint = null
  setHidden('th-content-picker', true)
  document.body.classList.remove('th-placing')
}

// Re-renders the just-placed chest in place so its content preview/visual
// state stays consistent after the picker updates objectPose.content.
const refreshChestContent = (objectPose) => {
  const entry = state.chests.get(objectPose.id)
  if (entry) entry.objectPose = objectPose
}

const confirmContentPicker = async () => {
  const objectPose = state.pendingPlacementPoint
  if (!objectPose) return

  try {
    if (state.pickerKind === 'emoji') {
      const typed = $('th-emoji-input').value.trim()
      objectPose.content = {kind: 'emoji', data: typed || state.pickerEmoji || DEFAULT_CONTENT.data}
    } else if (state.pickerKind === 'image') {
      const file = $('th-image-input').files?.[0]
      if (!file) {
        showToast('Choose an image first, or use default.', 1800)
        return
      }
      const rawDataUrl = await readFileAsDataUrl(file)
      const resized = await downscaleImage(rawDataUrl, file.type)
      objectPose.content = {kind: 'image', data: resized}
    } else if (state.pickerKind === 'glb') {
      const file = $('th-glb-input').files?.[0]
      if (!file) {
        showToast('Choose a .glb file first, or use default.', 1800)
        return
      }
      const dataUrl = await readFileAsDataUrl(file)
      objectPose.content = {kind: 'glb', data: dataUrl}
    }
  } catch (error) {
    showToast(`Content failed to load: ${error.message}`, 2200)
    return
  }

  // Mutating objectPose in place is sufficient: engine.getObjects() returns
  // the same array/reference this object lives in, so buildBundle() (and
  // therefore shareHunt) picks up the updated content without any extra
  // engine persistence call (no engine API is exposed for that — see
  // CONSTRAINTS: only the additive placeObject metadata param is allowed).
  refreshChestContent(objectPose)
  closeContentPicker()
  showToast('Chest content saved.', 1600)
}

const skipContentPicker = () => {
  const objectPose = state.pendingPlacementPoint
  if (objectPose) {
    objectPose.content = DEFAULT_CONTENT
    refreshChestContent(objectPose)
  }
  closeContentPicker()
}

const bindContentPicker = () => {
  document.querySelectorAll('.th-content-tab').forEach((tab) => {
    tab.addEventListener('click', () => setPickerTab(tab.dataset.kind))
  })
  document.querySelectorAll('.th-emoji-choice').forEach((choice) => {
    choice.addEventListener('click', () => {
      document.querySelectorAll('.th-emoji-choice').forEach((other) => other.setAttribute('aria-pressed', 'false'))
      choice.setAttribute('aria-pressed', 'true')
      state.pickerEmoji = choice.textContent
      $('th-emoji-input').value = ''
    })
  })
  $('th-glb-input').addEventListener('change', () => {
    const file = $('th-glb-input').files?.[0]
    $('th-glb-warning').hidden = !file || file.size <= GLB_WARN_BYTES
  })
  $('th-content-confirm').addEventListener('click', confirmContentPicker)
  $('th-content-skip').addEventListener('click', skipContentPicker)
}

// ── CHANGE 5: chest fine-tune (position / Y-rotation / scale) ────────────

const updateAdjustSummary = (objectPose) => {
  const rotationY = Math.round(objectPose.rotationY || 0)
  const scale = (objectPose.scale || 1).toFixed(1)
  const contentScale = (objectPose.contentScale || 1).toFixed(1)
  $('th-adjust-summary').textContent = `rot ${rotationY}° · scale ${scale}× · content ${contentScale}×`
}

// While a chest is selected in the adjust panel, show
// a live, semi-transparent preview of its actual content (image/emoji/glb) at
// the chest, so the master can see what will be revealed and at what size.
// The preview lives under a dedicated wrapper class so it's easy to find and
// tear down without touching the real chest-model/reveal subtrees.
const removeChestPreview = (entry) => {
  if (!entry) return
  entry.entity.querySelector('.th-content-preview')?.remove()
  entry.entity.querySelector('.th-chest-highlight')?.remove()
}

// Pulsing wireframe cage around the chest currently being edited, so it's clear
// which one is selected. A wireframe box reads as a selection outline without a
// post-process outline shader (hard to wire into the 8th Wall render loop). It
// is a child of entry.entity, so it inherits the chest's scale.
const addChestHighlight = (entry) => {
  const box = document.createElement('a-box')
  box.classList.add('th-chest-highlight')
  box.setAttribute('width', 0.62)
  box.setAttribute('height', 0.64)
  box.setAttribute('depth', 0.62)
  box.setAttribute('position', '0 0.32 0')
  box.setAttribute('material', 'color: #ffd873; shader: flat; wireframe: true; transparent: true; opacity: 0.85')
  box.setAttribute('animation__pulse', 'property: scale; from: 1 1 1; to: 1.07 1.07 1.07; dir: alternate; dur: 640; loop: true; easing: easeInOutSine')
  entry.entity.appendChild(box)
}

// Applies contentScale as the preview WRAPPER's scale (rather than baking it
// into the reveal geometry), so live content-scale changes only touch this
// scale attribute. Rebuilding the reveal each slider tick regenerated the emoji
// canvas texture and made the preview flicker instead of showing the content.
const applyPreviewContentScale = (entry) => {
  const s = entry?.objectPose?.contentScale || 1
  entry?.entity?.querySelector('.th-content-preview')?.setAttribute('scale', `${s} ${s} ${s}`)
}

const buildChestPreview = (entry) => {
  removeChestPreview(entry)
  const wrapper = document.createElement('a-entity')
  wrapper.classList.add('th-content-preview')
  // Built at base size (contentScale = 1); the wrapper scale carries contentScale.
  wrapper.appendChild(buildRevealEntity(entry.objectPose.content, 1, {translucent: true}))
  entry.entity.appendChild(wrapper)
  applyPreviewContentScale(entry)
  addChestHighlight(entry)
}

// Re-renders the preview at the currently-selected chest, if any — called
// whenever contentScale (or the underlying content) changes while the adjust
// panel is open, so the ghost preview always matches the live slider value.

// Selects a placed chest in hide mode and reveals the adjust panel. Hidden by
// default; only visible while a chest is selected. Selecting a different
// chest (or none) just re-targets the same panel instance. The rotation/scale
// sliders are synced to reflect this chest's current values on open, since
// they are now absolute-value inputs shared across all chests.
const selectChestForAdjust = (objectId) => {
  const entry = state.chests.get(objectId)
  if (!entry) return
  // Only one placement panel at a time: dismiss an open (or collapsed) content
  // picker so its bar doesn't linger and overlap the adjust panel / main UI.
  closeContentPicker()
  // Deselecting a previously-selected chest first removes its preview so two
  // ghost previews never coexist when the master taps a different chest.
  const previous = getSelectedChestEntry()
  if (previous && previous !== entry) removeChestPreview(previous)
  state.selectedChestId = objectId
  $('th-adjust-rot-slider').value = String(entry.objectPose.rotationY || 0)
  $('th-adjust-scale-slider').value = String(entry.objectPose.scale || 1)
  $('th-adjust-content-slider').value = String(entry.objectPose.contentScale || 1)
  updateAdjustSummary(entry.objectPose)
  buildChestPreview(entry)
  $('th-adjust-panel').classList.remove('th-collapsed') // always open expanded
  setHidden('th-adjust-panel', false)
  document.body.classList.add('th-placing')
}

const deselectChestForAdjust = () => {
  const entry = getSelectedChestEntry()
  removeChestPreview(entry)
  state.selectedChestId = null
  setHidden('th-adjust-panel', true)
  document.body.classList.remove('th-placing')
}

const getSelectedChestEntry = () => {
  if (!state.selectedChestId) return null
  return state.chests.get(state.selectedChestId) || null
}

// Applies a mutation to the selected chest's objectPose + live A-Frame entity,
// then persists the fields that must survive into the shared bundle:
//   - objectPose.pose (world position) — recomputed mapLocalPose so the
//     SEEKER (who re-derives position via poseFromObject/mapLocalPose) sees
//     the corrected spot too.
//   - objectPose.rotationY / objectPose.scale — read back by createChest()
//     for both hide and seek rendering.
// `mutate(pose)` mutates `pose` (a shallow copy of objectPose.pose) in place
// for position nudges; rotation/scale calls skip that and pass null.
const applyChestAdjustment = (mutate) => {
  const entry = getSelectedChestEntry()
  if (!entry) return
  const {objectPose} = entry

  if (mutate) {
    const nextPose = {...objectPose.pose}
    mutate(nextPose)
    objectPose.pose = nextPose
    entry.pose = nextPose
    // Recompute mapLocalPose so the seeker (which renders via
    // poseFromObject/mapLocalPose, not the raw world pose) picks up the move.
    // getMapLocalPose is an existing exported engine getter — no core change
    // needed here (see CONSTRAINTS).
    objectPose.mapLocalPose = engine.getMapLocalPose(nextPose)
    entry.entity.setAttribute('position', `${nextPose.x} ${nextPose.y} ${nextPose.z}`)
  } else {
    entry.entity.setAttribute('rotation', `0 ${objectPose.rotationY || 0} 0`)
    const scale = objectPose.scale || 1
    entry.entity.setAttribute('scale', `${scale} ${scale} ${scale}`)
  }

  updateAdjustSummary(objectPose)
}

const nudgeSelectedChest = (axis, delta) => {
  // Position nudges depend on the live world pose (mapLocalPose is recomputed
  // from the current session's coordinate frame — see applyChestAdjustment),
  // so when editing an existing hunt this is gated behind relocalization just
  // like placing a new chest. Rotation/scale/content edits are NOT gated —
  // they don't depend on world pose at all.
  if (state.editing && !state.relocalized) {
    showToast('Align to the map before moving chests.', 2000)
    return
  }
  applyChestAdjustment((pose) => {
    pose[axis] = (pose[axis] || 0) + delta
  })
}

// Rotation/scale setters take the range slider's absolute value.
const setSelectedChestRotation = (rotationDegrees) => {
  const entry = getSelectedChestEntry()
  if (!entry) return
  entry.objectPose.rotationY = ((rotationDegrees % 360) + 360) % 360
  applyChestAdjustment(null)
}

const setSelectedChestScale = (scale) => {
  const entry = getSelectedChestEntry()
  if (!entry) return
  entry.objectPose.scale = Math.min(ADJUST_SCALE_MAX, Math.max(ADJUST_SCALE_MIN, scale))
  applyChestAdjustment(null)
}

// Content size scales ONLY the revealed content relative to
// the chest (CHEST_MATCH_SIZE * contentScale), independent of the chest's own
// objectPose.scale slider above. Persisted on objectPose so it travels in the
// shared bundle and is read back by buildRevealEntity on both hide (preview)
// and seek (actual reveal) sides.
const setSelectedChestContentScale = (contentScale) => {
  const entry = getSelectedChestEntry()
  if (!entry) return
  entry.objectPose.contentScale = Math.min(CONTENT_SCALE_MAX, Math.max(CONTENT_SCALE_MIN, contentScale))
  updateAdjustSummary(entry.objectPose)
  applyPreviewContentScale(entry) // scale only — no rebuild, no texture flicker
}

const bindAdjustPanel = () => {
  $('th-adjust-x-neg').addEventListener('click', () => nudgeSelectedChest('x', -ADJUST_POSITION_STEP))
  $('th-adjust-x-pos').addEventListener('click', () => nudgeSelectedChest('x', ADJUST_POSITION_STEP))
  $('th-adjust-z-neg').addEventListener('click', () => nudgeSelectedChest('z', -ADJUST_POSITION_STEP))
  $('th-adjust-z-pos').addEventListener('click', () => nudgeSelectedChest('z', ADJUST_POSITION_STEP))
  $('th-adjust-y-neg').addEventListener('click', () => nudgeSelectedChest('y', -ADJUST_POSITION_STEP))
  $('th-adjust-y-pos').addEventListener('click', () => nudgeSelectedChest('y', ADJUST_POSITION_STEP))
  // Live-update on 'input' (not 'change') so the chest visibly rotates
  // / rescales as the user drags the slider, not only on release.
  $('th-adjust-rot-slider').addEventListener('input', (event) => {
    setSelectedChestRotation(Number(event.target.value))
  })
  $('th-adjust-scale-slider').addEventListener('input', (event) => {
    setSelectedChestScale(Number(event.target.value))
  })
  $('th-adjust-content-slider').addEventListener('input', (event) => {
    setSelectedChestContentScale(Number(event.target.value))
  })
  $('th-adjust-done').addEventListener('click', deselectChestForAdjust)
}

// Re-shares an already-published hunt back to its OWN code (overwrite, not a
// new code) — the GPS spot for that code was registered when it was first
// shared and is left completely untouched here; only the map bundle (chests/
// map/keyframes) is updated.
const updateHunt = async () => {
  const count = engine.getObjects().length
  if (!engine.getMap() || count < MIN_CHESTS) {
    setStatus(`Hide at least ${MIN_CHESTS} chests before updating.`)
    return
  }

  $('th-share').disabled = true
  setStatus('Updating hunt...')
  try {
    await updateMapBundle(state.editingCode, engine.buildBundle(VERSION))
  } catch (error) {
    setStatus(`Update failed: ${error.message}`)
    $('th-share').disabled = false
    return
  }

  const code = state.editingCode
  $('th-code').textContent = code
  setHidden('th-code-wrap', false)
  $('th-share-note').textContent = 'Hunt updated — same code, spot unchanged.'
  activateHuntLiveBar(code)
  setStatus(`Hunt updated: ${code}`)
  $('th-share').disabled = false
}

const shareHunt = async () => {
  // Editing an existing hunt re-shares to the SAME code (overwrite) instead
  // of minting a new one — branch here rather than duplicating the button's
  // click binding so bindUi() stays a single wire-up per control.
  if (state.editing) {
    await updateHunt()
    return
  }

  const count = engine.getObjects().length
  if (!engine.getMap() || count < MIN_CHESTS) {
    setStatus(`Hide at least ${MIN_CHESTS} chests before sharing.`)
    return
  }

  $('th-share').disabled = true
  setStatus('Uploading hunt...')
  let code = ''
  try {
    code = await shareMapBundle(engine.buildBundle(VERSION))
  } catch (error) {
    setStatus(`Share failed: ${error.message}`)
    $('th-share').disabled = false
    return
  }

  $('th-code').textContent = code
  setHidden('th-code-wrap', false)
  $('th-share-note').textContent = 'Code shared. Registering GPS spot...'
  activateHuntLiveBar(code)

  try {
    const gps = await getCurrentGps({timeoutMs: 8000})
    const defaultName = `Treasure hunt ${code}`
    const name = window.prompt('Spot name', defaultName) || defaultName
    await registerSpot({code, name, lat: gps.lat, lng: gps.lng})
    $('th-share-note').textContent = `GPS spot registered as "${name}".`
    setStatus(`Hunt shared: ${code}`)
  } catch (error) {
    $('th-share-note').textContent = `Code works. GPS spot was not registered: ${error.message}`
    setStatus(`Hunt shared: ${code}. GPS spot skipped.`)
  } finally {
    $('th-share').disabled = false
  }
}

// Collapse the hide panel into a compact "hunt live" bar once a code has been
// shared, so the flow doesn't dead-end on the share panel.
const activateHuntLiveBar = (code) => {
  state.huntShared = true
  setHidden('th-hide-panel', true)
  $('th-live-code').textContent = code
  $('th-live-chest-count').textContent = `${engine.getObjects().length} chests hidden`
  setHidden('th-hunt-live-bar', false)
}

const copyHuntCode = async () => {
  const code = $('th-live-code').textContent.trim()
  if (!code) return
  try {
    await navigator.clipboard.writeText(code)
    showToast('Code copied.', 1400)
  } catch {
    showToast('Copy failed — copy it manually.', 1800)
  }
}

const renderSpots = (spots, emptyMessage = 'No nearby spots found. Enter a code manually.') => {
  const list = $('th-spots')
  list.innerHTML = ''

  if (!spots.length) {
    list.textContent = emptyMessage
    return
  }

  state.selectedSpotCode = spots[0].code
  spots.forEach((spot, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'th-spot'
    button.dataset.code = spot.code
    const name = document.createElement('span')
    const distance = document.createElement('span')
    name.textContent = spot.name || spot.code
    distance.textContent = `${spot.distanceMeters ?? '?'}m`
    button.append(name, distance)
    button.addEventListener('click', () => loadHuntCode(spot.code))
    if (index === 0) button.setAttribute('aria-current', 'true')
    list.appendChild(button)
  })
}

async function refreshNearbySpots() {
  $('th-refresh-spots').disabled = true
  try {
    const gps = await getCurrentGps({timeoutMs: 8000})
    const spots = await fetchSpots()
    renderSpots(findNearbySpots(gps, spots, {limit: 8}))
    setStatus('Nearby hunts loaded. Tap a spot or enter a code.')
  } catch (error) {
    // Friendlier copy for the common failure case (e.g. a 401 from the spots
    // backend) — point the user straight at the manual code input instead of
    // surfacing the raw error message. The network/Firebase call itself is
    // unchanged; only this fallback message differs.
    renderSpots([], 'Nearby search unavailable — enter a hunt code manually.')
    setStatus('Nearby search unavailable — enter a hunt code manually.')
  } finally {
    $('th-refresh-spots').disabled = false
  }
}

async function loadHuntCode(code) {
  const cleaned = code.trim()
  if (cleaned.length < 4) {
    setStatus('Enter a valid hunt code.')
    return
  }

  setStatus(`Downloading hunt ${cleaned}...`)
  try {
    const bundle = await downloadMapBundle(cleaned)
    engine.applyBundle(bundle, cleaned)
    setStatus('Hunt loaded. Match the guide thumbnail, then tap Align.')
    // Once a hunt is loaded, the code-entry/spot-list UI is no longer needed —
    // hiding it keeps the camera view unobstructed while the seeker aligns.
    setHidden('th-seek-panel', true)
    setHidden('th-seek-back', false)
    showGuide()
  } catch (error) {
    setStatus(`Load failed: ${error.message}`)
  }
}

// Abandon the currently loaded hunt and return to code entry, in case the
// wrong code/spot was loaded.
const backToCodeEntry = async () => {
  hideGuide()
  setHidden('th-seek-back', true)
  await engine.clearAll()
  state.relocalized = false
  state.huntStartedToastShown = false
  clearChestRoot()
  setHuntHud('')
  setHidden('th-seek-panel', false)
  setStatus('Enter a hunt code, or search nearby hunts via GPS.')
}

// Align auto-retries on a short interval until it succeeds or
// times out, so the user can slowly sweep the phone to match the reference
// instead of tapping repeatedly. A minimal spinner on the dock shows progress;
// state.aligning guards against overlapping loops. onRelocalized clears the
// guide/dock on success, so success is detected via getLastRelocalization().
const ALIGN_RETRY_INTERVAL_MS = 1100
const ALIGN_TIMEOUT_MS = 18000

const setAligningUI = (active) => {
  const dock = $('th-align-dock')
  if (dock) dock.classList.toggle('th-aligning', active)
  $('th-align').disabled = active
  const hint = $('th-align-hint')
  if (hint) hint.textContent = active ? 'Aligning…' : 'Match the reference, then align.'
}

const alignHunt = async () => {
  if (!engine.getMap()) {
    setStatus('Load a hunt first.')
    return
  }
  if (state.aligning) return // a retry loop is already running

  state.aligning = true
  setAligningUI(true)
  const startedAt = Date.now()

  while (state.aligning && Date.now() - startedAt < ALIGN_TIMEOUT_MS) {
    const result = await engine.relocalize()
    if (result?.relocalization || engine.getLastRelocalization()) {
      state.aligning = false
      setAligningUI(false)
      return // onRelocalized handles guide/dock hide + chest render
    }
    // Wait before the next sweep attempt (unless cancelled meanwhile).
    await new Promise((resolve) => setTimeout(resolve, ALIGN_RETRY_INTERVAL_MS))
  }

  // Timed out (or cancelled): let the user re-aim and tap again.
  state.aligning = false
  setAligningUI(false)
  showGuide()
  setStatus('Alignment timed out. Re-aim at the reference and tap Align.')
}

const bindUi = () => {
  $('th-start-hide').addEventListener('click', startHideMode)
  $('th-start-seek').addEventListener('click', startSeekMode)
  $('th-edit-load').addEventListener('click', () => startEditHunt($('th-edit-code-input').value))
  $('th-scan').addEventListener('click', toggleScan)
  $('th-build').addEventListener('click', buildMap)
  $('th-place').addEventListener('click', armPlacement)
  $('th-share').addEventListener('click', shareHunt)
  $('th-refresh-spots').addEventListener('click', refreshNearbySpots)
  $('th-load-code').addEventListener('click', () => loadHuntCode($('th-code-input').value))
  $('th-align').addEventListener('click', alignHunt)
  $('th-play-again').addEventListener('click', startNewHunt)
  $('th-new-hunt').addEventListener('click', startNewHunt)
  $('th-live-copy').addEventListener('click', copyHuntCode)
  $('th-seek-back').addEventListener('click', backToCodeEntry)
  $('th-align-guide-img').addEventListener('click', toggleGuideSize)
  // Inline collapse handle on each placement panel: taps toggle the panel
  // between full and a slim handle-only bar so the AR placement spot behind it
  // stays visible without a separate floating button covering other UI.
  document.querySelectorAll('.th-collapse-handle').forEach((handle) => {
    handle.addEventListener('click', () => {
      handle.closest('.th-content-picker, .th-adjust-panel')?.classList.toggle('th-collapsed')
    })
  })
  bindGroundPlacement()
  bindContentPicker()
  bindAdjustPanel()
}

// Register only once — this module can run again if the scene is re-mounted.
const registerBillboardComponent = () => {
  if (AFRAME.components['th-billboard']) return
  AFRAME.registerComponent('th-billboard', {
    tick() {
      const cameraEl = document.getElementById('camera')
      const cameraObject = cameraEl?.object3D
      if (!cameraObject) return
      const cameraWorldPos = cameraObject.getWorldPosition(new THREE.Vector3())
      const selfWorldPos = this.el.object3D.getWorldPosition(new THREE.Vector3())
      // Y-axis-only billboard: face the camera on the horizontal plane, which
      // is enough for planes/most revealed content (images, emoji, models)
      // without introducing an unnatural tilt.
      const angle = Math.atan2(
        cameraWorldPos.x - selfWorldPos.x,
        cameraWorldPos.z - selfWorldPos.z,
      )
      this.el.object3D.rotation.y = angle
    },
  })
}

export const startTreasureHunt = () => {
  registerBillboardComponent()
  engine = createEngine()
  bindUi()
  updateCounter()

  // Keep the overlay UI hidden until 8th Wall reports the camera/AR pipeline is
  // running ('realityready'). The start screen + HUD are shown on load and,
  // being fixed high-z-index overlays, would otherwise cover the landing-page
  // "tap to start" prompt and block the camera-permission request on first load
  // (the user then sees the menu but the AR camera never opens). A fallback
  // timer reveals the UI anyway if the event never fires (e.g. desktop / no
  // camera).
  const arScene = document.querySelector('a-scene')
  const revealUi = () => document.body.classList.add('th-ar-ready')
  if (arScene) {
    arScene.addEventListener('realityready', revealUi, {once: true})
    window.setTimeout(revealUi, 8000)
  } else {
    revealUi()
  }
}
