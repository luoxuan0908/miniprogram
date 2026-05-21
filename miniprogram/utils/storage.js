/**
 * storage.js - 本地存储 CRUD 封装
 * 以 wx.Storage 为单一数据源，管理所有生词数据
 */

const { WORD_STATUS, calcNextReview, handleCorrect, handleIncorrect, MAX_REVIEW_LEVEL } = require('./constants')

const STORAGE_KEY = 'vocab_words'

/** 生成唯一 ID */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6)
}

/** 获取所有生词 */
function getAllWords() {
  try {
    return wx.getStorageSync(STORAGE_KEY) || []
  } catch (e) {
    return []
  }
}

/** 保存全部生词到本地 */
function saveAllWords(words) {
  try {
    wx.setStorageSync(STORAGE_KEY, words)
  } catch (e) {
    console.error('保存生词失败', e)
  }
}

/** 根据 ID 获取单个生词 */
function getWordById(id) {
  const words = getAllWords()
  return words.find(w => w.id === id) || null
}

/** 添加生词 */
function addWord(wordData) {
  const words = getAllWords()
  const now = Date.now()
  const word = {
    id: generateId(),
    word: wordData.word || '',
    status: WORD_STATUS.NEW,
    reviewLevel: 0,
    content: wordData.content || {},
    audio: wordData.audio || { wordAudio: '', clozeAudio: '', fullAudio: '' },
    stats: {
      correctCount: 0,
      totalAttempts: 0,
      lastReviewed: 0,
      nextReview: now
    },
    createdAt: now,
    updatedAt: now
  }
  words.push(word)
  saveAllWords(words)
  return word
}

/** 更新生词 (部分更新) */
function updateWord(id, updates) {
  const words = getAllWords()
  const index = words.findIndex(w => w.id === id)
  if (index === -1) return null

  words[index] = {
    ...words[index],
    ...updates,
    id: words[index].id,           // 保护 id 不被覆盖
    createdAt: words[index].createdAt, // 保护创建时间
    updatedAt: Date.now()
  }
  saveAllWords(words)
  return words[index]
}

/** 删除生词 */
function deleteWord(id) {
  const words = getAllWords()
  const filtered = words.filter(w => w.id !== id)
  saveAllWords(filtered)
}

/** 获取到期待复习的生词（nextReview <= now 且未永久掌握） */
function getDueWords() {
  const words = getAllWords()
  const now = Date.now()
  return words
    .filter(w => w.reviewLevel < MAX_REVIEW_LEVEL && w.stats.nextReview <= now)
    .sort((a, b) => a.stats.nextReview - b.stats.nextReview)
}

/** 按状态筛选生词 */
function getWordsByStatus(status) {
  if (!status || status === 'all') return getAllWords()
  return getAllWords().filter(w => w.status === status)
}

/** 搜索生词（按单词或释义搜索） */
function searchWords(query) {
  if (!query || !query.trim()) return getAllWords()
  const q = query.trim().toLowerCase()
  return getAllWords().filter(w => {
    return w.word.toLowerCase().includes(q) ||
      (w.content.chineseHint && w.content.chineseHint.includes(q)) ||
      (w.content.shortDefinition && w.content.shortDefinition.toLowerCase().includes(q))
  })
}

/** 获取学习统计 */
function getStats() {
  const words = getAllWords()
  const now = Date.now()
  return {
    total: words.length,
    mastered: words.filter(w => w.status === WORD_STATUS.MASTERED).length,
    learning: words.filter(w => w.status === WORD_STATUS.LEARNING).length,
    newWords: words.filter(w => w.status === WORD_STATUS.NEW).length,
    due: words.filter(w => w.reviewLevel < MAX_REVIEW_LEVEL && w.stats.nextReview <= now).length
  }
}

/** 记录复习结果（正确/错误），更新复习等级和下次复习时间 */
function recordReviewResult(id, isCorrect) {
  const word = getWordById(id)
  if (!word) return null

  let update
  if (isCorrect) {
    update = handleCorrect(word.reviewLevel)
  } else {
    update = handleIncorrect()
  }

  return updateWord(id, {
    status: update.status,
    reviewLevel: update.reviewLevel,
    stats: {
      ...word.stats,
      correctCount: word.stats.correctCount + (isCorrect ? 1 : 0),
      totalAttempts: word.stats.totalAttempts + 1,
      lastReviewed: Date.now(),
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
    // 如果没有到期词，取一些新词
    const newWords = getWordsByStatus(WORD_STATUS.NEW)
    return newWords.slice(0, Math.max(newWordCount, 3))
  }

  const count = Math.max(Math.floor(dueWords.length * 0.2), 2)
  const newWords = getWordsByStatus(WORD_STATUS.NEW).slice(0, count)

  // 将新词插入到队列中（每隔几个到期词插入一个新词）
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
  getRecentRecords,
  mixNewWords,
  generateId
}
