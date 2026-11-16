const LOG_KEY = 'device-mapping-diagnostics'

const safeClone = (value) => JSON.parse(JSON.stringify(value, (key, nestedValue) => {
  if (key === 'image' || key === 'embedding' || key === 'descriptors') return undefined
  if (Array.isArray(nestedValue) && nestedValue.length > 32) {
    return {
      length: nestedValue.length,
      sample: nestedValue.slice(0, 12),
    }
  }
  return nestedValue
}))

export const resetDiagnostics = (version = '') => {
  localStorage.setItem(LOG_KEY, JSON.stringify({
    version,
    startedAt: new Date().toISOString(),
    events: [],
  }))
}

export const appendDiagnostic = (type, payload = {}) => {
  const log = JSON.parse(localStorage.getItem(LOG_KEY) || '{"events":[]}')
  log.events.push({
    type,
    at: new Date().toISOString(),
    payload: safeClone(payload),
  })
  localStorage.setItem(LOG_KEY, JSON.stringify(log))
}

export const exportDiagnostics = () => {
  const log = localStorage.getItem(LOG_KEY) || '{"events":[]}'
  const blob = new Blob([JSON.stringify(JSON.parse(log), null, 2)], {type: 'application/json'})
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `device-mapping-log-${Date.now()}.json`
  link.click()
  URL.revokeObjectURL(url)
}
