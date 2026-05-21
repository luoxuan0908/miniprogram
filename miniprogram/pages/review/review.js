const vocabStorage = require('../../utils/storage')
const resourceStorage = require('../../utils/resource-storage')

Page({
  data: {
    vocabStats: {
      total: 0,
      mastered: 0,
      learning: 0,
      newWords: 0,
      due: 0
    },
    resourceStats: {
      total: 0,
      documents: 0,
      segments: 0,
      cachedAudio: 0
    },
    ttsSpeed: 100,
    ttsSpeedLabel: '1.0x'
  },

  onShow() {
    this.loadStats()
    this.loadPreferences()
  },

  loadStats() {
    this.setData({
      vocabStats: vocabStorage.getStats(),
      resourceStats: resourceStorage.getStats()
    })
  },

  loadPreferences() {
    const prefs = wx.getStorageSync('study_preferences') || {}
    const speed = prefs.ttsSpeed || 100
    this.setData({
      ttsSpeed: speed,
      ttsSpeedLabel: `${(speed / 100).toFixed(1)}x`
    })
  },

  savePreferences(updates) {
    const prefs = wx.getStorageSync('study_preferences') || {}
    wx.setStorageSync('study_preferences', {
      ...prefs,
      ...updates
    })
  },

  onTtsSpeedChange(e) {
    const value = e.detail.value
    this.setData({
      ttsSpeed: value,
      ttsSpeedLabel: `${(value / 100).toFixed(1)}x`
    })
    this.savePreferences({ ttsSpeed: value })
  },

  onOpenVocabulary() {
    wx.navigateTo({ url: '/pages/vocabulary/vocabulary' })
  },

  onOpenDocuments() {
    wx.navigateTo({ url: '/pages/resources/resources' })
  },

  onExport() {
    const words = vocabStorage.getAllWords()
    const resources = resourceStorage.getAllResources()
    const payload = JSON.stringify({ words, resources }, null, 2)
    wx.setClipboardData({
      data: payload,
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    })
  },

  onClearAudioCache() {
    wx.showModal({
      title: '清除音频缓存',
      content: '这会清除本地文档音频引用，云端文件不会被删除。',
      success: res => {
        if (!res.confirm) return
        resourceStorage.clearAllAudioReferences()
        this.loadStats()
        wx.showToast({ title: '已清除', icon: 'success' })
      }
    })
  }
})
