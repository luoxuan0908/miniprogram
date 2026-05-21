const storage = require('../../utils/storage')
const cloud = require('../../utils/cloud')
const { WORD_STATUS } = require('../../utils/constants')

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

  onShow() {
    this.loadWords()
  },

  loadWords() {
    this.setData({ loading: true })
    const allWords = storage.getAllWords()
    const tabCounts = {
      all: allWords.length,
      new: allWords.filter(w => w.status === WORD_STATUS.NEW).length,
      learning: allWords.filter(w => w.status === WORD_STATUS.LEARNING).length,
      mastered: allWords.filter(w => w.status === WORD_STATUS.MASTERED).length
    }

    let words = this.data.searchQuery ? storage.searchWords(this.data.searchQuery) : allWords
    if (this.data.activeTab !== 'all') {
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
      await cloud.syncToCloud(allWords)
      wx.hideLoading()
      wx.showToast({ title: '同步完成', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: '同步失败', icon: 'none' })
      console.error('同步失败', err)
    }
  }
})
