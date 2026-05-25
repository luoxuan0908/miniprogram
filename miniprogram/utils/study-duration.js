const userStorage = require('./user-storage')

const PREF_KEY = 'studyDuration'
const MAX_SESSION_SECONDS = 6 * 60 * 60

const activeSessions = {}

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function normalizeSeconds(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Math.floor(numeric)
}

function normalizeDaily(daily) {
  if (!daily || typeof daily !== 'object') return {}
  return Object.keys(daily).reduce((result, key) => {
    const seconds = normalizeSeconds(daily[key])
    if (seconds > 0) result[key] = seconds
    return result
  }, {})
}

function getStoredDuration() {
  const prefs = userStorage.getPreferences()
  const stored = prefs[PREF_KEY] || {}
  const daily = normalizeDaily(stored.daily)
  const dailyTotal = Object.keys(daily).reduce((sum, key) => sum + daily[key], 0)
  const totalSeconds = Math.max(normalizeSeconds(stored.totalSeconds), dailyTotal)

  return {
    totalSeconds,
    daily,
    updatedAt: normalizeSeconds(stored.updatedAt)
  }
}

function saveDuration(duration) {
  userStorage.savePreferences({
    [PREF_KEY]: {
      totalSeconds: normalizeSeconds(duration.totalSeconds),
      daily: normalizeDaily(duration.daily),
      updatedAt: Date.now()
    }
  })
}

function startSession(pageKey) {
  if (!pageKey) return
  activeSessions[pageKey] = Date.now()
}

function stopSession(pageKey) {
  if (!pageKey || !activeSessions[pageKey]) return getDurationStats()

  const startedAt = activeSessions[pageKey]
  delete activeSessions[pageKey]

  const elapsedSeconds = Math.min(
    MAX_SESSION_SECONDS,
    Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  )
  if (elapsedSeconds < 1) return getDurationStats()

  const date = todayKey()
  const duration = getStoredDuration()
  const daily = {
    ...duration.daily,
    [date]: normalizeSeconds(duration.daily[date]) + elapsedSeconds
  }

  saveDuration({
    totalSeconds: duration.totalSeconds + elapsedSeconds,
    daily
  })

  return getDurationStats()
}

function formatDuration(seconds) {
  const safe = normalizeSeconds(seconds)
  if (safe < 60) return '<1分钟'

  const minutes = Math.floor(safe / 60)
  if (minutes < 60) return `${minutes}分钟`

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes ? `${hours}小时${restMinutes}分钟` : `${hours}小时`
}

function getDurationStats() {
  const date = todayKey()
  const duration = getStoredDuration()
  const todaySeconds = normalizeSeconds(duration.daily[date])

  return {
    todaySeconds,
    totalSeconds: duration.totalSeconds,
    todayLabel: formatDuration(todaySeconds),
    totalLabel: formatDuration(duration.totalSeconds),
    daily: duration.daily
  }
}

module.exports = {
  startSession,
  stopSession,
  getDurationStats,
  formatDuration
}
