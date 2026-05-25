const storage = require('../../utils/storage')
const cloud = require('../../utils/cloud')
const audioManager = require('../../utils/audio-manager')
const phonetic = require('../../utils/phonetic')
const { WORD_STATUS, MAX_REVIEW_LEVEL, DIFFICULTY_LABELS } = require('../../utils/constants')
const studyDuration = require('../../utils/study-duration')

const recorderManager = wx.getRecorderManager ? wx.getRecorderManager() : null

Page({
  data: {
    word: null,
    loading: true,
    generatingPhonetic: false,
    phoneticMessage: '',
    isRecording: false,
    isUploadingRecording: false,
    recordingTempPath: '',
    recordingDuration: 0,
    playingRecordingId: '',
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
    this.bindRecorderEvents()
    const id = options.id
    if (id) {
      this.loadWord(id)
    } else {
      this.setData({ loading: false })
    }
  },

  onShow() {
    studyDuration.startSession('word-detail')
  },

  onHide() {
    studyDuration.stopSession('word-detail')
  },

  onUnload() {
    studyDuration.stopSession('word-detail')
    if (recorderManager && this.data.isRecording) recorderManager.stop()
    audioManager.stopAudio()
    audioManager.onEnded(null)
    audioManager.onError(null)
  },

  bindRecorderEvents() {
    if (!recorderManager) return
    recorderManager.onStop(res => {
      this.setData({
        isRecording: false,
        recordingTempPath: res.tempFilePath || '',
        recordingDuration: Math.round((res.duration || 0) / 1000)
      })
      if (res.tempFilePath) {
        wx.showToast({ title: '录音已就绪', icon: 'success' })
      }
    })
    recorderManager.onError(err => {
      console.error('录音失败', err)
      this.setData({ isRecording: false })
      wx.showToast({ title: '录音失败', icon: 'none' })
    })
  },

  bindAudioEvents() {
    audioManager.onEnded(() => {
      this.setData({
        isPlayingWord: false,
        isPlayingExample: false,
        playingExampleIndex: -1,
        playingRecordingId: ''
      })
    })

    audioManager.onError(() => {
      this.setData({
        isPlayingWord: false,
        isPlayingExample: false,
        playingExampleIndex: -1,
        playingRecordingId: ''
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
      this.ensurePhonetic(word.id)
      this.ensurePronunciationInfo(word.id)
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
    const displayPhonetic = phonetic.getContentPhonetic(content) || phonetic.getLocalPhonetic(word.word)
    const audio = word.audio || {}
    const translations = Array.isArray(content.exampleTranslations) ? content.exampleTranslations : []
    const exampleAudios = Array.isArray(audio.exampleAudios) ? audio.exampleAudios : []
    const translationOpen = this.data.exampleTranslationsOpen || {}
    const translating = this.data.translatingExamples || {}

    return {
      ...word,
      content: {
        ...content,
        phonetic: displayPhonetic
      },
      hasPhonetic: !!displayPhonetic,
      phoneticText: displayPhonetic || '暂无音标，点此生成',
      pronunciationRecords: (word.pronunciationRecords || []).slice().sort((a, b) => b.createdAt - a.createdAt),
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

  async ensurePronunciationInfo(id) {
    const word = storage.getWordById(id)
    if (!word) return
    const content = word.content || {}
    if (phonetic.getContentPhonetic(content) && content.stressHint) return

    try {
      const generated = await cloud.generatePronunciation(word.word)
      const generatedPhonetic = phonetic.normalizePhonetic(generated.phonetic)
      storage.updateWord(id, {
        content: {
          ...content,
          phonetic: phonetic.getContentPhonetic(content) || generatedPhonetic || content.phonetic || '',
          stressHint: content.stressHint || generated.stressHint || ''
        }
      })
      this.refreshWord()
    } catch (err) {
      console.error('发音信息补全失败', err)
    }
  },

  async ensurePhonetic(id) {
    if (this.data.generatingPhonetic) return

    const word = storage.getWordById(id)
    const content = (word && word.content) || {}
    if (!word || phonetic.getContentPhonetic(content)) return

    const localPhonetic = phonetic.getLocalPhonetic(word.word)
    if (localPhonetic) {
      storage.updateWord(id, {
        content: {
          ...content,
          phonetic: localPhonetic
        }
      })
      this.refreshWord()
      return
    }

    this.setData({ generatingPhonetic: true, phoneticMessage: '' })

    try {
      const generatedPhonetic = phonetic.normalizePhonetic(await cloud.generatePhonetic(word.word))
      if (!generatedPhonetic) {
        this.setData({ phoneticMessage: '音标暂未生成，点此重试' })
        return
      }

      const latest = storage.getWordById(id)
      if (!latest) return
      const latestContent = latest.content || {}
      if (phonetic.getContentPhonetic(latestContent)) {
        this.refreshWord()
        return
      }

      storage.updateWord(id, {
        content: {
          ...latestContent,
          phonetic: generatedPhonetic
        }
      })
      this.refreshWord()
    } catch (err) {
      console.error('音标补全失败', err)
      this.setData({ phoneticMessage: '音标生成失败，点此重试' })
    } finally {
      this.setData({ generatingPhonetic: false })
    }
  },

  onStartRecording() {
    if (!recorderManager) {
      wx.showToast({ title: '当前环境不支持录音', icon: 'none' })
      return
    }
    audioManager.stopAudio()
    this.setData({
      isRecording: true,
      recordingTempPath: '',
      recordingDuration: 0,
      playingRecordingId: ''
    })
    recorderManager.start({
      duration: 60000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'mp3'
    })
  },

  onStopRecording() {
    if (!recorderManager || !this.data.isRecording) return
    recorderManager.stop()
  },

  async onPreviewRecording() {
    const path = this.data.recordingTempPath
    if (!path) {
      wx.showToast({ title: '请先录音', icon: 'none' })
      return
    }
    try {
      await audioManager.playAudio(path)
      this.setData({ playingRecordingId: 'draft' })
    } catch (err) {
      wx.showToast({ title: '试听失败', icon: 'none' })
    }
  },

  async onSaveRecording() {
    const word = this.data.word
    const path = this.data.recordingTempPath
    if (!word || !path || this.data.isUploadingRecording) return

    this.setData({ isUploadingRecording: true })
    wx.showLoading({ title: '上传录音...', mask: true })
    try {
      const fileID = await cloud.uploadPronunciationRecording(path, word.word)
      storage.addPronunciationRecord(word.id, {
        fileID,
        duration: this.data.recordingDuration,
        word: word.word,
        source: 'word-detail'
      })
      wx.hideLoading()
      this.setData({
        recordingTempPath: '',
        recordingDuration: 0,
        isUploadingRecording: false
      })
      this.refreshWord()
      wx.showToast({ title: '录音已保存', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      this.setData({ isUploadingRecording: false })
      wx.showToast({ title: err.message || '上传失败', icon: 'none' })
    }
  },

  async onPlayRecording(e) {
    const id = e.currentTarget.dataset.id
    const fileID = e.currentTarget.dataset.file
    if (!fileID) return
    if (this.data.playingRecordingId === id) {
      audioManager.pauseAudio()
      this.setData({ playingRecordingId: '' })
      return
    }
    try {
      await audioManager.playAudio(fileID)
      this.setData({ playingRecordingId: id })
    } catch (err) {
      wx.showToast({ title: '播放录音失败', icon: 'none' })
    }
  },

  onDeleteRecording(e) {
    const word = this.data.word
    const id = e.currentTarget.dataset.id
    const fileID = e.currentTarget.dataset.file
    if (!word || !id) return
    wx.showModal({
      title: '删除录音',
      content: '确定删除这条录音吗？',
      success: async res => {
        if (!res.confirm) return
        try {
          if (fileID) await cloud.deleteCloudFiles(fileID)
        } catch (err) {
          console.warn('删除云端录音失败', err)
        }
        storage.deletePronunciationRecord(word.id, id)
        this.refreshWord()
        wx.showToast({ title: '已删除', icon: 'success' })
      }
    })
  },

  onSkillPractice(e) {
    const word = this.data.word
    const mode = e.currentTarget.dataset.mode
    const correct = e.currentTarget.dataset.correct === '1'
    if (!word) return
    storage.recordSkillPractice(word.id, mode, correct, {
      expected: word.word,
      reason: correct ? '' : '未作答'
    })
    this.refreshWord()
    wx.showToast({ title: correct ? '已记录正确' : '已记录错因', icon: 'success' })
  },

  onGeneratePhoneticTap() {
    const word = this.data.word
    if (!word || word.hasPhonetic || this.data.generatingPhonetic) return
    this.ensurePhonetic(word.id)
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
