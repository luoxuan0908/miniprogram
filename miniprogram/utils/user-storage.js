/**
 * user-storage.js - User-scoped wx.Storage helpers.
 * All per-user local data must go through the u:{openid}:* namespace.
 */

const ANONYMOUS_USER_ID = 'anonymous'
const OPENID_KEY = 'openid'
const LEGACY_PREFERENCES_KEY = 'study_preferences'
const LEGACY_PREFERENCES_CLAIM_SCOPE = 'study_preferences'
const ANONYMOUS_PREFERENCES_CLAIM_SCOPE = 'anonymous_preferences'
const PREFERENCES_KEY = 'study_preferences'
const LEGACY_UNCLAIMED_KEY = 'legacy_unclaimed'
const LEGACY_CLAIMS_KEY = 'legacy_claims'
const CLOUD_SYNC_DEBOUNCE_MS = 3000
const USER_PROFILE_KEY = 'userProfile'

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
  const anonymousKey = userKey(PREFERENCES_KEY, ANONYMOUS_USER_ID)
  const hasLegacy = hasStorageKey(LEGACY_PREFERENCES_KEY)
  const hasScoped = hasStorageKey(scopedKey)
  const hasAnonymous = targetUserId !== ANONYMOUS_USER_ID && hasStorageKey(anonymousKey)
  if (!hasLegacy && !hasAnonymous) return

  const legacyPrefs = readStorage(LEGACY_PREFERENCES_KEY, null)
  const anonymousPrefs = readStorage(anonymousKey, null)
  const canUseLegacy = !!(legacyPrefs && typeof legacyPrefs === 'object') &&
    (isAnonymousUser(targetUserId) || canClaimLegacy(LEGACY_PREFERENCES_CLAIM_SCOPE, targetUserId))
  const canUseAnonymous = !!(anonymousPrefs && typeof anonymousPrefs === 'object') &&
    canClaimLegacy(ANONYMOUS_PREFERENCES_CLAIM_SCOPE, targetUserId)

  if (!hasScoped && (canUseLegacy || canUseAnonymous)) {
    const sourcePrefs = {
      ...(canUseLegacy ? legacyPrefs : {}),
      ...(canUseAnonymous ? anonymousPrefs : {})
    }

    writeStorage(scopedKey, {
      ...sourcePrefs,
      migratedAt: now()
    })
    if (!isAnonymousUser(targetUserId)) {
      if (canUseLegacy) setLegacyClaim(LEGACY_PREFERENCES_CLAIM_SCOPE, targetUserId)
      if (canUseAnonymous) setLegacyClaim(ANONYMOUS_PREFERENCES_CLAIM_SCOPE, targetUserId)
      schedulePreferencesSync(targetUserId)
    }
    return
  }

  if (!isAnonymousUser(targetUserId)) {
    const legacyClaimedBy = getLegacyClaim(LEGACY_PREFERENCES_CLAIM_SCOPE)
    const anonymousClaimedBy = getLegacyClaim(ANONYMOUS_PREFERENCES_CLAIM_SCOPE)
    markLegacyUnclaimed(targetUserId, {
      preferences: hasLegacy && legacyClaimedBy !== targetUserId,
      anonymousPreferences: hasAnonymous && anonymousClaimedBy !== targetUserId
    })
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
      success: res => {
        const result = res.result || {}
        if (!result.success) {
          reject(new Error(result.error || '偏好同步失败'))
          return
        }
        resolve(result)
      },
      fail: err => reject(err)
    })
  })
}

// ==================== 用户资料管理 ====================

/**
 * 获取本地缓存的用户资料
 * @returns {{ nickName?: string, avatarUrl?: string }}
 */
function getUserProfile() {
  return getUserStorageSync(USER_PROFILE_KEY, {}) || {}
}

/**
 * 保存用户资料到本地缓存 + 云数据库
 * @param {{ nickName?: string, avatarUrl?: string }} profile
 */
function saveUserProfile(profile) {
  const userId = getActiveUserId()
  if (isAnonymousUser(userId)) return

  const existing = getUserProfile()
  const updated = {
    ...existing,
    ...profile,
    updatedAt: Date.now()
  }
  setUserStorageSync(USER_PROFILE_KEY, updated, userId)

  // 同步到云数据库 userProfiles 集合
  if (wx.cloud && wx.cloud.database) {
    const db = wx.cloud.database()
    db.collection('userProfiles').doc(userId).get().then(res => {
      if (res.data) {
        // 已存在，更新
        db.collection('userProfiles').doc(userId).update({
          data: {
            nickName: updated.nickName || '',
            avatarUrl: updated.avatarUrl || '',
            updatedAt: db.serverDate()
          }
        }).catch(err => console.error('更新云端用户资料失败', err))
      }
    }).catch(() => {
      // 不存在，创建
      db.collection('userProfiles').add({
        data: {
          _id: userId,
          nickName: updated.nickName || '',
          avatarUrl: updated.avatarUrl || '',
          updatedAt: db.serverDate()
        }
      }).catch(err => console.error('创建云端用户资料失败', err))
    })
  }
}

/**
 * 从云数据库加载用户资料到本地缓存
 * @returns {Promise<{ nickName?: string, avatarUrl?: string }>}
 */
function loadUserProfileFromCloud() {
  return new Promise((resolve) => {
    const userId = getActiveUserId()
    if (isAnonymousUser(userId) || !wx.cloud || !wx.cloud.database) {
      resolve(getUserProfile())
      return
    }

    const db = wx.cloud.database()
    db.collection('userProfiles').doc(userId).get().then(res => {
      if (res.data) {
        const profile = {
          nickName: res.data.nickName || '',
          avatarUrl: res.data.avatarUrl || ''
        }
        setUserStorageSync(USER_PROFILE_KEY, profile, userId)
        resolve(profile)
      } else {
        resolve(getUserProfile())
      }
    }).catch(() => {
      resolve(getUserProfile())
    })
  })
}

/**
 * 上传头像到云存储
 * @param {string} tempFilePath - 临时文件路径（从 chooseAvatar 获取）
 * @returns {Promise<string>} 云存储 fileID
 */
function uploadAvatar(tempFilePath) {
  const userId = getActiveUserId()
  const ext = tempFilePath.match(/\.\w+$/)?.[0] || '.png'
  const cloudPath = `avatars/${userId}${ext}`

  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath,
      filePath: tempFilePath,
      success: res => {
        resolve(res.fileID)
      },
      fail: err => {
        console.error('头像上传失败', err)
        reject(err)
      }
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
  syncPreferences,

  // 用户资料管理
  getUserProfile,
  saveUserProfile,
  loadUserProfileFromCloud,
  uploadAvatar
}
