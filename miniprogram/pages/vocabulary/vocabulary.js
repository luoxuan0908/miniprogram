const storage = require('../../utils/storage')
const { WORD_STATUS, MAX_REVIEW_LEVEL } = require('../../utils/constants')
const cloud = require('../../utils/cloud')
const studyDuration = require('../../utils/study-duration')

Page({
  data: {
    words: [],
    allWords: [],
    activeTab: 'all',
    searchQuery: '',
    tabCounts: {},
    totalCount: 0,
    loading: true
  },

  onLoad(options) {
    if (options && options.tab) {
      this.setData({ activeTab: options.tab })
    }
  },

  onShow() {
    studyDuration.startSession('vocabulary')
    this.loadWords()
    this.hydrateWordsIfEmpty()
  },

  onHide() {
    studyDuration.stopSession('vocabulary')
  },

  onUnload() {
    studyDuration.stopSession('vocabulary')
  },

  loadWords() {
    this.setData({ loading: true })
    const allWords = storage.getAllWords()
    const now = Date.now()
    const tabCounts = {
      all: allWords.length,
      new: allWords.filter(w => w.status === WORD_STATUS.NEW).length,
      learning: allWords.filter(w => w.status === WORD_STATUS.LEARNING).length,
      mastered: allWords.filter(w => w.status === WORD_STATUS.MASTERED).length,
      due: allWords.filter(w => w.reviewLevel < MAX_REVIEW_LEVEL && w.stats && w.stats.nextReview <= now).length
    }

    let words = this.data.searchQuery ? storage.searchWords(this.data.searchQuery) : allWords
    if (this.data.activeTab === 'due') {
      words = words.filter(w => w.reviewLevel < MAX_REVIEW_LEVEL && w.stats && w.stats.nextReview <= now)
    } else if (this.data.activeTab !== 'all') {
      words = words.filter(w => w.status === this.data.activeTab)
    }

    words = words.slice().sort((a, b) => b.createdAt - a.createdAt)

    this.setData({
      words,
      allWords,
      tabCounts,
      totalCount: allWords.length,
      loading: false
    })
  },

  onSearch(e) {
    this.setData({ searchQuery: e.detail.value })
    this.loadWords()
  },

  onClearSearch() {
    this.setData({ searchQuery: '' })
    this.loadWords()
  },

  onFilterTap(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab })
    this.loadWords()
  },

  onWordTap(e) {
    wx.navigateTo({ url: `/pages/word-detail/word-detail?id=${e.currentTarget.dataset.id}` })
  },

  onAddWord() {
    wx.navigateTo({ url: '/pages/add-word/add-word' })
  },

  async hydrateWordsIfEmpty() {
    if (this.data.allWords.length > 0) return
    try {
      const result = await cloud.syncToCloud({ action: 'pull', scope: 'words' })
      if (result && result.words && result.words.length) {
        const localWords = storage.getAllWords()
        const localIds = new Set(localWords.map(w => w.id))
        for (const cw of result.words) {
          if (!localIds.has(cw.id)) {
            const { _id, _openid, ownerId, createdBy, updatedBy, syncedAt, ...wordData } = cw
            storage.addWord(wordData)
          }
        }
        this.loadWords()
      }
    } catch (err) {
      console.error('拉取云端生词失败', err)
    }
  },

  onQuickMaster(e) {
    const id = e.currentTarget.dataset.id
    const word = storage.getWordById(id)
    if (!word) return

    storage.updateWord(word.id, {
      status: WORD_STATUS.MASTERED,
      reviewLevel: 7,
      stats: {
        ...word.stats,
        nextReview: Infinity
      }
    })
    wx.showToast({ title: '已标记为掌握', icon: 'success' })
    this.loadWords()
  },

  async onSync() {
    const allWords = storage.getAllWords()
    if (allWords.length === 0) {
      wx.showToast({ title: '没有需要同步的数据', icon: 'none' })
      return
    }

    wx.showLoading({ title: '同步中...' })
    try {
      await cloud.syncToCloud({ words: allWords })
      wx.hideLoading()
      wx.showToast({ title: '同步完成', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: '同步失败', icon: 'none' })
      console.error('同步失败', err)
    }
  }
})
