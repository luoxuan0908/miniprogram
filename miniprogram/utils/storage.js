/**
 * storage.js - User-scoped three-layer vocab persistence.
 * L1: module memory Map, L2: partitioned wx.Storage, L3: async cloud sync.
 */

const { WORD_STATUS, handleCorrect, handleIncorrect, MAX_REVIEW_LEVEL } = require('./constants')
const userStorage = require('./user-storage')
const phonetic = require('./phonetic')

const LEGACY_STORAGE_KEY = 'vocab_words'
const LEGACY_CLAIM_SCOPE = 'vocab_words'
const ANONYMOUS_CLAIM_SCOPE = 'anonymous_vocab'
const INDEX_KEY = 'vocab_index'
const META_KEY = 'vocab_meta'
const WORD_KEY_PREFIX = 'vocab_'
const STORAGE_VERSION = 2
const CLOUD_SYNC_DEBOUNCE_MS = 3000

let state = createEmptyState()
let syncTimer = null

function createEmptyState(userId = '') {
  return {
    userId,
    loaded: false,
    index: [],
    meta: createDefaultMeta(),
    wordMap: new Map()
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

function now() {
  return Date.now()
}

/** 生成唯一 ID */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6)
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)))
}

function wordKey(id) {
  return `${WORD_KEY_PREFIX}${id}`
}

function toIndexEntry(word) {
  const stats = word.stats || {}
  return {
    id: word.id,
    word: word.word || '',
    status: word.status || WORD_STATUS.NEW,
    reviewLevel: word.reviewLevel || 0,
    nextReview: stats.nextReview || 0,
    createdAt: word.createdAt || 0,
    updatedAt: word.updatedAt || 0
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

function normalizeWord(word, userId) {
  const timestamp = now()
  const wordText = word.word || ''
  const defaultSkill = { correctCount: 0, totalAttempts: 0, lastPracticedAt: 0 }
  const skillStats = word.skillStats || {}
  return {
    id: word.id || generateId(),
    word: wordText,
    ownerId: word.ownerId || userId,
    status: word.status || WORD_STATUS.NEW,
    reviewLevel: Number.isFinite(word.reviewLevel) ? word.reviewLevel : 0,
    content: phonetic.ensureContentPhonetic(wordText, word.content || {}),
    audio: word.audio || { wordAudio: '', clozeAudio: '', fullAudio: '' },
    pronunciationRecords: Array.isArray(word.pronunciationRecords) ? word.pronunciationRecords : [],
    skillStats: {
      recognition: { ...defaultSkill, ...(skillStats.recognition || {}) },
      dictation: { ...defaultSkill, ...(skillStats.dictation || {}) },
      recall: { ...defaultSkill, ...(skillStats.recall || {}) },
      context: { ...defaultSkill, ...(skillStats.context || {}) }
    },
    mistakes: Array.isArray(word.mistakes) ? word.mistakes : [],
    stats: {
      correctCount: 0,
      totalAttempts: 0,
      lastReviewed: 0,
      nextReview: timestamp,
      ...(word.stats || {})
    },
    createdAt: word.createdAt || timestamp,
    updatedAt: word.updatedAt || timestamp
  }
}

function addPronunciationRecord(id, record) {
  const word = loadWord(id)
  if (!word) return null

  const timestamp = now()
  const item = {
    id: record.id || generateId(),
    fileID: record.fileID || '',
    duration: record.duration || 0,
    createdAt: record.createdAt || timestamp,
    word: record.word || word.word,
    source: record.source || 'word-detail'
  }

  return updateWord(id, {
    pronunciationRecords: [...(word.pronunciationRecords || []), item]
  })
}

function deletePronunciationRecord(id, recordId) {
  const word = loadWord(id)
  if (!word) return null
  return updateWord(id, {
    pronunciationRecords: (word.pronunciationRecords || []).filter(record => record.id !== recordId)
  })
}

function recordSkillPractice(id, mode, isCorrect, details = {}) {
  const word = loadWord(id)
  if (!word) return null
  const safeMode = ['recognition', 'dictation', 'recall', 'context'].includes(mode) ? mode : 'recognition'
  const timestamp = now()
  const existing = (word.skillStats && word.skillStats[safeMode]) || {}
  const skillStats = {
    ...(word.skillStats || {}),
    [safeMode]: {
      correctCount: (existing.correctCount || 0) + (isCorrect ? 1 : 0),
      totalAttempts: (existing.totalAttempts || 0) + 1,
      lastPracticedAt: timestamp
    }
  }
  const mistakes = isCorrect
    ? (word.mistakes || [])
    : [
        ...(word.mistakes || []),
        {
          mode: safeMode,
          answer: details.answer || '',
          expected: details.expected || word.word,
          reason: details.reason || '未作答',
          createdAt: timestamp
        }
      ]

  return updateWord(id, { skillStats, mistakes })
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

function readNamespaceWords(userId) {
  const index = userStorage.getUserStorageSync(INDEX_KEY, [], userId)
  if (!Array.isArray(index) || !index.length) return []

  return index
    .map(entry => userStorage.getUserStorageSync(wordKey(entry.id), null, userId))
    .filter(Boolean)
}

function mergeWords(primary, secondary) {
  const byId = new Map()
  ;(primary || []).forEach(word => {
    if (word && word.id) byId.set(word.id, word)
  })
  ;(secondary || []).forEach(word => {
    if (!word || !word.id) return
    const existing = byId.get(word.id)
    if (!existing || (word.updatedAt || 0) > (existing.updatedAt || 0)) {
      byId.set(word.id, word)
    }
  })
  return Array.from(byId.values())
}

function writeWordsToNamespace(words, userId, options = {}) {
  const normalized = (words || []).map(word => normalizeWord(word, userId))
  const index = normalized.map(toIndexEntry)
  const meta = normalizeMeta({
    ...createDefaultMeta(),
    migratedAt: options.migratedAt || 0,
    totalCount: normalized.length,
    dirtyIds: options.markDirty ? normalized.map(word => word.id) : [],
    updatedAt: now()
  })

  normalized.forEach(word => {
    userStorage.setUserStorageSync(wordKey(word.id), word, userId)
  })
  userStorage.setUserStorageSync(INDEX_KEY, index, userId)
  userStorage.setUserStorageSync(META_KEY, meta, userId)

  if (state.userId === userId) {
    state.index = index
    state.meta = meta
    state.wordMap = new Map(normalized.map(word => [word.id, word]))
  }
}

function migrateLegacyIfNeeded(userId) {
  const hasCurrentState = namespaceHasState(userId)
  const legacyWords = userStorage.readStorage(LEGACY_STORAGE_KEY, [])
  const hasLegacy = Array.isArray(legacyWords) && legacyWords.length > 0
  const anonymousHasData = userId !== userStorage.ANONYMOUS_USER_ID && namespaceHasData(userStorage.ANONYMOUS_USER_ID)
  const canUseLegacy = hasLegacy && (userStorage.isAnonymousUser(userId) || userStorage.canClaimLegacy(LEGACY_CLAIM_SCOPE, userId))
  const canUseAnonymous = anonymousHasData && userStorage.canClaimLegacy(ANONYMOUS_CLAIM_SCOPE, userId)

  if (!hasLegacy && !anonymousHasData) return

  if (!hasCurrentState) {
    const anonymousWords = canUseAnonymous ? readNamespaceWords(userStorage.ANONYMOUS_USER_ID) : []
    const sourceWords = mergeWords(canUseLegacy ? legacyWords : [], anonymousWords)
    if (sourceWords.length) {
      writeWordsToNamespace(sourceWords, userId, {
        migratedAt: now(),
        markDirty: !userStorage.isAnonymousUser(userId)
      })
      if (!userStorage.isAnonymousUser(userId)) {
        if (canUseLegacy) userStorage.setLegacyClaim(LEGACY_CLAIM_SCOPE, userId)
        if (canUseAnonymous) userStorage.setLegacyClaim(ANONYMOUS_CLAIM_SCOPE, userId)
        if ((hasLegacy && !canUseLegacy) || (anonymousHasData && !canUseAnonymous)) {
          userStorage.markLegacyUnclaimed(userId, {
            vocabWords: hasLegacy && !canUseLegacy,
            anonymousVocab: anonymousHasData && !canUseAnonymous
          })
        }
        scheduleCloudSync()
      }
      return
    }

    if (!userStorage.isAnonymousUser(userId)) {
      userStorage.markLegacyUnclaimed(userId, {
        vocabWords: hasLegacy && !canUseLegacy,
        anonymousVocab: anonymousHasData && !canUseAnonymous
      })
    }
    return
  }

  if (!userStorage.isAnonymousUser(userId)) {
    const legacyClaimedBy = userStorage.getLegacyClaim(LEGACY_CLAIM_SCOPE)
    const anonymousClaimedBy = userStorage.getLegacyClaim(ANONYMOUS_CLAIM_SCOPE)
    userStorage.markLegacyUnclaimed(userId, {
      vocabWords: hasLegacy && legacyClaimedBy !== userId,
      anonymousVocab: anonymousHasData && anonymousClaimedBy !== userId
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

function upsertIndex(word) {
  const entry = toIndexEntry(word)
  const index = state.index.findIndex(item => item.id === word.id)
  if (index === -1) {
    state.index.push(entry)
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

function persistWord(word, options = {}) {
  ensureState()
  const normalized = normalizeWord(word, state.userId)
  state.wordMap.set(normalized.id, normalized)
  upsertIndex(normalized)
  userStorage.setUserStorageSync(wordKey(normalized.id), normalized, state.userId)
  saveIndex()
  if (options.dirty !== false) {
    markDirty(normalized.id)
  } else {
    saveMeta()
  }
  return normalized
}

function loadWord(id, options = {}) {
  ensureState()
  if (!id || (!options.skipIndexCheck && !findIndexEntry(id))) return null
  if (state.wordMap.has(id)) return state.wordMap.get(id)

  const word = userStorage.getUserStorageSync(wordKey(id), null, state.userId)
  if (!word) return null

  const normalized = normalizeWord(word, state.userId)
  state.wordMap.set(id, normalized)
  return normalized
}

function loadWordsByEntries(entries) {
  return (entries || []).map(entry => loadWord(entry.id, { skipIndexCheck: true })).filter(Boolean)
}

/** 获取所有生词 */
function getAllWords() {
  ensureState()
  return loadWordsByEntries(state.index)
}

/** 根据 ID 获取单个生词 */
function getWordById(id) {
  return loadWord(id)
}

/** 添加生词 */
function addWord(wordData = {}) {
  ensureState()
  const timestamp = now()
  return persistWord({
    id: generateId(),
    word: wordData.word || '',
    ownerId: state.userId,
    status: WORD_STATUS.NEW,
    reviewLevel: 0,
    content: wordData.content || {},
    audio: wordData.audio || { wordAudio: '', clozeAudio: '', fullAudio: '' },
    stats: {
      correctCount: 0,
      totalAttempts: 0,
      lastReviewed: 0,
      nextReview: timestamp
    },
    createdAt: timestamp,
    updatedAt: timestamp
  })
}

/** 更新生词 (部分更新) */
function updateWord(id, updates) {
  const word = loadWord(id)
  if (!word) return null

  return persistWord({
    ...word,
    ...updates,
    id: word.id,
    ownerId: word.ownerId || state.userId,
    createdAt: word.createdAt,
    updatedAt: now()
  })
}

/** 删除生词 */
function deleteWord(id) {
  ensureState()
  if (!id) return
  state.wordMap.delete(id)
  state.index = state.index.filter(entry => entry.id !== id)
  state.meta.dirtyIds = (state.meta.dirtyIds || []).filter(dirtyId => dirtyId !== id)
  state.meta.deletedIds = unique([...(state.meta.deletedIds || []), id])
  userStorage.removeUserStorageSync(wordKey(id), state.userId)
  saveIndex()
  saveMeta()
  scheduleCloudSync()
}

/** 获取到期待复习的生词（nextReview <= now 且未永久掌握） */
function getDueWords() {
  ensureState()
  const timestamp = now()
  return loadWordsByEntries(
    state.index
      .filter(entry => entry.reviewLevel < MAX_REVIEW_LEVEL && entry.nextReview <= timestamp)
      .sort((a, b) => a.nextReview - b.nextReview)
  )
}

/** 按状态筛选生词 */
function getWordsByStatus(status) {
  ensureState()
  if (!status || status === 'all') return getAllWords()
  return loadWordsByEntries(state.index.filter(entry => entry.status === status))
}

/** 搜索生词（按单词或释义搜索） */
function searchWords(query) {
  if (!query || !query.trim()) return getAllWords()
  const q = query.trim().toLowerCase()
  return getAllWords().filter(w => {
    const content = w.content || {}
    return (w.word || '').toLowerCase().includes(q) ||
      (content.phonetic && content.phonetic.toLowerCase().includes(q)) ||
      (content.chineseHint && content.chineseHint.includes(q)) ||
      (content.shortDefinition && content.shortDefinition.toLowerCase().includes(q))
  })
}

/** 获取学习统计 */
function getStats() {
  ensureState()
  const timestamp = now()
  return {
    total: state.index.length,
    mastered: state.index.filter(w => w.status === WORD_STATUS.MASTERED).length,
    learning: state.index.filter(w => w.status === WORD_STATUS.LEARNING).length,
    newWords: state.index.filter(w => w.status === WORD_STATUS.NEW).length,
    due: state.index.filter(w => w.reviewLevel < MAX_REVIEW_LEVEL && w.nextReview <= timestamp).length
  }
}

/** 记录复习结果（正确/错误），更新复习等级和下次复习时间 */
function recordReviewResult(id, isCorrect) {
  const word = loadWord(id)
  if (!word) return null

  const update = isCorrect ? handleCorrect(word.reviewLevel) : handleIncorrect()
  return updateWord(id, {
    status: update.status,
    reviewLevel: update.reviewLevel,
    stats: {
      ...word.stats,
      correctCount: word.stats.correctCount + (isCorrect ? 1 : 0),
      totalAttempts: word.stats.totalAttempts + 1,
      lastReviewed: now(),
      nextReview: update.nextReview
    }
  })
}

/** 获取最近学习记录（按 lastReviewed 倒序，取最近 20 条） */
function getRecentRecords(limit = 20) {
  return getAllWords()
    .filter(w => w.stats.lastReviewed > 0)
    .sort((a, b) => b.stats.lastReviewed - a.stats.lastReviewed)
    .slice(0, limit)
}

/** 混合新词到复习队列（新词占比约 20%，最少 2 个） */
function mixNewWords(dueWords, newWordCount = 0) {
  if (dueWords.length === 0) {
    const newWords = getWordsByStatus(WORD_STATUS.NEW)
    return newWords.slice(0, Math.max(newWordCount, 3))
  }

  const count = Math.max(Math.floor(dueWords.length * 0.2), 2)
  const newWords = getWordsByStatus(WORD_STATUS.NEW).slice(0, count)
  const result = [...dueWords]
  const interval = Math.max(1, Math.floor(result.length / (newWords.length + 1)))
  let offset = 0
  newWords.forEach((nw, i) => {
    const pos = interval * (i + 1) + offset
    result.splice(Math.min(pos, result.length), 0, nw)
    offset++
  })

  return result
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
    flushPendingSync().catch(err => console.error('生词云端同步失败', err))
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

  const words = dirtyIds.map(id => loadWord(id)).filter(Boolean)
  const payload = {
    ownerId: state.userId,
    words,
    deletedWordIds: deletedIds
  }

  const sentDirtyIds = dirtyIds.slice()
  const sentDeletedIds = deletedIds.slice()
  return callSyncData(payload).then(result => {
    if (result && result.success) {
      // 只有确实有记录成功同步，才清除脏标记
      const wordSynced = result.words && result.words.synced > 0 ? result.words.synced : 0
      const deletedOk = result.deletedWords && result.deletedWords.deleted > 0 ? result.deletedWords.deleted : 0
      if (wordSynced > 0 || deletedOk > 0) {
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

  return callSyncData({ action: 'pull', scope: 'words', ownerId: state.userId }).then(result => {
    if (result && result.success && Array.isArray(result.words) && result.words.length) {
      writeWordsToNamespace(result.words, state.userId, { markDirty: false })
    }
    return result
  })
}

function initForActiveUser() {
  loadStateForActiveUser()
  if (!userStorage.isAnonymousUser(state.userId)) {
    hydrateFromCloud().catch(err => console.error('生词云端拉取失败', err))
    if ((state.meta.dirtyIds || []).length || (state.meta.deletedIds || []).length) {
      scheduleCloudSync()
    }
  }
}

module.exports = {
  getAllWords,
  getWordById,
  addWord,
  updateWord,
  deleteWord,
  getDueWords,
  getWordsByStatus,
  searchWords,
  getStats,
  recordReviewResult,
  recordSkillPractice,
  addPronunciationRecord,
  deletePronunciationRecord,
  getRecentRecords,
  mixNewWords,
  generateId,
  flushPendingSync,
  hydrateFromCloud,
  initForActiveUser
}
