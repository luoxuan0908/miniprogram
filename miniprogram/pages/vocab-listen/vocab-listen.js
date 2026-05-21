const storage = require('../../utils/storage')
const cloud = require('../../utils/cloud')
const { MAX_REVIEW_LEVEL } = require('../../utils/constants')

Page({
  data: {
    queue: [],
    currentIndex: 0,
    currentWord: null,
    loading: true,
    isSessionComplete: false,
    isGeneratingAudio: false,
    sessionStats: {
      correct: 0,
      incorrect: 0,
      total: 0
    },
    newMastered: 0,
    accuracy: 0
  },

  onShow() {
    this.initSession()
  },

  initSession() {
    this.setData({ loading: true })
    const dueWords = storage.getDueWords()
    const queue = storage.mixNewWords(dueWords, 3)

    if (queue.length === 0) {
      this.setData({
        queue: [],
        loading: false,
        isSessionComplete: false,
        currentWord: null,
        currentIndex: 0,
        sessionStats: { correct: 0, incorrect: 0, total: 0 },
        newMastered: 0
      })
      return
    }

    this.setData({
      queue,
      currentIndex: 0,
      currentWord: queue[0],
      loading: false,
      isSessionComplete: false,
      sessionStats: {
        correct: 0,
        incorrect: 0,
        total: queue.length
      },
      newMastered: 0
    })
  },

  _goNext() {
    const nextIndex = this.data.currentIndex + 1
    if (nextIndex >= this.data.queue.length) {
      const stats = this.data.sessionStats
      const accuracy = stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0
      this.setData({
        isSessionComplete: true,
        currentWord: null,
        currentIndex: nextIndex,
        accuracy
      })
      return
    }

    this.setData({
      currentIndex: nextIndex,
      currentWord: this.data.queue[nextIndex]
    })
  },

  onResult(e) {
    const { word, isCorrect } = e.detail
    const currentWord = this.data.currentWord
    if (!currentWord || currentWord.word !== word) return

    const updated = storage.recordReviewResult(currentWord.id, isCorrect)
    if (!updated) return

    const stats = { ...this.data.sessionStats }
    let newMastered = this.data.newMastered
    if (isCorrect) {
      stats.correct++
      if (updated.reviewLevel >= MAX_REVIEW_LEVEL) newMastered++
    } else {
      stats.incorrect++
    }

    this.setData({ sessionStats: stats, newMastered })
    this._goNext()
  },

  onSkip() {
    const currentWord = this.data.currentWord
    if (!currentWord) return

    storage.recordReviewResult(currentWord.id, false)
    const stats = { ...this.data.sessionStats }
    stats.incorrect++
    this.setData({ sessionStats: stats })
    this._goNext()
  },

  onRestart() {
    this.initSession()
  },

  onGoReview() {
    wx.switchTab({ url: '/pages/review/review' })
  },

  async onGenerateAudio() {
    const word = this.data.currentWord
    if (!word) return

    this.setData({ isGeneratingAudio: true })
    wx.showLoading({ title: '生成中...', mask: true })

    const audio = { wordAudio: '', clozeAudio: '', fullAudio: '' }
    try {
      audio.wordAudio = await cloud.synthesizeSpeech(word.word, 'word')
    } catch (err) {
      console.error('单词音频生成失败', err)
    }

    if (word.content.clozeExample) {
      try {
        await new Promise(resolve => setTimeout(resolve, 1000))
        audio.clozeAudio = await cloud.synthesizeSpeech(word.content.clozeExample.replace(/___/g, '...'), 'cloze')
      } catch (err) {
        console.error('挖空例句音频生成失败', err)
      }
    }

    const fullExample = word.content.examples && word.content.examples[0]
    if (fullExample) {
      try {
        await new Promise(resolve => setTimeout(resolve, 1000))
        audio.fullAudio = await cloud.synthesizeSpeech(fullExample, 'full')
      } catch (err) {
        console.error('完整例句音频生成失败', err)
      }
    }

    if (audio.wordAudio || audio.clozeAudio || audio.fullAudio) {
      storage.updateWord(word.id, { audio })
      const updatedWord = storage.getWordById(word.id)
      const queue = this.data.queue
      queue[this.data.currentIndex] = updatedWord
      this.setData({ currentWord: updatedWord, queue })
      wx.hideLoading()
      wx.showToast({ title: '音频就绪', icon: 'success' })
    } else {
      wx.hideLoading()
      wx.showToast({ title: '音频生成失败', icon: 'none' })
    }

    this.setData({ isGeneratingAudio: false })
  },

  onAddWord() {
    wx.navigateTo({ url: '/pages/add-word/add-word' })
  }
})
