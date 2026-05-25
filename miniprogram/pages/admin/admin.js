/**
 * admin.js - 管理工具页面
 * 
 * 方案C: 从本地 HTTP 服务下载文件 → 上传到云存储 → 更新数据库
 * 
 * 前提:
 * 1. 先启动本地服务: node scripts/audio-server.js
 * 2. 微信开发者工具勾选「不校验合法域名」
 */
Page({
  data: {
    uploading: false,
    completed: 0,
    total: 1355,
    successCount: 0,
    failCount: 0,
    dbUpdated: 0,
    hasFailed: false,
    failedCount: 0,
    logs: [],
    currentIndex: 0,
    serverUrl: 'http://localhost:8080'
  },

  _failedIndices: [],
  _currentIndex: 1,
  _isPaused: false,
  _uploadedMap: {}, // { "001.1": "cloud://xxx" }

  onLoad() {
    // 从本地缓存恢复已上传进度
    try {
      const saved = wx.getStorageSync('idiom_audio_progress')
      if (saved) {
        this._uploadedMap = JSON.parse(saved)
        const count = Object.keys(this._uploadedMap).length
        if (count > 0) {
          this._addLog(`恢复进度: 已有 ${count} 个文件`, 'success')
        }
      }
    } catch (e) { /* ignore */ }
  },

  _addLog(msg, type = '') {
    const logs = this.data.logs.concat({ msg, type, time: new Date().toLocaleTimeString() })
    if (logs.length > 200) logs.splice(0, logs.length - 200)
    this.setData({ logs })
  },

  _saveProgress() {
    try {
      wx.setStorageSync('idiom_audio_progress', JSON.stringify(this._uploadedMap))
    } catch (e) { /* ignore */ }
  },

  /**
   * 下载本地文件并上传到云存储
   */
  async _uploadOneFile(index, sub) {
    const numStr = String(index).padStart(3, '0')
    const fileName = `${numStr}.${sub}.mp3`
    const cloudPath = `idioms-audio/${fileName}`
    const progressKey = `${numStr}.${sub}`

    // 检查是否已上传（从缓存）
    if (this._uploadedMap[progressKey]) {
      return { fileID: this._uploadedMap[progressKey], skipped: true }
    }

    const serverUrl = this.data.serverUrl

    // 步骤1: 从本地服务下载到临时文件
    const downloadRes = await new Promise((resolve, reject) => {
      wx.downloadFile({
        url: `${serverUrl}/audio/${fileName}`,
        success: resolve,
        fail: reject
      })
    })

    if (downloadRes.statusCode !== 200) {
      throw new Error(`下载失败: HTTP ${downloadRes.statusCode}`)
    }

    // 步骤2: 上传到云存储
    const uploadRes = await new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath,
        filePath: downloadRes.tempFilePath,
        success: resolve,
        fail: reject
      })
    })

    const fileID = uploadRes.fileID

    // 记录进度
    this._uploadedMap[progressKey] = fileID

    return { fileID, skipped: false }
  },

  /**
   * 更新数据库中的 audio 字段
   */
  async _updateDatabase(index, audioMap) {
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'updateIdiomAudio',
        data: { index, audioMap },
        success: r => resolve(r.result),
        fail: e => reject(e)
      })
    })
  },

  async startUpload() {
    if (this.data.uploading) return

    this._failedIndices = []
    this._isPaused = false
    this.setData({
      uploading: true,
      completed: 0,
      successCount: 0,
      failCount: 0,
      dbUpdated: 0,
      hasFailed: false,
      failedCount: 0,
      currentIndex: 1
    })

    // 先测试本地服务是否可用
    this._addLog('测试本地服务连接...')
    try {
      const testRes = await new Promise((resolve, reject) => {
        wx.downloadFile({
          url: `${this.data.serverUrl}/audio/001.1.mp3`,
          success: resolve,
          fail: reject
        })
      })
      if (testRes.statusCode !== 200) {
        throw new Error(`HTTP ${testRes.statusCode}`)
      }
      this._addLog('✅ 本地服务连接成功', 'success')
    } catch (err) {
      this._addLog('❌ 本地服务连接失败！请先运行: node scripts/audio-server.js', 'error')
      this.setData({ uploading: false })
      return
    }

    this._addLog('开始上传，共 1355 条习语', 'success')

    for (let i = 1; i <= 1355; i++) {
      if (this._isPaused) break

      this._currentIndex = i
      this.setData({ currentIndex: i })

      const numStr = String(i).padStart(3, '0')
      const audioMap = {}
      let success = 0
      let fail = 0
      let skipped = 0

      for (let sub = 1; sub <= 3; sub++) {
        try {
          const result = await this._uploadOneFile(i, sub)
          if (result.skipped) {
            skipped++
          } else {
            success++
          }
          audioMap[`${numStr}.${sub}`] = result.fileID
        } catch (err) {
          fail++
          this._addLog(`#${numStr}.${sub} 失败: ${err.errMsg || err.message}`, 'error')
        }
      }

      // 更新数据库
      let dbOk = false
      if (Object.keys(audioMap).length > 0) {
        try {
          const dbRes = await this._updateDatabase(i, audioMap)
          dbOk = dbRes && dbRes.success
        } catch (err) {
          this._addLog(`#${i} DB更新失败: ${err.errMsg || err.message}`, 'error')
        }
      }

      this.setData({
        completed: this.data.completed + 1,
        successCount: this.data.successCount + success,
        failCount: this.data.failCount + fail,
        dbUpdated: this.data.dbUpdated + (dbOk ? 1 : 0)
      })

      if (fail > 0) this._failedIndices.push(i)

      // 每50条保存进度 + 记日志
      if (i % 50 === 0 || fail > 0) {
        this._saveProgress()
        this._addLog(`#${i}: 成功${success} 跳过${skipped} 失败${fail} DB${dbOk ? '✓' : '✗'}`)
      }

      // 间隔 200ms
      await new Promise(r => setTimeout(r, 200))
    }

    // 最终保存
    this._saveProgress()

    this.setData({
      uploading: false,
      hasFailed: this._failedIndices.length > 0,
      failedCount: this._failedIndices.length
    })
    this._addLog(`===== 完成 ===== 成功:${this.data.successCount} 失败:${this.data.failCount} DB:${this.data.dbUpdated}`, 'success')
  },

  pauseUpload() {
    this._isPaused = true
    this._saveProgress()
    this._addLog('已暂停，进度已保存', 'error')
  },

  async retryFailed() {
    if (this.data.uploading || this._failedIndices.length === 0) return

    const retryIndices = [...this._failedIndices]
    this._failedIndices = []
    this.setData({ hasFailed: false, failedCount: 0, uploading: true })

    this._addLog(`重试 ${retryIndices.length} 个失败条目`, 'success')

    for (const idx of retryIndices) {
      const numStr = String(idx).padStart(3, '0')
      const audioMap = {}
      let fail = 0

      for (let sub = 1; sub <= 3; sub++) {
        try {
          const result = await this._uploadOneFile(idx, sub)
          audioMap[`${numStr}.${sub}`] = result.fileID
        } catch (err) {
          fail++
        }
      }

      if (fail === 0) {
        try {
          await this._updateDatabase(idx, audioMap)
          this.setData({ dbUpdated: this.data.dbUpdated + 1 })
          this._addLog(`重试 #${idx}: 成功`)
        } catch (err) {
          this._failedIndices.push(idx)
        }
      } else {
        this._failedIndices.push(idx)
        this._addLog(`重试 #${idx} 仍失败`, 'error')
      }

      await new Promise(r => setTimeout(r, 200))
    }

    this._saveProgress()
    this.setData({
      uploading: false,
      hasFailed: this._failedIndices.length > 0,
      failedCount: this._failedIndices.length
    })
  },

  clearProgress() {
    wx.removeStorageSync('idiom_audio_progress')
    this._uploadedMap = {}
    this._addLog('已清除进度缓存', 'success')
  }
})
