const storage = require('../../utils/storage')
const cloud = require('../../utils/cloud')
const audioManager = require('../../utils/audio-manager')
const { WORD_STATUS, MAX_REVIEW_LEVEL, DIFFICULTY_LABELS } = require('../../utils/constants')

Page({
  data: {
    word: null,
    loading: true,
    generatingWordAudio: false,
    isPlayingWord: false,
    isPlayingExample: false,
    playingExampleIndex: -1,
    generatingExampleAudioIndex: -1,
    translatingExamples: {},
    exampleTranslationsOpen: {},
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
    this.bindAudioEvents()
    const id = options.id
    if (id) {
      this.loadWord(id)
    } else {
      this.setData({ loading: false })
    }
  },

  onUnload() {
    audioManager.stopAudio()
    audioManager.onEnded(null)
    audioManager.onError(null)
  },

  bindAudioEvents() {
    audioManager.onEnded(() => {
      this.setData({
        isPlayingWord: false,
        isPlayingExample: false,
        playingExampleIndex: -1
      })
    })

    audioManager.onError(() => {
      this.setData({
        isPlayingWord: false,
        isPlayingExample: false,
        playingExampleIndex: -1
      })
      wx.showToast({ title: '播放失败', icon: 'none' })
    })
  },

  loadWord(id) {
    const word = storage.getWordById(id)
    if (word) {
      const total = word.stats.totalAttempts || 0
      const correct = word.stats.correctCount || 0
      const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0
      const reviewProgress = Math.round((word.reviewLevel / MAX_REVIEW_LEVEL) * 100)

      this.setData({
        word: this.decorateWord(word),
        loading: false,
        accuracy,
        reviewProgress
      })
    } else {
      this.setData({ word: null, loading: false })
    }
  },

  refreshWord() {
    if (!this.data.word) return
    const word = storage.getWordById(this.data.word.id)
    if (!word) return
    this.setData({ word: this.decorateWord(word) })
  },

  decorateWord(word) {
    if (!word) return null

    const content = word.content || {}
    const audio = word.audio || {}
    const translations = Array.isArray(content.exampleTranslations) ? content.exampleTranslations : []
    const exampleAudios = Array.isArray(audio.exampleAudios) ? audio.exampleAudios : []
    const translationOpen = this.data.exampleTranslationsOpen || {}
    const translating = this.data.translatingExamples || {}

    return {
      ...word,
      exampleItems: (content.examples || []).map((text, index) => ({
        index,
        text,
        translation: translations[index] || '',
        hasAudio: !!(exampleAudios[index] || (index === 0 && audio.fullAudio)),
        translationOpen: !!translationOpen[index],
        isTranslating: !!translating[index]
      }))
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

  async ensureWordAudio() {
    const word = storage.getWordById(this.data.word.id)
    if (!word) return ''

    const existing = word.audio && word.audio.wordAudio
    if (existing) return existing

    this.setData({ generatingWordAudio: true })

    try {
      const audioFileID = await cloud.synthesizeSpeech(word.word, 'word')
      const latest = storage.getWordById(word.id)
      const audio = {
        wordAudio: '',
        clozeAudio: '',
        fullAudio: '',
        ...((latest && latest.audio) || {})
      }
      audio.wordAudio = audioFileID

      storage.updateWord(word.id, { audio })
      this.refreshWord()
      return audioFileID
    } catch (err) {
      console.error('单词音频生成失败', err)
      wx.showToast({ title: '单词音频生成失败', icon: 'none' })
      return ''
    } finally {
      this.setData({ generatingWordAudio: false })
    }
  },

  /** 播放单词音频 */
  async onPlayWordAudio() {
    const word = this.data.word
    if (!word) return

    if (this.data.isPlayingWord) {
      audioManager.pauseAudio()
      this.setData({ isPlayingWord: false })
      return
    }

    const audioFileID = await this.ensureWordAudio()
    if (!audioFileID) return

    try {
      await audioManager.playAudio(audioFileID)
      this.setData({
        isPlayingWord: true,
        isPlayingExample: false,
        playingExampleIndex: -1
      })
    } catch (err) {
      if (err && err.code === 'PLAY_INTERRUPTED') return
      this.setData({ isPlayingWord: false })
      wx.showToast({ title: '播放失败', icon: 'none' })
    }
  },

  getExampleAudio(word, index) {
    const audio = (word && word.audio) || {}
    const exampleAudios = Array.isArray(audio.exampleAudios) ? audio.exampleAudios : []
    return exampleAudios[index] || (index === 0 ? audio.fullAudio : '') || ''
  },

  async ensureExampleAudio(index, text) {
    const word = storage.getWordById(this.data.word.id)
    const existing = this.getExampleAudio(word, index)
    if (existing) return existing

    this.setData({ generatingExampleAudioIndex: index })

    try {
      const audioFileID = await cloud.synthesizeSpeech(text, 'full')
      const latest = storage.getWordById(word.id)
      const audio = {
        wordAudio: '',
        clozeAudio: '',
        fullAudio: '',
        ...((latest && latest.audio) || {})
      }
      const exampleAudios = Array.isArray(audio.exampleAudios) ? audio.exampleAudios.slice() : []
      exampleAudios[index] = audioFileID
      audio.exampleAudios = exampleAudios
      if (index === 0) audio.fullAudio = audioFileID

      storage.updateWord(word.id, { audio })
      this.refreshWord()
      return audioFileID
    } catch (err) {
      console.error('例句音频生成失败', err)
      wx.showToast({ title: '例句音频生成失败', icon: 'none' })
      return ''
    } finally {
      this.setData({ generatingExampleAudioIndex: -1 })
    }
  },

  async onPlayExampleAudio(e) {
    const index = Number(e.currentTarget.dataset.index)
    const word = this.data.word
    const item = word && (word.exampleItems || []).find(ex => ex.index === index)
    if (!item) return

    if (this.data.isPlayingExample && this.data.playingExampleIndex === index) {
      audioManager.pauseAudio()
      this.setData({ isPlayingExample: false })
      return
    }

    this.setData({
      isPlayingExample: false,
      isPlayingWord: false,
      playingExampleIndex: index
    })

    const audioFileID = await this.ensureExampleAudio(index, item.text)
    if (!audioFileID) return

    try {
      await audioManager.playAudio(audioFileID)
      this.setData({
        isPlayingExample: true,
        playingExampleIndex: index,
        isPlayingWord: false
      })
    } catch (err) {
      if (err && err.code === 'PLAY_INTERRUPTED') return
      this.setData({ isPlayingExample: false })
      wx.showToast({ title: '播放失败', icon: 'none' })
    }
  },

  async onToggleExampleTranslation(e) {
    const index = Number(e.currentTarget.dataset.index)
    const word = this.data.word
    const item = word && (word.exampleItems || []).find(ex => ex.index === index)
    if (!item) return

    const key = `exampleTranslationsOpen.${index}`
    if (!this.data.exampleTranslationsOpen[index] && !item.translation) {
      this.setData({
        [key]: true,
        [`translatingExamples.${index}`]: true
      })
      this.refreshWord()

      try {
        const translation = await cloud.translateText(item.text)
        const latest = storage.getWordById(word.id)
        const content = {
          ...((latest && latest.content) || {})
        }
        const translations = Array.isArray(content.exampleTranslations)
          ? content.exampleTranslations.slice()
          : []
        translations[index] = translation || ''
        content.exampleTranslations = translations
        storage.updateWord(word.id, { content })
      } catch (err) {
        console.error('例句翻译失败', err)
        wx.showToast({ title: '翻译失败', icon: 'none' })
      } finally {
        this.setData({ [`translatingExamples.${index}`]: false })
        this.refreshWord()
      }
      return
    }

    this.setData({ [key]: !this.data.exampleTranslationsOpen[index] })
    this.refreshWord()
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
  }
})
