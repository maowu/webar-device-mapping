# WebAR Device Mapping

Self-hosted, lightweight **cross-session and cross-device relocalization for WebAR**.
Scan a space once on a phone, then restore placed AR objects later — on the same
phone or on someone else's — without any cloud VPS service.

Built as a practical replacement for the discontinued 8th Wall VPS, on top of
8th Wall's open `xrweb` world tracking, with a custom-trimmed OpenCV.js build
running entirely in the mobile browser.

> Demo video / GIF: _add a link here_

---

## Highlights

- **No SLAM rebuild, just alignment.** 8th Wall already provides a metric,
  gravity-aligned camera pose every frame; only its world origin changes per
  session. The engine estimates the single rigid transform `T : M → S` from the
  mapping frame `M` to the current session frame `S`. Gravity alignment reduces
  it from 6-DoF to **4-DoF (yaw + translation)**.
- **Classical CV pipeline in the browser.** CLAHE-normalized grayscale → ORB
  features → brute-force Hamming kNN matching with ratio test → RANSAC
  homography / essential-matrix checks → ray triangulation of 3D map points →
  `solvePnPRansac` against the global map, gated by reprojection error.
- **Keyframe map.** Up to 200 auto-captured keyframes with ORB descriptors,
  compact image embeddings for retrieval, and triangulated 3D map points, stored
  in IndexedDB so scanning, mapping, and single-device relocalization work
  offline.
- **Small enough for mobile web.** A purpose-trimmed OpenCV.js build keeps only
  the APIs the engine uses: the production chunk is **~3.07 MB raw
  (889,604 bytes gzip -9)**, down from ~15.1 MB for the full build, and is
  lazy-loaded on first scan or relocalization.
- **Share by code.** A map bundle (keyframes, map points, placed objects, one
  alignment photo) is compressed (base64 descriptors, int8 embeddings) and
  shared through a 4–6 character code, or exported as a JSON file.
- **Reusable engine.** `createMappingEngine()` in
  `src/components/device-mapping-core/` is UI-agnostic. Two experiences use it
  unchanged and only supply different callbacks.

## Experiences

| Experience | Route | Purpose |
|------------|-------|---------|
| **Device Mapping MVP** | `/samples/device-mapping/` | Core tool: scan → build map → place objects → relocalize + share. |
| **AR Treasure Hunt** | `/games/ar-treasure-hunt/` | Multi-device game POC: one phone hides AR chests, another finds them by code. |

---

## 1. Install & run

```bash
npm install
cp .env.example .env       # then set FIREBASE_DATABASE_URL (see §2)
npm run serve              # HTTPS dev server
```

Open the printed **LAN https URL on a phone** (AR needs a real camera;
localhost on desktop only shows the landing page). For a public link, use a
tunnel such as ngrok.

Production build:

```bash
npm run build              # → dist/ (static; deploy anywhere)
node serve-dist.js         # optional: preview dist at http://localhost:8123/
```

Requirements: Node.js ≥ 18, and a phone with a camera over HTTPS.

---

## 2. Firebase setup (only needed for sharing)

Map sharing and GPS "nearby" spots use a Firebase **Realtime Database** as a
plain key-value relay (no server code). Single-device use works without it.

1. Create a Firebase project and a Realtime Database.
2. Put its URL in `.env` (git-ignored):
   ```bash
   FIREBASE_DATABASE_URL=https://<your-project>-default-rtdb.<region>.firebasedatabase.app
   ```
   Only this one whitelisted key is injected into the client bundle at build time.
3. Deploy the security rules in [`database.rules.json`](database.rules.json)
   (Firebase console → Realtime Database → Rules, or `firebase deploy --only database`).

What the bundled rules do:

- Deny everything by default; the root and the `/maps` list cannot be read.
- `/maps/{code}`: readable and writable only by someone who knows the code;
  must contain `createdAt`; maps cannot be deleted from the client.
- `/spots`: listable (needed for "nearby" discovery); each entry is validated
  (code matches the key, name ≤ 80 chars, valid lat/lng).

> **Note:** there is no user authentication, so anyone who knows a code can
> overwrite that map or spot. That is fine for demos and events. For
> production, add Firebase Anonymous Auth and store an owner `uid` per record.

A map share is one JSON record at `/maps/{code}`. GPS spots (optional) live at
`/spots/{code}`.

---

## 3. Device Mapping MVP: how to use

Open `/samples/device-mapping/` on the phone.

**Build a map & place objects (phone A)**
1. Tap **Scan** (the red dot blinks while recording).
2. Walk around the target; the scan-assist HUD reports coverage and move/rotate speed.
3. Tap **Stop** → confirm **Build map now?** The map builds and relocalizes once.
4. Tap the ground to place test objects.
5. Share: **Export file** (downloads JSON) or **Generate code** (uploads to Firebase).

**Relocalize from another phone (phone B)**
1. **Join** (enter the code) or **Import file**.
2. Match the ghost reference photo to align your viewing angle.
3. Tap **Relocalize**. Objects reappear in place.

The **More** drawer has debug tools: ORB feature overlay, colored map-point
cloud, diagnostic-log export, and clear-local-data.

---

## 4. AR Treasure Hunt: how to play

Open `/games/ar-treasure-hunt/` on the phone.

**Hide (phone A: "Hide treasure")**
1. Scan the room → Stop → **Build map**.
2. Tap the ground to place 3–5 chests (press **Place chest** for each).
3. Customize each chest: emoji, uploaded image, or `.glb` model.
4. Optional: tap a chest to fine-tune position, rotation, scale, and content size.
5. **Share hunt** → get a code → optionally register a GPS spot for "nearby" discovery.
6. Later, **Edit a hunt** with the same code and **Update hunt** (same code, no new spot).

**Seek (phone B: "Seek treasure")**
1. Choose **Seek treasure** (no GPS permission required).
2. Enter the code to **Load**, or **Refresh nearby spots** to find hunts by GPS.
3. Match the ghost reference photo (tap the top-right preview to enlarge).
4. Tap **Align**. Chests appear at their placed positions.
5. Tap a chest to open it (light/particle effects and haptics); collect all to win.

A share code always works on its own. GPS only powers "nearby" discovery, so
indoor or single-venue setups can skip it.

---

## 5. Custom OpenCV.js build

Both experiences load the checked-in, trimmed build
`scripts/opencv-slim-build/opencv-slim-candidate.js` (built from OpenCV 4.14.0)
instead of the full npm package. The whitelist in
`scripts/opencv-slim-build/opencv_js_slim.config.py` keeps only `core`,
`imgproc` (cvtColor, CLAHE), `features2d` (ORB, BFMatcher) and `calib3d`
(solvePnP / solvePnPRansac, findEssentialMat / recoverPose, findHomography,
Rodrigues, projectPoints).

Check the API surface and pose bindings:

```bash
npm run test:opencv
```

---

## 6. Project structure

```
src/
  components/device-mapping-core/   # UI-agnostic engine
    engine.js           # keyframes, triangulation, map building, relocalization, 4-DoF alignment
    feature-matcher.js  # OpenCV.js: ORB, matching, homography, essential matrix, PnP
    vision.js           # camera capture and image embeddings for keyframe retrieval
    share.js            # bundle compression + Firebase / file transport
    spots.js            # optional GPS spots
    storage.js          # IndexedDB persistence
  samples/device-mapping/           # Device Mapping MVP UI
  games/ar-treasure-hunt/           # AR Treasure Hunt UI
  landing/                          # landing page (cards from experiences.config.js)
scripts/opencv-slim-build/          # trimmed OpenCV.js + smoke test
external/                           # 8th Wall engine and helpers (third-party)
config/                             # webpack build (adapted from the 8th Wall template)
database.rules.json                 # Firebase Realtime Database rules
```

## Limitations

- Relocalization works best when the viewer roughly matches the reference
  photo's viewpoint; textureless or highly repetitive surfaces reduce matches.
- Accuracy depends on 8th Wall world tracking quality on the device.
- The map stores ORB descriptors and one alignment photo; treat shared codes
  as public within your event or venue.

## Credits

Designed and developed by **Wu Kuan Ying** ([portfolio](https://portfolio.mutienliao.com))
at **The Designium Inc.**, Tokyo. Published with permission.

Powered by the 8th Wall XR Engine from Niantic Spatial, Inc. This project is
not affiliated with or endorsed by Niantic Spatial. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Project source code: [MIT](LICENSE). Third-party components under `external/`,
`config/` and the bundled OpenCV.js build keep their own licenses.
