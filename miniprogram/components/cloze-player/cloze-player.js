const audioManager = require('../../utils/audio-manager')

Component({
  properties: {
    word: {
      type: String,
      value: ''
    },
    clozeAudio: {
      type: String,
      value: ''
    },
    fullAudio: {
      type: String,
      value: ''
    },
    clozeExample: {
      type: String,
      value: ''
    },
    fullExample: {
      type: String,
      value: ''
    },
    chineseHint: {
      type: String,
      value: ''
    },
    autoPlay: {
      type: Boolean,
      value: true
    }
  },

  data: {
    phase: 'playing',     // 'playing' | 'guessing' | 'revealed'
    isPlaying: false,
    isPlayingFull: false,
    userInput: '',
    showChineseHint: false,
    showClozeText: false,
    clozeBefore: '',
    clozeAfter: '',
    isCorrect: false,
    revealed: false
  },

  observers: {
    /** 当 word 属性变化时，自动重置组件 */
    'word': function (newWord) {
      if (!newWord) return
      // 停止当前播放
      audioManager.stopAudio()
      // 重置所有状态
      this.setData({
        phase: 'playing',
        isPlaying: false,
        isPlayingFull: false,
        userInput: '',
        showChineseHint: false,
        showClozeText: false,
        clozeBefore: '',
        clozeAfter: '',
        isCorrect: false,
        revealed: false
      })
      // 重新解析挖空例句
      this.parseCloze()
      // 自动播放新词的挖空句
      if (this.properties.autoPlay && this.properties.clozeAudio) {
        setTimeout(() => this.onPlayCloze(), 500)
      }
    }
  },

  lifetimes: {
    attached() {
      this._setupAudioCallbacks()
      this.parseCloze()
      if (this.properties.autoPlay && this.properties.clozeAudio) {
        setTimeout(() => this.onPlayCloze(), 500)
      }
    },
    detached() {
      // 清除回调，防止内存泄漏
      audioManager.onEnded(null)
      audioManager.onError(null)
      audioManager.stopAudio()
    }
  },

  methods: {
    /** 设置音频播放回调 */
    _setupAudioCallbacks() {
      audioManager.onEnded(() => {
        // 音频播放完成
        if (this.data.isPlaying) {
          // 挖空句播放完成 → 进入猜测阶段
          this.setData({ isPlaying: false, phase: 'guessing' })
        } else if (this.data.isPlayingFull) {
          // 完整例句播放完成
          this.setData({ isPlayingFull: false })
        }
      })

      audioManager.onError((err) => {
        console.error('音频播放错误', err)
        this.setData({ isPlaying: false, isPlayingFull: false })
      })
    },

    /** 解析挖空例句 */
    parseCloze() {
      const clozeExample = this.properties.clozeExample
      if (!clozeExample) return

      const parts = clozeExample.split('___')
      if (parts.length >= 2) {
        this.setData({
          clozeBefore: parts[0],
          clozeAfter: parts.slice(1).join('___'),
          showClozeText: true
        })
      }
    },

    /** 播放挖空句 */
    onPlayCloze() {
      if (!this.properties.clozeAudio) {
        wx.showToast({ title: '音频未生成', icon: 'none' })
        return
      }

      if (this.data.isPlaying) {
        // 正在播放中，暂停
        audioManager.pauseAudio()
        this.setData({ isPlaying: false })
        return
      }

      this.setData({ isPlaying: true })
      audioManager.playAudio(this.properties.clozeAudio)
        .catch(err => {
          console.error('播放失败', err)
          this.setData({ isPlaying: false })
          wx.showToast({ title: '播放失败', icon: 'none' })
        })
      // 播放完成通过 audioManager.onEnded 回调处理
    },

    /** 切换中文提示 */
    onToggleHint() {
      this.setData({ showChineseHint: true })
    },

    /** 开始输入猜测 */
    onStartGuessing() {
      this.setData({ phase: 'guessing' })
    },

    /** 输入处理 */
    onInput(e) {
      this.setData({ userInput: e.detail.value })
    },

    /** 揭晓答案 */
    onReveal() {
      const isCorrect = this.data.userInput.trim().toLowerCase() ===
        this.properties.word.trim().toLowerCase()

      this.setData({
        phase: 'revealed',
        isCorrect,
        revealed: true
      })

      // 自动播放完整例句
      if (this.properties.fullAudio) {
        setTimeout(() => this.onPlayFull(), 600)
      }
    },

    /** 播放完整例句 */
    onPlayFull() {
      if (!this.properties.fullAudio) {
        wx.showToast({ title: '完整例句音频未生成', icon: 'none' })
        return
      }

      if (this.data.isPlayingFull) {
        audioManager.stopAudio()
        this.setData({ isPlayingFull: false })
        return
      }

      this.setData({ isPlayingFull: true })
      audioManager.playAudio(this.properties.fullAudio)
        .catch(() => {
          this.setData({ isPlayingFull: false })
        })
      // 播放完成通过 audioManager.onEnded 回调处理
    },

    /** 答对 */
    onCorrect() {
      this.triggerEvent('result', {
        word: this.properties.word,
        isCorrect: true
      })
    },

    /** 答错 */
    onIncorrect() {
      this.triggerEvent('result', {
        word: this.properties.word,
        isCorrect: false,
        userInput: this.data.userInput
      })
    }
  }
})
