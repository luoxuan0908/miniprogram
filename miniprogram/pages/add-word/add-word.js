const storage = require('../../utils/storage')
const cloud = require('../../utils/cloud')
const { DIFFICULTY_LABELS } = require('../../utils/constants')

Page({
  data: {
    inputWord: '',
    isGenerating: false,
    generatedContent: null,
    errorMsg: '',
    difficultyLabels: DIFFICULTY_LABELS
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
      const content = await cloud.generateContent(word)
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

    const newWord = storage.addWord({
      word: word,
      content: this.data.generatedContent
    })

    // 同步生成音频（保存时等待完成）
    await this.generateAudio(newWord)

    wx.hideLoading()
    wx.showToast({ title: '已保存', icon: 'success' })

    // 返回上一页
    setTimeout(() => {
      wx.navigateBack({ delta: 1 })
    }, 1000)
  },

  /** 保存并开始听力 */
  async onSaveAndListen() {
    const word = this.data.inputWord.trim()
    if (!word || !this.data.generatedContent) {
      wx.showToast({ title: '请先生成内容', icon: 'none' })
      return
    }

    wx.showLoading({ title: '正在生成音频...', mask: true })

    const newWord = storage.addWord({
      word: word,
      content: this.data.generatedContent
    })

    // 同步生成音频（等待完成再跳转）
    await this.generateAudio(newWord)

    wx.hideLoading()
    wx.showToast({ title: '已保存', icon: 'success' })

    // 跳转到听力页
    setTimeout(() => {
      wx.navigateTo({ url: '/pages/vocab-listen/vocab-listen' })
    }, 1000)
  },

  /** 生成 TTS 音频（每个音频独立 try/catch，保存部分结果） */
  async generateAudio(word) {
    if (!word.content) return

    const { word: wordText, content } = word
    const audio = { wordAudio: '', clozeAudio: '', fullAudio: '' }

    // 生成单词发音
    try {
      audio.wordAudio = await cloud.synthesizeSpeech(wordText, 'word')
    } catch (err) {
      console.error('单词音频生成失败', err)
    }

    // 生成挖空例句音频（延时 1s 避免 429 限流）
    if (content.clozeExample) {
      try {
        await new Promise(r => setTimeout(r, 1000))
        const clozeText = content.clozeExample.replace(/___/g, '...')
        audio.clozeAudio = await cloud.synthesizeSpeech(clozeText, 'cloze')
      } catch (err) {
        console.error('挖空例句音频生成失败', err)
      }
    }

    // 生成完整例句音频（延时 1s 避免 429 限流）
    const fullExample = content.examples && content.examples[0]
    if (fullExample) {
      try {
        await new Promise(r => setTimeout(r, 1000))
        audio.fullAudio = await cloud.synthesizeSpeech(fullExample, 'full')
      } catch (err) {
        console.error('完整例句音频生成失败', err)
      }
    }

    // 保存已生成的音频（即使部分失败也保存成功的）
    if (audio.wordAudio || audio.clozeAudio || audio.fullAudio) {
      storage.updateWord(word.id, { audio })
    } else {
      wx.showToast({ title: '音频生成失败，可稍后重试', icon: 'none', duration: 2000 })
    }
  }
})
