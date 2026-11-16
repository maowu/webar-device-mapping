// Injected at build time from .env (see .env.example and README §2).
// Security rules: see database.rules.json and README §2.
const FIREBASE_URL = process.env.FIREBASE_DATABASE_URL || ''

const EARTH_RADIUS_METERS = 6371000

const requireFirebaseUrl = () => {
  if (!FIREBASE_URL) throw new Error('Firebase not configured — set FIREBASE_DATABASE_URL in .env (see README §2)')
}

const toRadians = (degrees) => (degrees * Math.PI) / 180

const normalizeGps = ({lat, lng, accuracy}) => ({lat, lng, accuracy})

/**
 * Calculates the haversine distance between two GPS coordinates in meters.
 * @param {{lat: number, lng: number}} a
 * @param {{lat: number, lng: number}} b
 * @returns {number}
 */
export const haversineDistance = (a, b) => {
  const deltaLat = toRadians(b.lat - a.lat)
  const deltaLng = toRadians(b.lng - a.lng)
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)

  const h = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2

  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}


/**
 * Gets the current device GPS coordinate with high accuracy enabled.
 * @param {{timeoutMs?: number}} options
 * @returns {Promise<{lat: number, lng: number, accuracy: number}>}
 */
export const getCurrentGps = ({timeoutMs = 10000} = {}) => new Promise((resolve, reject) => {
  if (!navigator.geolocation) {
    reject(new Error('Geolocation unavailable on this device or browser'))
    return
  }

  navigator.geolocation.getCurrentPosition(
    ({coords}) => resolve(normalizeGps(coords)),
    (error) => {
      const messages = {
        [error.PERMISSION_DENIED]: 'Geolocation permission denied',
        [error.POSITION_UNAVAILABLE]: 'Geolocation position unavailable',
        [error.TIMEOUT]: 'Geolocation request timed out',
      }
      reject(new Error(messages[error.code] || `Geolocation failed: ${error.message}`))
    },
    {enableHighAccuracy: true, timeout: timeoutMs},
  )
})


/**
 * Registers a named GPS spot under a share code in Firebase.
 * @param {{code: string, name: string, lat: number, lng: number}} spot
 * @returns {Promise<{code: string, name: string, lat: number, lng: number, createdAt: string}>}
 */
export const registerSpot = async ({code, name, lat, lng}) => {
  requireFirebaseUrl()
  const spot = {code, name, lat, lng, createdAt: new Date().toISOString()}
  const res = await fetch(`${FIREBASE_URL}/spots/${code}.json`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(spot),
  })
  if (!res.ok) throw new Error(`Register spot failed: ${res.status}`)
  return spot
}

/**
 * Fetches all registered GPS spots from Firebase.
 * @returns {Promise<Array<{code: string, name: string, lat: number, lng: number, createdAt: string}>>}
 */
export const fetchSpots = async () => {
  requireFirebaseUrl()
  const res = await fetch(`${FIREBASE_URL}/spots.json`)
  if (!res.ok) throw new Error(`Fetch spots failed: ${res.status}`)
  const data = await res.json()
  if (!data) return []
  return Object.values(data).filter(Boolean)
}

/**
 * Sorts spots by distance from the user GPS coordinate and limits the result.
 * @param {{lat: number, lng: number}} userGps
 * @param {Array<{lat: number, lng: number}>} spots
 * @param {{limit?: number}} options
 * @returns {Array<object>}
 */
export const findNearbySpots = (userGps, spots, {limit = 10} = {}) => spots
  .map((spot) => ({
    ...spot,
    distanceMeters: Math.round(haversineDistance(userGps, spot)),
  }))
  .sort((a, b) => a.distanceMeters - b.distanceMeters)
  .slice(0, limit)
