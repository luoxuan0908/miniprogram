const vocabStorage = require('../../utils/storage')
const resourceStorage = require('../../utils/resource-storage')
const userStorage = require('../../utils/user-storage')
const cloud = require('../../utils/cloud')

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
    ttsSpeedLabel: '1.0x',
    syncing: false
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
    const prefs = userStorage.getPreferences()
    const speed = prefs.ttsSpeed || 100
    this.setData({
      ttsSpeed: speed,
      ttsSpeedLabel: `${(speed / 100).toFixed(1)}x`
    })
  },

  savePreferences(updates) {
    userStorage.savePreferences(updates)
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
  },

  async onSyncToCloud() {
    if (this.data.syncing) return
    const words = vocabStorage.getAllWords()
    const resources = resourceStorage.getAllResources()
    if (words.length === 0 && resources.length === 0) {
      wx.showToast({ title: '没有需要同步的数据', icon: 'none' })
      return
    }

    this.setData({ syncing: true })
    try {
      const result = await cloud.syncToCloud({ words, resources })
      wx.showToast({ title: '同步完成', icon: 'success' })
    } catch (err) {
      console.error('同步失败', err)
      wx.showToast({ title: '同步失败', icon: 'none' })
    } finally {
      this.setData({ syncing: false })
    }
  },

  async onPullFromCloud() {
    if (this.data.syncing) return
    this.setData({ syncing: true })
    wx.showLoading({ title: '拉取中...' })
    try {
      const result = await cloud.syncToCloud({ action: 'pull', scope: 'all' })
      wx.hideLoading()

      const cloudWords = result.words || []
      const cloudResources = result.resources || []
      let merged = 0

      // 合并生词：云端有本地没有的，添加到本地
      if (cloudWords.length > 0) {
        const localWords = vocabStorage.getAllWords()
        const localIds = new Set(localWords.map(w => w.id))
        for (const cw of cloudWords) {
          if (!localIds.has(cw.id)) {
            const { _id, _openid, ownerId, createdBy, updatedBy, syncedAt, ...wordData } = cw
            vocabStorage.addWord(wordData)
            merged++
          } else {
            // 本地已有，取 updatedAt 更新的
            const local = localWords.find(w => w.id === cw.id)
            if (cw.updatedAt > local.updatedAt) {
              const { _id, _openid, ownerId, createdBy, updatedBy, syncedAt, ...wordData } = cw
              vocabStorage.updateWord(cw.id, wordData)
              merged++
            }
          }
        }
      }

      // 合并资源：云端有本地没有的，添加到本地
      if (cloudResources.length > 0) {
        const localResources = resourceStorage.getAllResources()
        const localIds = new Set(localResources.map(r => r.id))
        for (const cr of cloudResources) {
          if (!localIds.has(cr.id)) {
            const { _id, _openid, ownerId, createdBy, updatedBy, syncedAt, ...resData } = cr
            resourceStorage.addResource(resData)
            merged++
          } else {
            const local = localResources.find(r => r.id === cr.id)
            if (cr.updatedAt > local.updatedAt) {
              const { _id, _openid, ownerId, createdBy, updatedBy, syncedAt, ...resData } = cr
              resourceStorage.updateResource(cr.id, resData)
              merged++
            }
          }
        }
      }

      this.loadStats()
      wx.showToast({ title: merged > 0 ? `已合并 ${merged} 条` : '已是最新', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      console.error('拉取失败', err)
      wx.showToast({ title: '拉取失败', icon: 'none' })
    } finally {
      this.setData({ syncing: false })
    }
  }
})
