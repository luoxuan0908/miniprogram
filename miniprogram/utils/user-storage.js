/**
 * user-storage.js - User-scoped wx.Storage helpers.
 * All per-user local data must go through the u:{openid}:* namespace.
 */

const ANONYMOUS_USER_ID = 'anonymous'
const OPENID_KEY = 'openid'
const LEGACY_PREFERENCES_KEY = 'study_preferences'
const LEGACY_PREFERENCES_CLAIM_SCOPE = 'study_preferences'
const PREFERENCES_KEY = 'study_preferences'
const LEGACY_UNCLAIMED_KEY = 'legacy_unclaimed'
const LEGACY_CLAIMS_KEY = 'legacy_claims'
const CLOUD_SYNC_DEBOUNCE_MS = 3000

let preferencesSyncTimer = null

function now() {
  return Date.now()
}

function readStorage(key, fallback) {
  try {
    const value = wx.getStorageSync(key)
    return value === undefined || value === null || value === '' ? fallback : value
  } catch (e) {
    return fallback
  }
}

function writeStorage(key, value) {
  try {
    wx.setStorageSync(key, value)
    return true
  } catch (e) {
    console.error('写入本地缓存失败', key, e)
    return false
  }
}

function removeStorage(key) {
  try {
    if (typeof wx.removeStorageSync === 'function') {
      wx.removeStorageSync(key)
    }
    return true
  } catch (e) {
    console.error('删除本地缓存失败', key, e)
    return false
  }
}

function hasStorageKey(key) {
  try {
    if (typeof wx.getStorageInfoSync !== 'function') return readStorage(key, undefined) !== undefined
    const info = wx.getStorageInfoSync()
    return Array.isArray(info.keys) && info.keys.indexOf(key) !== -1
  } catch (e) {
    return readStorage(key, undefined) !== undefined
  }
}

function normalizeUserId(userId) {
  const value = String(userId || '').trim()
  return value || ANONYMOUS_USER_ID
}

function getActiveUserId() {
  return normalizeUserId(readStorage(OPENID_KEY, ANONYMOUS_USER_ID))
}

function isAnonymousUser(userId) {
  return normalizeUserId(userId || getActiveUserId()) === ANONYMOUS_USER_ID
}

function userKey(key, userId) {
  return `u:${normalizeUserId(userId || getActiveUserId())}:${key}`
}

function getUserStorageSync(key, fallback, userId) {
  return readStorage(userKey(key, userId), fallback)
}

function setUserStorageSync(key, value, userId) {
  return writeStorage(userKey(key, userId), value)
}

function removeUserStorageSync(key, userId) {
  return removeStorage(userKey(key, userId))
}

function markLegacyUnclaimed(userId, updates) {
  const targetUserId = normalizeUserId(userId || getActiveUserId())
  const key = userKey(LEGACY_UNCLAIMED_KEY, targetUserId)
  const existing = readStorage(key, {}) || {}
  writeStorage(key, {
    ...existing,
    ...updates,
    updatedAt: now()
  })
}

function getLegacyClaim(scope) {
  const claims = readStorage(LEGACY_CLAIMS_KEY, {}) || {}
  return claims[scope] || ''
}

function setLegacyClaim(scope, userId) {
  if (!scope || isAnonymousUser(userId)) return
  const claims = readStorage(LEGACY_CLAIMS_KEY, {}) || {}
  writeStorage(LEGACY_CLAIMS_KEY, {
    ...claims,
    [scope]: normalizeUserId(userId),
    updatedAt: now()
  })
}

function canClaimLegacy(scope, userId) {
  const claimedBy = getLegacyClaim(scope)
  const targetUserId = normalizeUserId(userId || getActiveUserId())
  return !claimedBy || claimedBy === targetUserId
}

function migrateLegacyPreferences(userId) {
  const targetUserId = normalizeUserId(userId || getActiveUserId())
  const scopedKey = userKey(PREFERENCES_KEY, targetUserId)
  const hasLegacy = hasStorageKey(LEGACY_PREFERENCES_KEY)
  const hasScoped = hasStorageKey(scopedKey)
  if (!hasLegacy) return

  const legacyPrefs = readStorage(LEGACY_PREFERENCES_KEY, null)
  if (!legacyPrefs || typeof legacyPrefs !== 'object') return

  const canUseLegacy = isAnonymousUser(targetUserId) || canClaimLegacy(LEGACY_PREFERENCES_CLAIM_SCOPE, targetUserId)

  if (!hasScoped && canUseLegacy) {
    writeStorage(scopedKey, {
      ...legacyPrefs,
      migratedAt: now()
    })
    if (!isAnonymousUser(targetUserId)) {
      setLegacyClaim(LEGACY_PREFERENCES_CLAIM_SCOPE, targetUserId)
      schedulePreferencesSync(targetUserId)
    }
    return
  }

  if (!isAnonymousUser(targetUserId)) {
    const claimedBy = getLegacyClaim(LEGACY_PREFERENCES_CLAIM_SCOPE)
    markLegacyUnclaimed(targetUserId, { preferences: claimedBy !== targetUserId })
  }
}

function getPreferences(userId) {
  const targetUserId = normalizeUserId(userId || getActiveUserId())
  migrateLegacyPreferences(targetUserId)
  return getUserStorageSync(PREFERENCES_KEY, {}, targetUserId) || {}
}

function savePreferences(updates, userId) {
  const targetUserId = normalizeUserId(userId || getActiveUserId())
  const prefs = getPreferences(targetUserId)
  setUserStorageSync(PREFERENCES_KEY, {
    ...prefs,
    ...updates,
    updatedAt: now()
  }, targetUserId)
  schedulePreferencesSync(targetUserId)
}

function clearPreferencesSyncTimer() {
  if (preferencesSyncTimer) {
    clearTimeout(preferencesSyncTimer)
    preferencesSyncTimer = null
  }
}

function schedulePreferencesSync(userId) {
  const targetUserId = normalizeUserId(userId || getActiveUserId())
  if (isAnonymousUser(targetUserId)) return

  clearPreferencesSyncTimer()
  preferencesSyncTimer = setTimeout(() => {
    preferencesSyncTimer = null
    syncPreferences(targetUserId).catch(err => console.error('偏好云端同步失败', err))
  }, CLOUD_SYNC_DEBOUNCE_MS)
}

function syncPreferences(userId) {
  const targetUserId = normalizeUserId(userId || getActiveUserId())
  if (isAnonymousUser(targetUserId)) {
    return Promise.resolve({ skipped: true, reason: 'anonymous user' })
  }

  return new Promise((resolve, reject) => {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      resolve({ skipped: true, reason: 'cloud unavailable' })
      return
    }

    wx.cloud.callFunction({
      name: 'syncData',
      data: {
        ownerId: targetUserId,
        preferences: getUserStorageSync(PREFERENCES_KEY, {}, targetUserId) || {}
      },
      success: res => resolve(res.result || {}),
      fail: err => reject(err)
    })
  })
}

module.exports = {
  ANONYMOUS_USER_ID,
  LEGACY_UNCLAIMED_KEY,
  LEGACY_CLAIMS_KEY,
  readStorage,
  writeStorage,
  removeStorage,
  hasStorageKey,
  normalizeUserId,
  getActiveUserId,
  isAnonymousUser,
  userKey,
  getUserStorageSync,
  setUserStorageSync,
  removeUserStorageSync,
  markLegacyUnclaimed,
  getLegacyClaim,
  setLegacyClaim,
  canClaimLegacy,
  getPreferences,
  savePreferences,
  syncPreferences
}
