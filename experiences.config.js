/**
 * experiences.config.js — single source of truth.
 * The webpack build generates one page + bundle per entry below, and the
 * landing page renders one card per entry.
 */
const experiences = [
  {
    "id": "device-mapping",
    "title": "Device Mapping MVP",
    "category": "sample",
    "tracking": "world",
    "description": "Local keyframe memory, visual retrieval, and AR object restore.",
    "icon": "📍",
    "accent": "#86efac",
    "badge": "MVP",
    "featured": true,
    "deps": {
      "components": [
        "device-mapping-core"
      ],
      "lib": [
        "opencv-loader.js"
      ],
      "runtime": [
        "scripts/opencv-slim-build"
      ]
    }
  },
  {
    "id": "ar-treasure-hunt",
    "title": "AR Treasure Hunt",
    "category": "game",
    "tracking": "world",
    "description": "Hide shared AR treasure chests, then find them from another phone.",
    "icon": "🗺️",
    "accent": "#fbbf24",
    "featured": true,
    "deps": {
      "components": [
        "device-mapping-core"
      ],
      "lib": [
        "opencv-loader.js"
      ],
      "runtime": [
        "scripts/opencv-slim-build"
      ]
    }
  }
]

const routeOf = (exp) => `${exp.category}s/${exp.id}`

module.exports = {experiences, routeOf, landing: true}
