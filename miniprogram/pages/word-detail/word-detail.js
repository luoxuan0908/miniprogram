const storage = require('../../utils/storage')
const cloud = require('../../utils/cloud')
const audioManager = require('../../utils/audio-manager')
const { WORD_STATUS, MAX_REVIEW_LEVEL, DIFFICULTY_LABELS } = require('../../utils/constants')

Page({
  data: {
    word: null,
    loading: true,
    isRegeneratingAudio: false,
    expandedSections: {
      definition: true,
      examples: false,
      collocations: false,
      rootAffix: false,
      synonyms: false,
      memoryTip: false
    },
    difficultyLabels: DIFFICULTY_LABELS,
    accuracy: 0,
    reviewProgress: 0
  },

  onLoad(options) {
    const id = options.id
    if (id) {
      this.loadWord(id)
    } else {
      this.setData({ loading: false })
    }
  },

  onUnload() {
    audioManager.stopAudio()
  },

  loadWord(id) {
    const word = storage.getWordById(id)
    if (word) {
      const total = word.stats.totalAttempts || 0
      const correct = word.stats.correctCount || 0
      const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0
      const reviewProgress = Math.round((word.reviewLevel / MAX_REVIEW_LEVEL) * 100)

      this.setData({
        word,
        loading: false,
        accuracy,
        reviewProgress
      })
    } else {
      this.setData({ word: null, loading: false })
    }
  },

  /** 切换可折叠区域 */
  onToggle(e) {
    const section = e.currentTarget.dataset.section
    const key = `expandedSections.${section}`
    this.setData({
      [key]: !this.data.expandedSections[section]
    })
  },

  /** 播放单词音频 */
  onPlayWordAudio() {
    const word = this.data.word
    if (!word || !word.audio || !word.audio.wordAudio) {
      wx.showToast({ title: '音频未生成', icon: 'none' })
      return
    }

    audioManager.playAudio(word.audio.wordAudio)
      .catch(() => {
        wx.showToast({ title: '播放失败', icon: 'none' })
      })
  },

  /** 切换掌握状态 */
  onToggleStatus(e) {
    const word = this.data.word
    const newStatus = word.status === WORD_STATUS.MASTERED
      ? WORD_STATUS.LEARNING
      : WORD_STATUS.MASTERED

    const newLevel = newStatus === WORD_STATUS.MASTERED ? MAX_REVIEW_LEVEL : word.reviewLevel

    storage.updateWord(word.id, {
      status: newStatus,
      reviewLevel: newLevel,
      stats: {
        ...word.stats,
        nextReview: newStatus === WORD_STATUS.MASTERED ? Infinity : word.stats.nextReview
      }
    })

    wx.showToast({
      title: newStatus === WORD_STATUS.MASTERED ? '已标记为掌握' : '已恢复为学习中',
      icon: 'success'
    })

    this.loadWord(word.id)
  },

  /** 删除单词 */
  onDelete() {
    wx.showModal({
      title: '确认删除',
      content: `确定删除 "${this.data.word.word}" 吗？`,
      success: res => {
        if (res.confirm) {
          storage.deleteWord(this.data.word.id)
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 1000)
        }
      }
    })
  },

  /** 开始听力训练 */
  onStartListen() {
    wx.navigateTo({ url: '/pages/vocab-listen/vocab-listen' })
  },

  /** 重新生成音频（每个音频独立 try/catch，保存部分结果） */
  async onRegenerateAudio() {
    const word = this.data.word
    if (!word) return

    this.setData({ isRegeneratingAudio: true })
    wx.showLoading({ title: '生成音频中...', mask: true })

    const audio = { wordAudio: '', clozeAudio: '', fullAudio: '' }
    let errorMsg = ''

    // 生成单词发音
    try {
      audio.wordAudio = await cloud.synthesizeSpeech(word.word, 'word')
    } catch (err) {
      console.error('单词音频生成失败', err)
      errorMsg = '单词音频: ' + (err.message || '失败')
    }

    // 生成挖空例句音频
    if (word.content.clozeExample) {
      try {
        await new Promise(r => setTimeout(r, 1000))
        const clozeText = word.content.clozeExample.replace(/___/g, '...')
        audio.clozeAudio = await cloud.synthesizeSpeech(clozeText, 'cloze')
      } catch (err) {
        console.error('挖空例句音频生成失败', err)
        if (errorMsg) errorMsg += '; '
        errorMsg += '挖空音频: ' + (err.message || '失败')
      }
    }

    // 生成完整例句音频
    const fullExample = word.content.examples && word.content.examples[0]
    if (fullExample) {
      try {
        await new Promise(r => setTimeout(r, 1000))
        audio.fullAudio = await cloud.synthesizeSpeech(fullExample, 'full')
      } catch (err) {
        console.error('完整例句音频生成失败', err)
        if (errorMsg) errorMsg += '; '
        errorMsg += '完整例句音频: ' + (err.message || '失败')
      }
    }

    // 保存已生成的音频
    if (audio.wordAudio || audio.clozeAudio || audio.fullAudio) {
      storage.updateWord(word.id, { audio })
    }

    wx.hideLoading()

    if (errorMsg && !audio.wordAudio && !audio.clozeAudio && !audio.fullAudio) {
      wx.showToast({ title: '全部音频生成失败', icon: 'none', duration: 3000 })
    } else if (errorMsg) {
      wx.showToast({ title: '部分音频生成失败', icon: 'none', duration: 3000 })
    } else {
      wx.showToast({ title: '音频生成完成', icon: 'success' })
    }

    this.loadWord(word.id)
    this.setData({ isRegeneratingAudio: false })
  }
})
