const storage = require('../../utils/storage')
const cloud = require('../../utils/cloud')
const phonetic = require('../../utils/phonetic')
const { DIFFICULTY_LABELS } = require('../../utils/constants')
const studyDuration = require('../../utils/study-duration')

Page({
  data: {
    inputWord: '',
    isGenerating: false,
    generatedContent: null,
    errorMsg: '',
    difficultyLabels: DIFFICULTY_LABELS
  },

  onShow() {
    studyDuration.startSession('add-word')
  },

  onHide() {
    studyDuration.stopSession('add-word')
  },

  onUnload() {
    studyDuration.stopSession('add-word')
  },

  onInput(e) {
    this.setData({
      inputWord: e.detail.value,
      errorMsg: ''
    })
  },

  /** 生成学习内容 */
  async onGenerate() {
    const word = this.data.inputWord.trim()
    if (!word) {
      this.setData({ errorMsg: '请输入单词' })
      return
    }

    this.setData({ isGenerating: true, errorMsg: '', generatedContent: null })

    try {
      const content = phonetic.ensureContentPhonetic(word, await cloud.generateContent(word))
      if (!content.phonetic) {
        const generatedPhonetic = await cloud.generatePhonetic(word).catch(() => '')
        content.phonetic = phonetic.normalizePhonetic(generatedPhonetic)
      }
      this.setData({
        generatedContent: content,
        isGenerating: false
      })
    } catch (err) {
      console.error('生成内容失败', err)
      this.setData({
        errorMsg: err.message || '内容生成失败，请检查网络或稍后重试',
        isGenerating: false
      })
    }
  },

  /** 重新生成 */
  onRegenerate() {
    this.onGenerate()
  },

  /** 保存生词 */
  async onSave() {
    const word = this.data.inputWord.trim()
    if (!word || !this.data.generatedContent) {
      wx.showToast({ title: '请先生成内容', icon: 'none' })
      return
    }

    wx.showLoading({ title: '保存中...', mask: true })

    storage.addWord({
      word: word,
      content: phonetic.ensureContentPhonetic(word, this.data.generatedContent)
    })

    wx.hideLoading()
    wx.showToast({ title: '已保存', icon: 'success' })

    // 返回上一页
    setTimeout(() => {
      wx.navigateBack({ delta: 1 })
    }, 1000)
  }
})
