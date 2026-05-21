const vocabStorage = require('../../utils/storage')
const resourceStorage = require('../../utils/resource-storage')

Page({
  data: {
    dueCount: 0,
    resourceCount: 0,
    recentResource: null,
    documentDesc: '逐段阅读与听读'
  },

  onShow() {
    this.loadPracticeState()
  },

  loadPracticeState() {
    const dueCount = vocabStorage.getDueWords().length
    const recentResources = resourceStorage.getRecentResources(1)
    const resourceStats = resourceStorage.getStats()

    this.setData({
      dueCount,
      resourceCount: resourceStats.documents,
      recentResource: recentResources[0] || null,
      documentDesc: recentResources[0]
        ? `继续阅读 ${recentResources[0].title}`
        : '逐段阅读与听读'
    })
  },

  onDocumentPractice() {
    if (this.data.recentResource) {
      wx.navigateTo({ url: `/pages/resource-detail/resource-detail?id=${this.data.recentResource.id}` })
      return
    }
    wx.navigateTo({ url: '/pages/resources/resources?add=1' })
  },

  onVocabularyPractice() {
    wx.navigateTo({ url: '/pages/vocab-listen/vocab-listen' })
  }
})
