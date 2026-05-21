const vocabStorage = require('../../utils/storage')
const resourceStorage = require('../../utils/resource-storage')

Page({
  data: {
    userName: 'Xuan Luo',
    userId: '',
    vocabStats: {},
    resourceStats: {},
    recentResources: [],
    recentWords: [],
    modules: [
      { key: 'documents', icon: '▤', title: '文档库', desc: '阅读和听读文章', enabled: true },
      { key: 'vocabulary', icon: '▣', title: '生词本', desc: '管理你的单词列表', enabled: true },
      { key: 'practice', icon: '◉', title: '听力练习', desc: '听力与跟读', enabled: true },
      { key: 'preferences', icon: '♙', title: '个人中心', desc: '统计与设置', enabled: true }
    ]
  },

  onShow() {
    this.loadDashboard()
  },

  loadDashboard() {
    const openid = wx.getStorageSync('openid') || ''
    const userInfo = wx.getStorageSync('userInfo') || {}
    const vocabStats = vocabStorage.getStats()
    const resourceStats = resourceStorage.getStats()
    const recentResources = resourceStorage.getRecentResources(3)
    const recentWords = vocabStorage.getRecentRecords(3)

    this.setData({
      userName: userInfo.nickName || 'Xuan Luo',
      userId: openid ? openid.slice(-8) : '24004789',
      vocabStats,
      resourceStats,
      recentResources,
      recentWords
    })
  },

  onModuleTap(e) {
    const key = e.currentTarget.dataset.key
    if (key === 'documents') {
      wx.navigateTo({ url: '/pages/resources/resources' })
      return
    }
    if (key === 'vocabulary') {
      wx.navigateTo({ url: '/pages/vocabulary/vocabulary' })
      return
    }
    if (key === 'practice') {
      wx.switchTab({ url: '/pages/listen/listen' })
      return
    }
    if (key === 'preferences') {
      wx.switchTab({ url: '/pages/review/review' })
      return
    }
    wx.showToast({ title: 'Coming soon', icon: 'none' })
  },

  onOpenResource(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/resource-detail/resource-detail?id=${id}` })
  },

  onOpenWord(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/word-detail/word-detail?id=${id}` })
  },

  onAddResource() {
    wx.navigateTo({ url: '/pages/resources/resources?add=1' })
  },

  onStartPractice() {
    wx.switchTab({ url: '/pages/listen/listen' })
  }
})
