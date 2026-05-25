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
      this.setData({
        billingSummary: {
          balanceLabel: account.balanceYuan || '0.0000',
          chargedLabel: account.chargedYuan || '0.0000',
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
    const hasSegment = !!resourceStorage.pickShadowSegment()
    const words = vocabStorage.getAllWords()
    const hasShadowing = words.length > 0
    const hasMistake = words.some(word => (word.mistakes || []).length > 0)
    const total = dueCount + (hasSegment ? 1 : 0) + (hasShadowing ? 1 : 0) + (hasMistake ? 1 : 0)

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

  // ===== 临时：课程数据导入管理 =====
  onImportAdmin() {
    wx.showActionSheet({
      itemList: ['1. 查看导入状态', '2. 导入课程元数据', '3. 上传条目文件到云存储', '4. 导入一批条目(50条)', '5. 连续导入全部条目', '6. 清理所有课程数据'],
      success: (res) => {
        const actions = ['status', 'importCourses', 'uploadBatch', 'importOneBatch', 'importAllBatches', 'cleanupAll']
        this._callImportFn(actions[res.tapIndex])
      }
    })
  },

  _currentBatch: 1,
  _totalBatches: 28,

  _callImportFn(action) {
    if (action === 'status') {
      this._callCloud({ action: 'status' })
    } else if (action === 'importCourses') {
      this._callCloud({ action: 'importCourses' })
    } else if (action === 'uploadBatch') {
      this._uploadBatchFiles()
    } else if (action === 'importOneBatch') {
      this._importOneBatch()
    } else if (action === 'importAllBatches') {
      this._importAllBatches()
    } else if (action === 'cleanupAll') {
      this._cleanupAll()
    }
  },

  _uploadBatchFiles() {
    const that = this
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json'],
      success(res) {
        const filePath = res.tempFiles[0].path
        const fileName = res.tempFiles[0].name
        wx.showLoading({ title: '上传中...' })
        wx.cloud.uploadFile({
          cloudPath: 'course-import/' + fileName,
          filePath: filePath,
          success(uploadRes) {
            wx.hideLoading()
            wx.showModal({
              title: '上传成功',
              content: '文件ID: ' + uploadRes.fileID + '\n文件名: ' + fileName,
              showCancel: false
            })
          },
          fail(err) {
            wx.hideLoading()
            wx.showModal({ title: '上传失败', content: err.message, showCancel: false })
          }
        })
      }
    })
  },

  _importOneBatch() {
    const batchNum = this._currentBatch
    if (batchNum > this._totalBatches) {
      wx.showToast({ title: '全部导入完成!', icon: 'success' })
      return
    }
    const fileName = 'items_50_' + String(batchNum).padStart(2, '0') + '.json'
    const cloudPath = 'course-import/' + fileName
    wx.showLoading({ title: '导入第' + batchNum + '批...' })

    // 先获取文件 fileID
    wx.cloud.getTempFileURL({
      fileList: [cloudPath],
      success: (res) => {
        const fileID = res.fileList[0].fileID
        wx.cloud.callFunction({
          name: 'importCourseData',
          data: { action: 'importItemsBatch', fileID }
        }).then(fnRes => {
          wx.hideLoading()
          wx.showModal({
            title: '第' + batchNum + '/' + this._totalBatches + '批',
            content: '成功: ' + (fnRes.result.success || 0) + '\n失败: ' + (fnRes.result.error || 0),
            showCancel: false,
            success: () => {
              this._currentBatch = batchNum + 1
            }
          })
        }).catch(err => {
          wx.hideLoading()
          wx.showModal({ title: '导入失败', content: err.message, showCancel: false })
        })
      },
      fail: (err) => {
        wx.hideLoading()
        wx.showModal({ title: '获取文件失败', content: '请先上传条目文件到云存储\n' + err.message, showCancel: false })
      }
    })
  },

  async _importAllBatches() {
    const confirmed = await new Promise(resolve => {
      wx.showModal({
        title: '批量导入',
        content: '将连续导入' + this._totalBatches + '批(共1355条)，请确保已上传所有文件到云存储。开始?',
        success(res) { resolve(res.confirm) },
        fail() { resolve(false) }
      })
    })
    if (!confirmed) return

    let successTotal = 0, errorTotal = 0
    for (let i = this._currentBatch; i <= this._totalBatches; i++) {
      const fileName = 'items_50_' + String(i).padStart(2, '0') + '.json'
      const cloudPath = 'course-import/' + fileName
      wx.showLoading({ title: '导入 ' + i + '/' + this._totalBatches })

      try {
        const tempRes = await wx.cloud.getTempFileURL({ fileList: [cloudPath] })
        const fileID = tempRes.fileList[0].fileID
        const fnRes = await wx.cloud.callFunction({
          name: 'importCourseData',
          data: { action: 'importItemsBatch', fileID }
        })
        successTotal += (fnRes.result.success || 0)
        errorTotal += (fnRes.result.error || 0)
        this._currentBatch = i + 1
      } catch (err) {
        console.error('第' + i + '批失败:', err)
        errorTotal += 50
      }
    }
    wx.hideLoading()
    wx.showModal({
      title: '导入完成',
      content: '成功: ' + successTotal + '\n失败: ' + errorTotal + '\n当前批次: ' + this._currentBatch,
      showCancel: false
    })
  },

  _cleanupAll() {
    wx.showModal({
      title: '确认清理',
      content: '将清理 courses 和 course_items 集合的所有数据，确定?',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '清理中...' })
        Promise.all([
          this._callCloudPromise({ action: 'cleanup', collection: 'courses' }),
          this._callCloudPromise({ action: 'cleanup', collection: 'course_items' })
        ]).then(([r1, r2]) => {
          wx.hideLoading()
          wx.showModal({
            title: '清理完成',
            content: 'courses删除: ' + (r1.deleted || 0) + '\ncourse_items删除: ' + (r2.deleted || 0),
            showCancel: false
          })
        }).catch(err => {
          wx.hideLoading()
          wx.showModal({ title: '清理失败', content: err.message, showCancel: false })
        })
      }
    })
  },

  _callCloudPromise(data) {
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({ name: 'importCourseData', data,
        success: res => resolve(res.result),
        fail: err => reject(err)
      })
    })
  },

  _callCloud(data) {
    wx.showLoading({ title: '执行中...' })
    wx.cloud.callFunction({
      name: 'importCourseData',
      data
    }).then(res => {
      wx.hideLoading()
      wx.showModal({
        title: '执行结果',
        content: JSON.stringify(res.result, null, 2),
        showCancel: false
      })
    }).catch(err => {
      wx.hideLoading()
      wx.showModal({ title: '执行失败', content: err.message || '未知错误', showCancel: false })
    })
  }
  // ===== 临时结束 =====
})
