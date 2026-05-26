const vocabStorage = require('../../utils/storage')
const resourceStorage = require('../../utils/resource-storage')
const userStorage = require('../../utils/user-storage')
const studyDuration = require('../../utils/study-duration')
const cloud = require('../../utils/cloud')

const DAILY_SESSION_KEY = 'daily_learning_session'

function isFunctionNotFoundError(err) {
  const message = String((err && (err.errMsg || err.message)) || err || '')
  return message.includes('-501000') ||
    message.includes('FUNCTION_NOT_FOUND') ||
    message.includes('FunctionName parameter could not be found')
}

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

Page({
  data: {
    userName: 'Xuan Luo',
    userId: '',
    vocabStats: {},
    resourceStats: {},
    billingSummary: {
      balanceLabel: '--',
      chargedLabel: '--',
      callCountLabel: '0',
      unpricedCount: 0,
      ready: false
    },
    daily: {},
    recentResources: [],
    recentWords: [],
    modules: [
      { key: 'documents', icon: '▤', title: '文档库', desc: '阅读和听读文章', enabled: true },
      { key: 'courses', icon: '◆', title: '课程', desc: '系统化学习英语表达', enabled: true },
      { key: 'vocabulary', icon: '▣', title: '生词本', desc: '管理你的单词列表', enabled: true }
    ]
  },

  onShow() {
    this.loadDashboard()
    this.loadBillingSummary()
  },

  loadDashboard() {
    const openid = wx.getStorageSync('openid') || ''
    const userInfo = userStorage.getUserProfile() || {}
    const vocabStats = vocabStorage.getStats()
    const resourceStats = resourceStorage.getStats()
    const recentResources = resourceStorage.getRecentResources(3)
    const recentWords = vocabStorage.getRecentRecords(3)
    const daily = this.getDailySummary()
    const durationStats = studyDuration.getDurationStats()

    this.setData({
      userName: userInfo.nickName || '学习者',
      userId: openid ? openid.slice(-8) : '24004789',
      vocabStats,
      resourceStats,
      daily: {
        ...daily,
        durationLabel: durationStats.todayLabel
      },
      recentResources,
      recentWords
    })
  },

  async loadBillingSummary() {
    try {
      const result = await cloud.getBillingAccount()
      const account = result.account || {}
      const recentLedger = result.recentLedger || []
      const usageSummary = result.usageSummary || {}
      this.setData({
        billingSummary: {
          balanceLabel: account.balanceYuan || '0.0000',
          chargedLabel: account.chargedYuan || '0.0000',
          callCountLabel: String(Number(usageSummary.totalCalls || recentLedger.length || 0)),
          unpricedCount: recentLedger.filter(item => item.pendingPricing || item.pricingStatus === 'unpriced').length,
          ready: true
        }
      })
    } catch (err) {
      console.warn('billing summary failed:', err && err.message)
      this.setData({
        billingSummary: {
          balanceLabel: isFunctionNotFoundError(err) ? '未部署' : '--',
          chargedLabel: '--',
          callCountLabel: '0',
          unpricedCount: 0,
          ready: false
        }
      })
    }
  },

  getDailySummary() {
    const date = todayKey()
    const session = wx.getStorageSync(DAILY_SESSION_KEY)
    if (session && session.date === date) {
      const completed = (session.completedTaskIds || []).length
      const total = (session.tasks || []).length
      return {
        completed,
        total,
        progress: total ? Math.round((completed / total) * 100) : 100
      }
    }

    const dueCount = vocabStorage.getDueWords().slice(0, 5).length
    const words = vocabStorage.getAllWords()
    const hasShadowing = words.length > 0
    const hasMistake = words.some(word => (word.mistakes || []).length > 0)
    const total = dueCount + (hasShadowing ? 1 : 0) + (hasMistake ? 1 : 0)

    return {
      completed: 0,
      total,
      progress: total ? 0 : 100
    }
  },

  onModuleTap(e) {
    const key = e.currentTarget.dataset.key
    if (key === 'documents') {
      wx.navigateTo({ url: '/pages/resources/resources' })
      return
    }
    if (key === 'courses') {
      wx.navigateTo({ url: '/pages/courses/courses' })
      return
    }
    if (key === 'vocabulary') {
      wx.navigateTo({ url: '/pages/vocabulary/vocabulary' })
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

  onOpenDailySession() {
    wx.navigateTo({ url: '/pages/daily-session/daily-session' })
  },

  onOpenBilling() {
    wx.navigateTo({ url: '/pages/billing/billing' })
  },

})
