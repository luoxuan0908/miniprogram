/**
 * resource-storage.js - User-scoped three-layer document persistence.
 * Keeps document resources separate from vocab data and stores each resource by id.
 */

const userStorage = require('./user-storage')

const LEGACY_STORAGE_KEY = 'learning_resources_v1'
const LEGACY_CLAIM_SCOPE = 'learning_resources_v1'
const ANONYMOUS_CLAIM_SCOPE = 'anonymous_resources'
const INDEX_KEY = 'resource_index'
const META_KEY = 'resource_meta'
const RESOURCE_KEY_PREFIX = 'resource_'
const STORAGE_VERSION = 2
const MAX_SEGMENTS = 80
const CLOUD_SYNC_DEBOUNCE_MS = 3000

let state = createEmptyState()
let syncTimer = null

function createEmptyState(userId = '') {
  return {
    userId,
    loaded: false,
    index: [],
    meta: createDefaultMeta(),
    resourceMap: new Map()
  }
}

function createDefaultMeta() {
  return {
    version: STORAGE_VERSION,
    lastSyncTime: 0,
    totalCount: 0,
    dirtyIds: [],
    deletedIds: [],
    migratedAt: 0,
    updatedAt: 0
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6)
}

function now() {
  return Date.now()
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)))
}

function resourceKey(id) {
  return `${RESOURCE_KEY_PREFIX}${id}`
}

function normalizeImage(image, index) {
  const src = typeof image === 'string' ? image : (image && image.src)
  if (!src) return null

  return {
    index: (image && image.index) || index + 1,
    src: String(src).trim(),
    alt: (image && image.alt) || ''
  }
}

function normalizeImages(images) {
  return (images || [])
    .map(normalizeImage)
    .filter(image => image && image.src)
}

function normalizeShadowRecord(record, index) {
  if (!record || !record.fileID) return null

  return {
    id: record.id || generateId(),
    fileID: record.fileID,
    duration: Number(record.duration) || 0,
    createdAt: record.createdAt || now(),
    source: record.source || 'resource-detail'
  }
}

function normalizeSegment(segment, index) {
  const text = typeof segment === 'string' ? segment : (segment.text || '')
  const imagesBefore = typeof segment === 'string'
    ? []
    : normalizeImages(segment.imagesBefore || segment.images || [])
  const imagesAfter = typeof segment === 'string'
    ? []
    : normalizeImages(segment.imagesAfter || [])
  const shadowRecords = typeof segment === 'string'
    ? []
    : (segment.shadowRecords || [])
      .map(normalizeShadowRecord)
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt)

  return {
    index: segment.index || index + 1,
    text: text.trim(),
    translation: segment.translation || '',
    audioFileID: segment.audioFileID || '',
    audioStatus: segment.audioStatus || 'idle',
    audioVoice: segment.audioVoice || '',
    duration: segment.duration || 0,
    lastPlayedAt: segment.lastPlayedAt || 0,
    shadowRecords,
    lastShadowedAt: segment.lastShadowedAt || (shadowRecords[0] && shadowRecords[0].createdAt) || 0,
    shadowCount: shadowRecords.length,
    imagesBefore,
    imagesAfter
  }
}

function collectSegmentImages(segments) {
  return (segments || []).reduce((images, segment) => {
    return images
      .concat(segment.imagesBefore || [])
      .concat(segment.imagesAfter || [])
  }, [])
}

function buildSummary(segments) {
  const first = segments.find(s => s.text)
  if (!first) return ''
  return first.text.length > 90 ? first.text.slice(0, 90) + '...' : first.text
}

function normalizeStudyPack(studyPack) {
  if (!studyPack) return null
  const normalized = {
    keyWords: Array.isArray(studyPack.keyWords) ? studyPack.keyWords : [],
    hardSentences: Array.isArray(studyPack.hardSentences) ? studyPack.hardSentences : [],
    dictationSentences: Array.isArray(studyPack.dictationSentences) ? studyPack.dictationSentences : [],
    segmentSummaries: Array.isArray(studyPack.segmentSummaries) ? studyPack.segmentSummaries : [],
    generatedAt: studyPack.generatedAt || 0
  }
  return {
    ...normalized,
    hasContent: studyPack.hasContent !== undefined ? !!studyPack.hasContent : (
      normalized.keyWords.length > 0 ||
      normalized.hardSentences.length > 0 ||
      normalized.dictationSentences.length > 0 ||
      normalized.segmentSummaries.length > 0
    )
  }
}

function normalizeResource(resource, userId) {
  const timestamp = now()
  const segments = (resource.segments || [])
    .slice(0, MAX_SEGMENTS)
    .map(normalizeSegment)
    .filter(segment => segment.text)
  const resourceImages = normalizeImages(resource.images || [])
  const images = resourceImages.length ? resourceImages : normalizeImages(collectSegmentImages(segments))

  return {
    id: resource.id || generateId(),
    ownerId: resource.ownerId || userId,
    type: resource.type || 'document',
    title: resource.title || 'Untitled Resource',
    sourceType: resource.sourceType || 'url',
    sourceUrl: resource.sourceUrl || '',
    fileName: resource.fileName || '',
    fileType: resource.fileType || '',
    format: resource.format || 'html',
    images,
    segments,
    studyPack: normalizeStudyPack(resource.studyPack),
    summary: resource.summary || buildSummary(segments),
    createdAt: resource.createdAt || timestamp,
    updatedAt: resource.updatedAt || timestamp,
    lastOpenedAt: resource.lastOpenedAt || 0
  }
}

function toIndexEntry(resource) {
  const segments = resource.segments || []
  return {
    id: resource.id,
    type: resource.type || 'document',
    title: resource.title || 'Untitled Resource',
    sourceType: resource.sourceType || 'url',
    sourceUrl: resource.sourceUrl || '',
    fileName: resource.fileName || '',
    fileType: resource.fileType || '',
    format: resource.format || 'html',
    summary: resource.summary || buildSummary(segments),
    imageCount: (resource.images || []).length,
    segmentCount: segments.length,
    cachedAudio: segments.filter(s => !!s.audioFileID).length,
    createdAt: resource.createdAt || 0,
    updatedAt: resource.updatedAt || 0,
    lastOpenedAt: resource.lastOpenedAt || 0
  }
}

function normalizeMeta(meta) {
  return {
    ...createDefaultMeta(),
    ...(meta || {}),
    version: STORAGE_VERSION,
    dirtyIds: unique(meta && meta.dirtyIds),
    deletedIds: unique(meta && meta.deletedIds)
  }
}

function saveIndex() {
  state.meta.totalCount = state.index.length
  userStorage.setUserStorageSync(INDEX_KEY, state.index, state.userId)
}

function saveMeta() {
  state.meta = normalizeMeta({
    ...state.meta,
    totalCount: state.index.length,
    updatedAt: now()
  })
  userStorage.setUserStorageSync(META_KEY, state.meta, state.userId)
}

function namespaceHasData(userId) {
  const index = userStorage.getUserStorageSync(INDEX_KEY, [], userId)
  const meta = userStorage.getUserStorageSync(META_KEY, null, userId)
  return (Array.isArray(index) && index.length > 0) || !!(meta && meta.totalCount)
}

function namespaceHasState(userId) {
  const index = userStorage.getUserStorageSync(INDEX_KEY, [], userId)
  const meta = normalizeMeta(userStorage.getUserStorageSync(META_KEY, null, userId))
  return (Array.isArray(index) && index.length > 0) ||
    meta.totalCount > 0 ||
    meta.lastSyncTime > 0 ||
    meta.migratedAt > 0 ||
    meta.updatedAt > 0 ||
    meta.dirtyIds.length > 0 ||
    meta.deletedIds.length > 0
}

function readNamespaceResources(userId) {
  const index = userStorage.getUserStorageSync(INDEX_KEY, [], userId)
  if (!Array.isArray(index) || !index.length) return []

  return index
    .map(entry => userStorage.getUserStorageSync(resourceKey(entry.id), null, userId))
    .filter(Boolean)
}

function mergeResources(primary, secondary) {
  const byId = new Map()
  ;(primary || []).forEach(resource => {
    if (resource && resource.id) byId.set(resource.id, resource)
  })
  ;(secondary || []).forEach(resource => {
    if (!resource || !resource.id) return
    const existing = byId.get(resource.id)
    if (!existing || (resource.updatedAt || 0) > (existing.updatedAt || 0)) {
      byId.set(resource.id, resource)
    }
  })
  return Array.from(byId.values())
}

function writeResourcesToNamespace(resources, userId, options = {}) {
  const normalized = (resources || []).map(resource => normalizeResource(resource, userId))
  const index = normalized.map(toIndexEntry)
  const meta = normalizeMeta({
    ...createDefaultMeta(),
    migratedAt: options.migratedAt || 0,
    totalCount: normalized.length,
    dirtyIds: options.markDirty ? normalized.map(resource => resource.id) : [],
    updatedAt: now()
  })

  normalized.forEach(resource => {
    userStorage.setUserStorageSync(resourceKey(resource.id), resource, userId)
  })
  userStorage.setUserStorageSync(INDEX_KEY, index, userId)
  userStorage.setUserStorageSync(META_KEY, meta, userId)

  if (state.userId === userId) {
    state.index = index
    state.meta = meta
    state.resourceMap = new Map(normalized.map(resource => [resource.id, resource]))
  }
}

function migrateLegacyIfNeeded(userId) {
  const hasCurrentState = namespaceHasState(userId)
  const legacyResources = userStorage.readStorage(LEGACY_STORAGE_KEY, [])
  const hasLegacy = Array.isArray(legacyResources) && legacyResources.length > 0
  const anonymousHasData = userId !== userStorage.ANONYMOUS_USER_ID && namespaceHasData(userStorage.ANONYMOUS_USER_ID)
  const canUseLegacy = hasLegacy && (userStorage.isAnonymousUser(userId) || userStorage.canClaimLegacy(LEGACY_CLAIM_SCOPE, userId))
  const canUseAnonymous = anonymousHasData && userStorage.canClaimLegacy(ANONYMOUS_CLAIM_SCOPE, userId)

  if (!hasLegacy && !anonymousHasData) return

  if (!hasCurrentState) {
    const anonymousResources = canUseAnonymous ? readNamespaceResources(userStorage.ANONYMOUS_USER_ID) : []
    const sourceResources = mergeResources(canUseLegacy ? legacyResources : [], anonymousResources)
    if (sourceResources.length) {
      writeResourcesToNamespace(sourceResources, userId, {
        migratedAt: now(),
        markDirty: !userStorage.isAnonymousUser(userId)
      })
      if (!userStorage.isAnonymousUser(userId)) {
        if (canUseLegacy) userStorage.setLegacyClaim(LEGACY_CLAIM_SCOPE, userId)
        if (canUseAnonymous) userStorage.setLegacyClaim(ANONYMOUS_CLAIM_SCOPE, userId)
        if ((hasLegacy && !canUseLegacy) || (anonymousHasData && !canUseAnonymous)) {
          userStorage.markLegacyUnclaimed(userId, {
            learningResources: hasLegacy && !canUseLegacy,
            anonymousResources: anonymousHasData && !canUseAnonymous
          })
        }
        scheduleCloudSync()
      }
      return
    }

    if (!userStorage.isAnonymousUser(userId)) {
      userStorage.markLegacyUnclaimed(userId, {
        learningResources: hasLegacy && !canUseLegacy,
        anonymousResources: anonymousHasData && !canUseAnonymous
      })
    }
    return
  }

  if (!userStorage.isAnonymousUser(userId)) {
    const legacyClaimedBy = userStorage.getLegacyClaim(LEGACY_CLAIM_SCOPE)
    const anonymousClaimedBy = userStorage.getLegacyClaim(ANONYMOUS_CLAIM_SCOPE)
    userStorage.markLegacyUnclaimed(userId, {
      learningResources: hasLegacy && legacyClaimedBy !== userId,
      anonymousResources: anonymousHasData && anonymousClaimedBy !== userId
    })
  }
}

function loadStateForActiveUser() {
  const userId = userStorage.getActiveUserId()
  state = createEmptyState(userId)
  state.index = userStorage.getUserStorageSync(INDEX_KEY, [], userId) || []
  state.meta = normalizeMeta(userStorage.getUserStorageSync(META_KEY, null, userId))
  state.loaded = true
  migrateLegacyIfNeeded(userId)
  state.index = userStorage.getUserStorageSync(INDEX_KEY, [], userId) || []
  state.meta = normalizeMeta(userStorage.getUserStorageSync(META_KEY, null, userId))
}

function ensureState() {
  const userId = userStorage.getActiveUserId()
  if (state.userId !== userId || !state.loaded) {
    loadStateForActiveUser()
  }
  return state
}

function findIndexEntry(id) {
  return state.index.find(entry => entry.id === id) || null
}

function upsertIndex(resource) {
  const entry = toIndexEntry(resource)
  const index = state.index.findIndex(item => item.id === resource.id)
  if (index === -1) {
    state.index.unshift(entry)
  } else {
    state.index[index] = entry
  }
}

function markDirty(id) {
  state.meta.dirtyIds = unique([...(state.meta.dirtyIds || []), id])
  state.meta.deletedIds = (state.meta.deletedIds || []).filter(deletedId => deletedId !== id)
  saveMeta()
  scheduleCloudSync()
}

function persistResource(resource, options = {}) {
  ensureState()
  const normalized = normalizeResource(resource, state.userId)
  state.resourceMap.set(normalized.id, normalized)
  upsertIndex(normalized)
  userStorage.setUserStorageSync(resourceKey(normalized.id), normalized, state.userId)
  saveIndex()
  if (options.dirty !== false) {
    markDirty(normalized.id)
  } else {
    saveMeta()
  }
  return normalized
}

function loadResource(id, options = {}) {
  ensureState()
  if (!id || (!options.skipIndexCheck && !findIndexEntry(id))) return null
  if (state.resourceMap.has(id)) return state.resourceMap.get(id)

  const resource = userStorage.getUserStorageSync(resourceKey(id), null, state.userId)
  if (!resource) return null

  const normalized = normalizeResource(resource, state.userId)
  state.resourceMap.set(id, normalized)
  return normalized
}

function loadResourcesByEntries(entries) {
  return (entries || []).map(entry => loadResource(entry.id, { skipIndexCheck: true })).filter(Boolean)
}

function getAllResources() {
  ensureState()
  return loadResourcesByEntries(state.index)
}

function addResource(resourceData = {}) {
  ensureState()
  const createdAt = now()
  return persistResource({
    ...resourceData,
    id: generateId(),
    ownerId: state.userId,
    createdAt,
    updatedAt: createdAt,
    lastOpenedAt: 0
  })
}

function updateResource(id, updates) {
  const resource = loadResource(id)
  if (!resource) return null

  return persistResource({
    ...resource,
    ...updates,
    id: resource.id,
    ownerId: resource.ownerId || state.userId,
    createdAt: resource.createdAt,
    updatedAt: now()
  })
}

function deleteResource(id) {
  ensureState()
  if (!id) return
  state.resourceMap.delete(id)
  state.index = state.index.filter(entry => entry.id !== id)
  state.meta.dirtyIds = (state.meta.dirtyIds || []).filter(dirtyId => dirtyId !== id)
  state.meta.deletedIds = unique([...(state.meta.deletedIds || []), id])
  userStorage.removeUserStorageSync(resourceKey(id), state.userId)
  saveIndex()
  saveMeta()
  scheduleCloudSync()
}

function getResourceById(id) {
  return loadResource(id)
}

function markOpened(id) {
  return updateResource(id, { lastOpenedAt: now() })
}

function searchResources(query) {
  ensureState()
  if (!query || !query.trim()) return getAllResources()

  const q = query.trim().toLowerCase()
  return getAllResources().filter(resource => {
    return (resource.title || '').toLowerCase().includes(q) ||
      (resource.summary || '').toLowerCase().includes(q) ||
      (resource.sourceUrl || '').toLowerCase().includes(q)
  })
}

function getRecentResources(limit = 4) {
  ensureState()
  return loadResourcesByEntries(
    state.index
      .slice()
      .sort((a, b) => (b.lastOpenedAt || b.createdAt) - (a.lastOpenedAt || a.createdAt))
      .slice(0, limit)
  )
}

function updateSegment(resourceId, segmentIndex, updates) {
  const resource = loadResource(resourceId)
  if (!resource) return null

  const segments = (resource.segments || []).map(segment => {
    if (segment.index !== segmentIndex) return segment
    return {
      ...segment,
      ...updates
    }
  })

  return updateResource(resourceId, { segments })
}

function addSegmentShadowRecord(resourceId, segmentIndex, record) {
  const resource = loadResource(resourceId)
  if (!resource) return null

  const timestamp = now()
  const segments = (resource.segments || []).map(segment => {
    if (segment.index !== segmentIndex) return segment

    const existingRecords = Array.isArray(segment.shadowRecords) ? segment.shadowRecords : []
    const item = normalizeShadowRecord({
      ...record,
      createdAt: record && record.createdAt ? record.createdAt : timestamp
    }, existingRecords.length)
    if (!item) return segment

    const shadowRecords = [item, ...existingRecords]
      .map(normalizeShadowRecord)
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt)

    return {
      ...segment,
      shadowRecords,
      shadowCount: shadowRecords.length,
      lastShadowedAt: shadowRecords[0] ? shadowRecords[0].createdAt : timestamp
    }
  })

  return updateResource(resourceId, { segments })
}

function deleteSegmentShadowRecord(resourceId, segmentIndex, recordId) {
  const resource = loadResource(resourceId)
  if (!resource) return null

  const segments = (resource.segments || []).map(segment => {
    if (segment.index !== segmentIndex) return segment

    const shadowRecords = (segment.shadowRecords || [])
      .filter(record => record.id !== recordId)
      .map(normalizeShadowRecord)
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt)

    return {
      ...segment,
      shadowRecords,
      shadowCount: shadowRecords.length,
      lastShadowedAt: shadowRecords[0] ? shadowRecords[0].createdAt : 0
    }
  })

  return updateResource(resourceId, { segments })
}

function pickShadowSegment(limitResources = 5) {
  ensureState()
  const resources = loadResourcesByEntries(
    state.index
      .slice()
      .sort((a, b) => (b.lastOpenedAt || b.createdAt) - (a.lastOpenedAt || a.createdAt))
      .slice(0, limitResources)
  )

  const candidates = []
  resources.forEach(resource => {
    ;(resource.segments || []).forEach(segment => {
      if (!segment || !segment.text) return
      const shadowRecords = segment.shadowRecords || []
      const shadowCount = Number.isFinite(segment.shadowCount) ? segment.shadowCount : shadowRecords.length
      const lastShadowedAt = segment.lastShadowedAt || (shadowRecords[0] && shadowRecords[0].createdAt) || 0

      candidates.push({
        resourceId: resource.id,
        resourceTitle: resource.title,
        segmentIndex: segment.index,
        text: segment.text,
        shadowCount,
        lastShadowedAt,
        resourceOpenedAt: resource.lastOpenedAt || resource.createdAt || 0
      })
    })
  })

  return candidates
    .sort((a, b) => {
      if (!a.shadowCount && b.shadowCount) return -1
      if (a.shadowCount && !b.shadowCount) return 1
      if ((a.lastShadowedAt || 0) !== (b.lastShadowedAt || 0)) {
        return (a.lastShadowedAt || 0) - (b.lastShadowedAt || 0)
      }
      return (b.resourceOpenedAt || 0) - (a.resourceOpenedAt || 0)
    })[0] || null
}

function getStats() {
  ensureState()
  return {
    total: state.index.length,
    documents: state.index.filter(r => r.type === 'document').length,
    segments: state.index.reduce((sum, r) => sum + (r.segmentCount || 0), 0),
    cachedAudio: state.index.reduce((sum, r) => sum + (r.cachedAudio || 0), 0)
  }
}

function clearAllAudioReferences() {
  getAllResources().forEach(resource => {
    updateResource(resource.id, {
      segments: (resource.segments || []).map(segment => ({
        ...segment,
        audioFileID: '',
        audioStatus: 'idle',
        audioVoice: '',
        duration: 0
      }))
    })
  })
}

function clearSyncTimer() {
  if (syncTimer) {
    clearTimeout(syncTimer)
    syncTimer = null
  }
}

function scheduleCloudSync() {
  ensureState()
  if (userStorage.isAnonymousUser(state.userId)) return
  clearSyncTimer()
  syncTimer = setTimeout(() => {
    syncTimer = null
    flushPendingSync().catch(err => console.error('资源云端同步失败', err))
  }, CLOUD_SYNC_DEBOUNCE_MS)
}

function callSyncData(payload) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      resolve({ skipped: true, reason: 'cloud unavailable' })
      return
    }
    wx.cloud.callFunction({
      name: 'syncData',
      data: payload,
      success: res => {
        const result = res.result || {}
        if (result.skipped) {
          resolve(result)
          return
        }
        if (!result.success) {
          reject(new Error(result.error || '数据同步失败'))
          return
        }
        resolve(result)
      },
      fail: err => reject(err)
    })
  })
}

function removeSyncedIds(sentDirtyIds, sentDeletedIds) {
  ensureState()
  const dirtySet = new Set(sentDirtyIds)
  const deletedSet = new Set(sentDeletedIds)
  state.meta.dirtyIds = (state.meta.dirtyIds || []).filter(id => !dirtySet.has(id))
  state.meta.deletedIds = (state.meta.deletedIds || []).filter(id => !deletedSet.has(id))
  state.meta.lastSyncTime = now()
  saveMeta()
}

function flushPendingSync(options = {}) {
  ensureState()
  if (userStorage.isAnonymousUser(state.userId)) {
    return Promise.resolve({ skipped: true, reason: 'anonymous user' })
  }

  const dirtyIds = options.forceAll
    ? state.index.map(entry => entry.id)
    : unique(state.meta.dirtyIds)
  const deletedIds = unique(state.meta.deletedIds)

  if (!dirtyIds.length && !deletedIds.length) {
    return Promise.resolve({ skipped: true, reason: 'nothing to sync' })
  }

  const resources = dirtyIds.map(id => loadResource(id)).filter(Boolean)
  const payload = {
    ownerId: state.userId,
    resources,
    deletedResourceIds: deletedIds
  }

  const sentDirtyIds = dirtyIds.slice()
  const sentDeletedIds = deletedIds.slice()
  return callSyncData(payload).then(result => {
    if (result && result.success) {
      // 只有确实有记录成功同步，才清除脏标记
      const resSynced = result.resources && result.resources.synced > 0 ? result.resources.synced : 0
      const deletedOk = result.deletedResources && result.deletedResources.deleted > 0 ? result.deletedResources.deleted : 0
      if (resSynced > 0 || deletedOk > 0) {
        removeSyncedIds(sentDirtyIds, sentDeletedIds)
      }
    }
    return result
  })
}

function hydrateFromCloud() {
  ensureState()
  if (userStorage.isAnonymousUser(state.userId) || namespaceHasState(state.userId)) {
    return Promise.resolve({ skipped: true })
  }

  return callSyncData({ action: 'pull', scope: 'resources', ownerId: state.userId }).then(result => {
    if (result && result.success && Array.isArray(result.resources) && result.resources.length) {
      writeResourcesToNamespace(result.resources, state.userId, { markDirty: false })
    }
    return result
  })
}

function initForActiveUser() {
  loadStateForActiveUser()
  if (!userStorage.isAnonymousUser(state.userId)) {
    hydrateFromCloud().catch(err => console.error('资源云端拉取失败', err))
    if ((state.meta.dirtyIds || []).length || (state.meta.deletedIds || []).length) {
      scheduleCloudSync()
    }
  }
}

module.exports = {
  getAllResources,
  addResource,
  updateResource,
  deleteResource,
  getResourceById,
  markOpened,
  searchResources,
  getRecentResources,
  updateSegment,
  addSegmentShadowRecord,
  deleteSegmentShadowRecord,
  pickShadowSegment,
  getStats,
  clearAllAudioReferences,
  generateId,
  flushPendingSync,
  hydrateFromCloud,
  initForActiveUser
}
