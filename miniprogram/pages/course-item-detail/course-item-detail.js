const courseStorage = require('../../utils/course-storage')
const vocabStorage = require('../../utils/storage')
const audioManager = require('../../utils/audio-manager')
const cloud = require('../../utils/cloud')
const ttsPreferences = require('../../utils/tts-preferences')

Page({
  data: {
    courseId: '',
    itemId: '',
    index: 0,
    item: {},
    course: {},
    courseType: '',
    typeConfig: {},
    detailTemplate: 'phrase',  // 默认模板
    currentStatus: 'new'
  },

  onLoad(options) {
    this.setData({
      courseId: options.courseId || '',
      itemId: options.itemId || '',
      index: parseInt(options.index, 10) || 0
    })
  },

  onShow() {
    this.loadItem()
  },

  async loadItem() {
    const { courseId, itemId } = this.data
    const item = await courseStorage.getCourseItem(courseId, itemId)
    if (!item) return

    // 获取课程类型和模板配置
    const course = courseStorage.getCourse(courseId) || {}
    const courseType = course.type || ''
    const typeConfig = courseStorage.getTypeConfig(courseType)
    const detailTemplate = typeConfig.detailTemplate || 'phrase'

    // 获取进度
    const progress = courseStorage.getItemProgress(courseId, itemId)
    const currentStatus = progress ? progress.status : 'new'

    this.setData({
      item,
      course,
      courseType,
      typeConfig,
      detailTemplate,
      currentStatus
    })
  },

  // 播放音频
  async onPlayExample(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const text = e.currentTarget.dataset.text
    const audioUrl = e.currentTarget.dataset.audio || ''
    if (!text && !audioUrl) return

    // 防止重复点击
    if (this._playing) return
    this._playing = true

    try {
      // 1. cloud:// 或 https:// 开头 → 直接播放
      if (audioUrl && (audioUrl.startsWith('cloud://') || audioUrl.startsWith('https://'))) {
        await audioManager.playAudio(audioUrl)
        this._playing = false
        return
      }

      // 2. 相对路径（如 "audio/001.1.mp3"）→ 转为 cloud:// fileID 播放
      if (audioUrl && !audioUrl.startsWith('/')) {
        const fileName = audioUrl.replace(/^audio\//, '')
        const fileID = `cloud://cloud1-d1gg8fxt120042802.636c-cloud1-d1gg8fxt120042802-1436779938/idioms-audio/${fileName}`
        try {
          await audioManager.playAudio(fileID)
          this._playing = false
          return
        } catch (cloudErr) {
          // 云存储播放失败，继续 fallback 到 CDN
          const cdnUrl = 'https://cdn.jsdelivr.net/gh/luoxuan0908/most-common-american-idioms@main/' + audioUrl
          try {
            await audioManager.playAudio(cdnUrl)
            this._playing = false
            return
          } catch (cdnErr) {
            // CDN 也失败，继续 fallback 到 TTS
          }
        }
      }

      // 3. Fallback: TTS 合成
      const voice = ttsPreferences.normalizeTtsVoice(ttsPreferences.getTtsPreferences().ttsVoice)
      wx.showLoading({ title: '合成语音...' })

      const fileID = await cloud.synthesizeSpeech(text, 'course-example', { voice })
      wx.hideLoading()
      await audioManager.playAudio(fileID)
      this._playing = false
    } catch (err) {
      wx.hideLoading()
      this._playing = false
      if (err && err.code === 'PLAY_INTERRUPTED') return
      console.error('播放失败', err)
      wx.showToast({ title: '播放失败', icon: 'none' })
    }
  },

  // 进度操作
  onMarkLearning() {
    const { courseId, itemId } = this.data
    courseStorage.markAsLearning(courseId, itemId)
    this.setData({ currentStatus: 'learning' })
  },

  onMarkMastered() {
    const { courseId, itemId } = this.data
    courseStorage.markAsMastered(courseId, itemId)
    this.setData({ currentStatus: 'mastered' })
  },

  // 加入生词本
  onAddToVocab() {
    const { item, courseType } = this.data
    if (!item || !item.title) return

    // 按课程类型适配生词本数据结构
    const word = buildVocabWord(item, courseType)
    vocabStorage.persistWord(word)
    wx.showToast({ title: '已加入生词本', icon: 'success' })
  }
})

/**
 * 按课程类型构建生词本数据
 * 不同类型的课程，映射到 words 集合的字段可能不同
 */
function buildVocabWord(item, courseType) {
  const word = {
    word: item.title,
    content: {
      chineseHint: item.definition?.cn || '',
      shortDefinition: item.definition?.en || '',
      examples: (item.examples || []).map(e => e.en),
      exampleTranslations: (item.examples || []).map(e => e.cn),
      difficulty: item.difficulty || 2
    }
  }

  // 按课程类型适配额外字段
  const extra = item.extra || {}
  switch (courseType) {
    case 'idioms':
      word.content.memoryTip = extra.origin?.cn || ''
      break
    case 'essay-vocab':
      word.content.phonetic = extra.phonetic || ''
      word.content.pos = extra.pos || ''
      break
    case 'phrasal-verbs':
      word.content.memoryTip = `verb: ${extra.verb || ''}, particle: ${extra.particle || ''}`
      break
    default:
      // 未知类型，尽力提取
      if (extra.origin?.cn) word.content.memoryTip = extra.origin.cn
      break
  }

  return word
}
