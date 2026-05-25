const vocabStorage = require('../../utils/storage')
const resourceStorage = require('../../utils/resource-storage')
const userStorage = require('../../utils/user-storage')
const cloud = require('../../utils/cloud')
const audioManager = require('../../utils/audio-manager')
const studyDuration = require('../../utils/study-duration')

const app = getApp()

function isFunctionNotFoundError(err) {
  const message = String((err && (err.errMsg || err.message)) || err || '')
  return message.includes('-501000') ||
    message.includes('FUNCTION_NOT_FOUND') ||
    message.includes('FunctionName parameter could not be found')
}

Page({
  data: {
    // 用户资料
    nickName: '',
    avatarUrl: '',
    userId: '',
    // 学习统计
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
    durationStats: {
      todayLabel: '<1分钟',
      totalLabel: '<1分钟'
    },
    billingSummary: {
      balanceLabel: '--',
      chargedLabel: '--',
      ready: false
    },
    syncing: false
  },

  onShow() {
    this.loadProfile()
    this.loadStats()
    this.loadBillingSummary()
  },

  /** 加载用户资料 */
  loadProfile() {
    const profile = userStorage.getUserProfile()
    const openid = wx.getStorageSync('openid') || ''
    this.setData({
      nickName: profile.nickName || '',
      avatarUrl: profile.avatarUrl || '',
      userId: openid ? openid.slice(-8) : '24004789'
    })
  },

  /** 选择头像 */
  onChooseAvatar(e) {
    const { avatarUrl } = e.detail
    if (!avatarUrl) return

    wx.showLoading({ title: '上传头像...' })
    userStorage.uploadAvatar(avatarUrl).then(fileID => {
      userStorage.saveUserProfile({ avatarUrl: fileID })
      this.setData({ avatarUrl: fileID })
      // 同步到全局
      if (app.globalData) {
        app.globalData.userInfo = app.globalData.userInfo || {}
        app.globalData.userInfo.avatarUrl = fileID
        wx.setStorageSync('userInfo', app.globalData.userInfo)
      }
      wx.hideLoading()
      wx.showToast({ title: '头像已更新', icon: 'success' })
    }).catch(() => {
      wx.hideLoading()
      wx.showToast({ title: '上传失败', icon: 'none' })
    })
  },

  /** 昵称输入完成 */
  onNicknameInput(e) {
    const nickName = e.detail.value && e.detail.value.trim()
    if (!nickName || nickName === this.data.nickName) return

    userStorage.saveUserProfile({ nickName })
    this.setData({ nickName })
    // 同步到全局
    if (app.globalData) {
      app.globalData.userInfo = app.globalData.userInfo || {}
      app.globalData.userInfo.nickName = nickName
      wx.setStorageSync('userInfo', app.globalData.userInfo)
    }
    wx.showToast({ title: '昵称已更新', icon: 'success' })
  },

  loadStats() {
    this.setData({
      vocabStats: vocabStorage.getStats(),
      resourceStats: resourceStorage.getStats(),
      durationStats: studyDuration.getDurationStats()
    })
  },

  async loadBillingSummary() {
    try {
      const result = await cloud.getBillingAccount()
      const account = result.account || {}
      this.setData({
        billingSummary: {
          balanceLabel: account.balanceYuan || '0.0000',
          chargedLabel: account.chargedYuan || '0.0000',
          ready: true
        }
      })
    } catch (err) {
      console.warn('billing summary failed:', err && err.message)
      this.setData({
        billingSummary: {
          balanceLabel: isFunctionNotFoundError(err) ? '未部署' : '--',
          chargedLabel: '--',
          ready: false
        }
      })
    }
  },

  onOpenVocabulary() {
    wx.navigateTo({ url: '/pages/vocabulary/vocabulary' })
  },

  onOpenDocuments() {
    wx.navigateTo({ url: '/pages/resources/resources' })
  },

  onOpenMastered() {
    wx.navigateTo({ url: '/pages/vocabulary/vocabulary?tab=mastered' })
  },

  onOpenLearning() {
    wx.navigateTo({ url: '/pages/vocabulary/vocabulary?tab=learning' })
  },

  onOpenDue() {
    wx.navigateTo({ url: '/pages/vocabulary/vocabulary?tab=due' })
  },

  onOpenBilling() {
    wx.navigateTo({ url: '/pages/billing/billing' })
  },

  onExport() {
    const words = vocabStorage.getAllWords()
    const resources = resourceStorage.getAllResources()

    if (words.length === 0 && resources.length === 0) {
      wx.showToast({ title: '没有可导出的数据', icon: 'none' })
      return
    }

    wx.showActionSheet({
      itemList: ['JSON 完整备份', 'CSV 词汇列表', '纯文本词汇清单'],
      success: res => {
        let content, fileName
        const now = new Date()
        const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`

        switch (res.tapIndex) {
          case 0:
            content = this.generateJSON(words, resources)
            fileName = `study-hub-backup-${dateStr}.json`
            break
          case 1:
            content = this.generateCSV(words)
            fileName = `study-hub-vocabulary-${dateStr}.csv`
            break
          case 2:
            content = this.generateText(words, resources)
            fileName = `study-hub-vocabulary-${dateStr}.txt`
            break
        }

        this.pickExportMode(content, fileName)
      }
    })
  },

  pickExportMode(content, fileName) {
    wx.showActionSheet({
      itemList: ['复制到剪贴板', '分享到微信'],
      success: res => {
        if (res.tapIndex === 0) {
          this.copyExport(content)
        } else {
          this.shareExport(content, fileName)
        }
      }
    })
  },

  generateJSON(words, resources) {
    const stats = {
      ...vocabStorage.getStats(),
      totalResources: resourceStorage.getStats().total,
      segments: resourceStorage.getStats().segments
    }
    return JSON.stringify({
      appName: 'Study Hub',
      exportDate: new Date().toISOString(),
      stats,
      words,
      resources
    }, null, 2)
  },

  generateCSV(words) {
    const header = '单词,音标,中文提示,释义,状态,复习等级,正确率,创建日期'
    const rows = words.map(w => {
      const content = w.content || {}
      const stats = w.stats || {}
      const accuracy = stats.totalAttempts > 0
        ? Math.round(stats.correctCount / stats.totalAttempts * 100) + '%'
        : '-'
      const statusMap = { new: '新词', learning: '学习中', mastered: '已掌握' }
      const date = w.createdAt ? new Date(w.createdAt).toISOString().slice(0, 10) : ''
      // CSV 转义：字段含逗号或换行时加引号
      const esc = s => {
        const str = String(s || '').replace(/"/g, '""')
        return str.includes(',') || str.includes('\n') || str.includes('"') ? `"${str}"` : str
      }
      return [
        esc(w.word), esc(content.phonetic), esc(content.chineseHint), esc(content.shortDefinition),
        statusMap[w.status] || w.status, w.reviewLevel || 0,
        accuracy, date
      ].join(',')
    })
    return [header, ...rows].join('\n')
  },

  generateText(words, resources) {
    const vStats = vocabStorage.getStats()
    const rStats = resourceStorage.getStats()
    const now = new Date()
    const timeStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const statusMap = { new: '新词', learning: '学习中', mastered: '已掌握' }

    const lines = [
      'Study Hub · 学习数据导出',
      `导出时间：${timeStr}`,
      '──────────────────────────',
      '',
      '📊 数据概览',
      `  总词汇 ${vStats.total} 个 | 已掌握 ${vStats.mastered} 个 | 学习中 ${vStats.learning} 个 | 新词 ${vStats.newWords} 个`,
    ]

    if (rStats.total > 0) {
      lines.push(`  文档资源 ${rStats.total} 个 | 段落 ${rStats.segments} 段`)
    }

    if (words.length > 0) {
      lines.push('')
      lines.push('──────────────────────────')
      lines.push(`📝 词汇列表（共 ${words.length} 个）`)
      lines.push('──────────────────────────')
      lines.push('')

      words.forEach(w => {
        const content = w.content || {}
        const stats = w.stats || {}
        const accuracy = stats.totalAttempts > 0
          ? `${Math.round(stats.correctCount / stats.totalAttempts * 100)}% (${stats.correctCount}/${stats.totalAttempts})`
          : '未练习'

        lines.push(`${w.word} · ${statusMap[w.status] || w.status} (R${w.reviewLevel || 0})`)
        if (content.phonetic) lines.push(`  音标：${content.phonetic}`)
        if (content.chineseHint) lines.push(`  提示：${content.chineseHint}`)
        if (content.shortDefinition) lines.push(`  释义：${content.shortDefinition}`)
        lines.push(`  正确率：${accuracy}`)
        lines.push('')
      })
    }

    return lines.join('\n')
  },

  shareExport(content, fileName) {
    const fs = wx.getFileSystemManager()
    const tmpPath = `${wx.env.USER_DATA_PATH}/${fileName}`

    try {
      fs.writeFileSync(tmpPath, content, 'utf8')
      wx.shareFileMessage({
        filePath: tmpPath,
        fileName,
        success: () => wx.showToast({ title: '已分享', icon: 'success' }),
        fail: err => {
          console.error('分享失败', err)
          // 部分安卓机型不支持 shareFileMessage，fallback 到复制
          wx.setClipboardData({
            data: content,
            success: () => wx.showToast({ title: '分享暂不可用，已复制', icon: 'none' })
          })
        }
      })
    } catch (e) {
      console.error('写文件失败', e)
      wx.setClipboardData({
        data: content,
        success: () => wx.showToast({ title: '已复制到剪贴板', icon: 'success' })
      })
    }
  },

  copyExport(content) {
    wx.setClipboardData({
      data: content,
      success: () => wx.showToast({ title: '已复制到剪贴板', icon: 'success' })
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

  onOpenAdmin() {
    wx.navigateTo({ url: '/pages/admin/admin' })
  },

  async onSyncToCloud() {
    if (this.data.syncing) return
    const words = vocabStorage.getAllWords()
    const resources = resourceStorage.getAllResources()
    const preferences = userStorage.getPreferences()

    if (words.length === 0 && resources.length === 0 && Object.keys(preferences).length === 0) {
      wx.showToast({ title: '没有需要同步的数据', icon: 'none' })
      return
    }

    this.setData({ syncing: true })
    try {
      const result = await cloud.syncToCloud({ words, resources, preferences })
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
      const cloudPreferences = result.preferences && typeof result.preferences === 'object' ? result.preferences : null
      let merged = 0

      if (cloudPreferences) {
        userStorage.savePreferences(cloudPreferences)
      }

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
