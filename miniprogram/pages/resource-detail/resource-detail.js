const cloud = require('../../utils/cloud')
const audioManager = require('../../utils/audio-manager')
const resourceStorage = require('../../utils/resource-storage')
const vocabStorage = require('../../utils/storage')
const ttsPreferences = require('../../utils/tts-preferences')
const studyDuration = require('../../utils/study-duration')

const MAX_SEGMENT_AUDIO_SECONDS = 10 * 60
const recorderManager = wx.getRecorderManager ? wx.getRecorderManager() : null

function normalizeAudioSeconds(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0

  return numeric > MAX_SEGMENT_AUDIO_SECONDS ? numeric / 1000 : numeric
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(normalizeAudioSeconds(seconds)))
  const min = Math.floor(safe / 60)
  const sec = safe % 60
  return `${min}:${sec < 10 ? '0' : ''}${sec}`
}

function formatTimeLabel(currentTime, duration) {
  return `${formatTime(currentTime)} / ${formatTime(duration)}`
}

Page({
  data: {
    resource: null,
    loading: true,
    activeSegmentIndex: 0,
    playingSegmentIndex: 0,
    isPlaying: false,
    showPlayerPanel: false,
    showShadowPanel: false,
    showAudioSettings: false,
    isGeneratingAudio: false,
    isGeneratingStudyPack: false,
    isShadowRecording: false,
    isUploadingShadowRecording: false,
    shadowRecordingTempPath: '',
    shadowRecordingDuration: 0,
    shadowSegmentIndex: 0,
    currentShadowSegment: null,
    playingShadowRecordingId: '',
    translatingSegments: {},
    translationsOpen: {},
    imageErrors: {},
    voiceOptions: ttsPreferences.TTS_VOICE_OPTIONS,
    ttsVoice: ttsPreferences.DEFAULT_TTS_VOICE,
    ttsVoiceIndex: 0,
    ttsVoiceLabel: '',
    ttsVoiceDesc: '',
    ttsSpeed: ttsPreferences.DEFAULT_TTS_SPEED,
    ttsSpeedLabel: '1.0x',
    waveBars: [0, 1, 2, 3, 4, 2, 1, 3, 0, 4, 1, 2, 3, 1, 4, 2],
    currentTime: 0,
    duration: 0,
    progressPercent: 0,
    timeLabel: '0:00 / 0:00'
  },

  onLoad(options) {
    this.bindAudioEvents()
    this.bindRecorderEvents()
    this.loadAudioPreferences()
    if (options.id) {
      this.loadResource(options.id)
      if (options.shadow) {
        setTimeout(() => this.openShadowPanelByIndex(Number(options.shadow)), 120)
      }
    } else {
      this.setData({ loading: false })
    }
  },

  onShow() {
    studyDuration.startSession('resource-detail')
  },

  noop() {},

  bindRecorderEvents() {
    if (!recorderManager) return

    recorderManager.onStop(res => {
      this.setData({
        isShadowRecording: false,
        shadowRecordingTempPath: res.tempFilePath || '',
        shadowRecordingDuration: Math.round((res.duration || 0) / 1000)
      })
      if (res.tempFilePath) {
        wx.showToast({ title: '跟读已就绪', icon: 'success' })
      }
    })

    recorderManager.onError(err => {
      console.error('跟读录音失败', err)
      this.setData({ isShadowRecording: false })
      wx.showToast({ title: '录音失败', icon: 'none' })
    })
  },

  loadAudioPreferences() {
    const prefs = ttsPreferences.getTtsPreferences()
    this.setData({
      ttsVoice: prefs.ttsVoice,
      ttsVoiceIndex: prefs.ttsVoiceIndex,
      ttsVoiceLabel: prefs.ttsVoiceLabel,
      ttsVoiceDesc: prefs.ttsVoiceDesc,
      ttsSpeed: prefs.ttsSpeed,
      ttsSpeedLabel: prefs.ttsSpeedLabel
    })
  },

  onUnload() {
    studyDuration.stopSession('resource-detail')
    if (recorderManager && this.data.isShadowRecording) recorderManager.stop()
    audioManager.stopAudio()
    audioManager.onEnded(null)
    audioManager.onError(null)
    audioManager.onTimeUpdate(null)
    audioManager.onCanplay(null)
  },

  onHide() {
    studyDuration.stopSession('resource-detail')
  },

  bindAudioEvents() {
    audioManager.onEnded(() => {
      const safeDuration = normalizeAudioSeconds(this.data.duration)

      this.setData({
        isPlaying: false,
        playingShadowRecordingId: '',
        duration: safeDuration,
        currentTime: 0,
        progressPercent: 0,
        timeLabel: formatTimeLabel(0, safeDuration)
      })
    })

    audioManager.onError(() => {
      this.setData({ isPlaying: false, isGeneratingAudio: false, playingShadowRecordingId: '' })
      wx.showToast({ title: '播放失败', icon: 'none' })
    })

    audioManager.onTimeUpdate(({ currentTime, duration }) => {
      const safeCurrentTime = normalizeAudioSeconds(currentTime)
      const safeDuration = normalizeAudioSeconds(duration || this.data.duration || 0)
      this.setData({
        currentTime: safeCurrentTime,
        duration: safeDuration,
        progressPercent: safeDuration ? Math.min(100, (safeCurrentTime / safeDuration) * 100) : 0,
        timeLabel: formatTimeLabel(safeCurrentTime, safeDuration)
      })
    })

    audioManager.onCanplay(({ duration }) => {
      const safeDuration = normalizeAudioSeconds(duration)
      this.saveCurrentSegmentDuration(safeDuration)
      this.setData({
        duration: safeDuration,
        timeLabel: formatTimeLabel(this.data.currentTime, safeDuration)
      })
    })
  },

  saveCurrentSegmentDuration(duration) {
    const resource = this.data.resource
    const index = this.data.playingSegmentIndex
    if (!resource || !index || !duration) return

    const segment = (resource.segments || []).find(s => s.index === index)
    if (!segment) return

    const oldDuration = normalizeAudioSeconds(segment.duration)
    if (Math.abs(oldDuration - duration) < 1) return

    resourceStorage.updateSegment(resource.id, index, { duration })
    this.refreshResource()
  },

  loadResource(id) {
    const resource = resourceStorage.getResourceById(id)
    if (!resource) {
      this.setData({ resource: null, loading: false })
      return
    }

    resourceStorage.markOpened(id)
    const decorated = this.decorateResource(resourceStorage.getResourceById(id))
    this.setData({
      resource: decorated,
      currentShadowSegment: this.getShadowSegment(decorated),
      loading: false
    })

    const firstSegment = (resource.segments || [])[0]
    if (firstSegment && !firstSegment.translation) {
      this.translateSegmentIfNeeded(firstSegment.index)
    }
  },

  refreshResource() {
    if (!this.data.resource) return
    const resource = this.decorateResource(resourceStorage.getResourceById(this.data.resource.id))
    this.setData({
      resource,
      currentShadowSegment: this.getShadowSegment(resource)
    })
  },

  decorateResource(resource) {
    if (!resource) return null
    const translationsOpen = this.data.translationsOpen || {}
    const translatingSegments = this.data.translatingSegments || {}
    return {
      ...resource,
      studyPack: resource.studyPack || null,
      images: this.decorateImages(resource.images),
      segments: (resource.segments || []).map(segment => ({
        ...segment,
        shadowRecords: (segment.shadowRecords || []).slice().sort((a, b) => b.createdAt - a.createdAt),
        shadowCount: Number.isFinite(segment.shadowCount) ? segment.shadowCount : (segment.shadowRecords || []).length,
        imagesBefore: this.decorateImages(segment.imagesBefore),
        imagesAfter: this.decorateImages(segment.imagesAfter),
        translationOpen: !!translationsOpen[segment.index],
        isTranslating: !!translatingSegments[segment.index]
      }))
    }
  },

  getShadowSegment(resource, index) {
    const targetIndex = Number(index || this.data.shadowSegmentIndex || 0)
    if (!resource || !targetIndex) return null
    return (resource.segments || []).find(segment => segment.index === targetIndex) || null
  },

  async onGenerateStudyPack() {
    const resource = this.data.resource
    if (!resource || this.data.isGeneratingStudyPack) return

    this.setData({ isGeneratingStudyPack: true })
    wx.showLoading({ title: '生成精读任务...', mask: true })
    try {
      const studyPack = await cloud.generateResourceStudyPack({
        title: resource.title,
        segments: (resource.segments || []).slice(0, 12).map(segment => segment.text)
      })
      resourceStorage.updateResource(resource.id, { studyPack })
      this.refreshResource()

      try {
        const syncResult = await resourceStorage.flushPendingSync()
        wx.hideLoading()
        this.setData({ isGeneratingStudyPack: false })
        wx.showToast({
          title: syncResult && syncResult.skipped ? '已本地保存' : '已生成并同步',
          icon: 'success'
        })
      } catch (syncErr) {
        console.error('精读任务云端同步失败', syncErr)
        wx.hideLoading()
        this.setData({ isGeneratingStudyPack: false })
        wx.showToast({ title: '已本地保存，云端同步失败', icon: 'none', duration: 2600 })
      }
      return
    } catch (err) {
      wx.hideLoading()
      this.setData({ isGeneratingStudyPack: false })
      wx.showToast({ title: err.message || '生成失败', icon: 'none', duration: 2600 })
    }
  },

  async onAddStudyWord(e) {
    const word = e.currentTarget.dataset.word
    const hint = e.currentTarget.dataset.hint || ''
    if (!word) return

    wx.showLoading({ title: '加入生词...', mask: true })
    try {
      let content
      try {
        content = await cloud.generateContent(word)
      } catch (err) {
        content = { chineseHint: hint, shortDefinition: '', examples: [], difficulty: 3 }
      }
      vocabStorage.addWord({ word, content: { ...content, chineseHint: content.chineseHint || hint } })
      wx.hideLoading()
      wx.showToast({ title: '已加入生词本', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '加入失败', icon: 'none' })
    }
  },

  decorateImages(images) {
    const imageErrors = this.data.imageErrors || {}
    return (images || []).map(image => ({
      ...image,
      hasError: !!imageErrors[image.src]
    }))
  },

  getAllImageUrls() {
    const resource = this.data.resource
    if (!resource) return []

    const urls = []
    ;(resource.segments || []).forEach(segment => {
      ;(segment.imagesBefore || []).forEach(image => {
        if (image.src) urls.push(image.src)
      })
      ;(segment.imagesAfter || []).forEach(image => {
        if (image.src) urls.push(image.src)
      })
    })

    return Array.from(new Set(urls))
  },

  onPreviewImage(e) {
    const src = e.currentTarget.dataset.src
    if (!src) return

    const urls = this.getAllImageUrls()
    wx.previewImage({
      current: src,
      urls: urls.length ? urls : [src]
    })
  },

  onImageError(e) {
    const src = e.currentTarget.dataset.src
    if (!src) return

    this.setData({
      imageErrors: {
        ...(this.data.imageErrors || {}),
        [src]: true
      }
    })
    this.refreshResource()
  },

  getPreferredVoice() {
    return ttsPreferences.normalizeTtsVoice(this.data.ttsVoice)
  },

  canReuseSegmentAudio(segment, voice) {
    if (!segment || !segment.audioFileID) return false
    const audioVoice = ttsPreferences.normalizeTtsVoice(segment.audioVoice || ttsPreferences.DEFAULT_TTS_VOICE)
    return audioVoice === ttsPreferences.normalizeTtsVoice(voice)
  },

  onOpenAudioSettings() {
    this.loadAudioPreferences()
    this.setData({ showAudioSettings: true })
  },

  onCloseAudioSettings() {
    this.setData({ showAudioSettings: false })
  },

  onVoiceChange(e) {
    const index = Number(e.detail.value || 0)
    const option = this.data.voiceOptions[index] || this.data.voiceOptions[0]
    if (!option) return

    ttsPreferences.saveTtsPreferences({ ttsVoice: option.value })
    audioManager.stopAudio()
    this.setData({
      ttsVoice: option.value,
      ttsVoiceIndex: index,
      ttsVoiceLabel: option.name,
      ttsVoiceDesc: option.desc,
      isPlaying: false,
      playingSegmentIndex: 0,
      activeSegmentIndex: 0,
      progressPercent: 0,
      currentTime: 0,
      duration: 0,
      timeLabel: '0:00 / 0:00'
    })
  },

  onTtsSpeedChanging(e) {
    const value = ttsPreferences.normalizeTtsSpeed(e.detail.value)
    this.setData({
      ttsSpeed: value,
      ttsSpeedLabel: ttsPreferences.formatTtsSpeed(value)
    })
    audioManager.refreshPlaybackRate(value)
  },

  onTtsSpeedChange(e) {
    const value = ttsPreferences.normalizeTtsSpeed(e.detail.value)
    this.setData({
      ttsSpeed: value,
      ttsSpeedLabel: ttsPreferences.formatTtsSpeed(value)
    })
    audioManager.refreshPlaybackRate(value)
    ttsPreferences.saveTtsPreferences({ ttsSpeed: value })
  },

  async translateSegmentIfNeeded(index) {
    const resource = this.data.resource
    if (!resource) return

    const segment = (resource.segments || []).find(s => s.index === index)
    if (!segment || segment.translation || this.data.translatingSegments[index]) return

    this.setData({ [`translatingSegments.${index}`]: true })
    this.refreshResource()

    try {
      const translation = await cloud.translateText(segment.text)
      if (translation) {
        resourceStorage.updateSegment(resource.id, index, { translation })
      }
    } catch (err) {
      console.error('翻译失败:', err)
    } finally {
      this.setData({ [`translatingSegments.${index}`]: false })
      this.refreshResource()
    }
  },

  async onToggleTranslation(e) {
    const index = e.currentTarget.dataset.index
    const resource = this.data.resource
    if (!resource) return

    const segment = (resource.segments || []).find(s => s.index === index)
    if (!segment) return

    const key = `translationsOpen.${index}`
    if (!this.data.translationsOpen[index] && !segment.translation) {
      this.setData({ [key]: true })
      this.refreshResource()
      await this.translateSegmentIfNeeded(index)
      return
    }

    this.setData({ [key]: !this.data.translationsOpen[index] })
    this.refreshResource()
  },

  onOpenShadowPanel(e) {
    this.openShadowPanelByIndex(Number(e.currentTarget.dataset.index))
  },

  openShadowPanelByIndex(index) {
    const resource = this.data.resource
    const segment = this.getShadowSegment(resource, index)
    if (!resource || !segment) return

    audioManager.stopAudio()
    this.setData({
      showShadowPanel: true,
      showPlayerPanel: false,
      activeSegmentIndex: index,
      shadowSegmentIndex: index,
      currentShadowSegment: segment,
      isPlaying: false,
      playingSegmentIndex: 0,
      playingShadowRecordingId: '',
      shadowRecordingTempPath: '',
      shadowRecordingDuration: 0
    })
  },

  onCloseShadowPanel() {
    if (this.data.isShadowRecording) {
      wx.showToast({ title: '请先停止录音', icon: 'none' })
      return
    }

    audioManager.stopAudio()
    this.setData({
      showShadowPanel: false,
      playingShadowRecordingId: '',
      shadowRecordingTempPath: '',
      shadowRecordingDuration: 0,
      isPlaying: false
    })
  },

  async onPlayShadowOrigin() {
    const segment = this.data.currentShadowSegment
    if (!segment) return

    if (this.data.isPlaying && this.data.playingSegmentIndex === segment.index && !this.data.playingShadowRecordingId) {
      audioManager.pauseAudio()
      this.setData({ isPlaying: false })
      return
    }

    const voice = this.getPreferredVoice()
    let audioFileID = this.canReuseSegmentAudio(segment, voice) ? segment.audioFileID : ''
    if (!audioFileID) {
      audioFileID = await this.generateSegmentAudio(segment.index, voice)
      if (!audioFileID) return
    }

    try {
      await audioManager.playAudio(audioFileID)
      this.setData({
        isPlaying: true,
        playingSegmentIndex: segment.index,
        activeSegmentIndex: segment.index,
        playingShadowRecordingId: ''
      })
    } catch (err) {
      if (err && err.code === 'PLAY_INTERRUPTED') return
      this.setData({ isPlaying: false })
      wx.showToast({ title: '播放失败', icon: 'none' })
    }
  },

  onStartShadowRecording() {
    if (!recorderManager) {
      wx.showToast({ title: '当前环境不支持录音', icon: 'none' })
      return
    }
    if (!this.data.currentShadowSegment) return

    audioManager.stopAudio()
    this.setData({
      isShadowRecording: true,
      isPlaying: false,
      playingShadowRecordingId: '',
      shadowRecordingTempPath: '',
      shadowRecordingDuration: 0
    })
    recorderManager.start({
      duration: 90000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'mp3'
    })
  },

  onStopShadowRecording() {
    if (!recorderManager || !this.data.isShadowRecording) return
    recorderManager.stop()
  },

  async onPreviewShadowRecording() {
    const path = this.data.shadowRecordingTempPath
    if (!path) {
      wx.showToast({ title: '请先录音', icon: 'none' })
      return
    }

    if (this.data.playingShadowRecordingId === 'draft') {
      audioManager.pauseAudio()
      this.setData({ playingShadowRecordingId: '' })
      return
    }

    try {
      await audioManager.playAudio(path)
      this.setData({ playingShadowRecordingId: 'draft', isPlaying: false })
    } catch (err) {
      wx.showToast({ title: '试听失败', icon: 'none' })
    }
  },

  async onSaveShadowRecording() {
    const resource = this.data.resource
    const segment = this.data.currentShadowSegment
    const path = this.data.shadowRecordingTempPath
    if (!resource || !segment || !path || this.data.isUploadingShadowRecording) return

    this.setData({ isUploadingShadowRecording: true })
    wx.showLoading({ title: '保存跟读...', mask: true })
    try {
      const fileID = await cloud.uploadShadowRecording(path, resource.id, segment.index)
      resourceStorage.addSegmentShadowRecord(resource.id, segment.index, {
        fileID,
        duration: this.data.shadowRecordingDuration,
        source: 'resource-detail'
      })
      wx.hideLoading()
      this.setData({
        shadowRecordingTempPath: '',
        shadowRecordingDuration: 0,
        isUploadingShadowRecording: false,
        playingShadowRecordingId: ''
      })
      this.refreshResource()
      wx.showToast({ title: '跟读已保存', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      this.setData({ isUploadingShadowRecording: false })
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
    }
  },

  async onPlayShadowRecording(e) {
    const id = e.currentTarget.dataset.id
    const fileID = e.currentTarget.dataset.file
    if (!fileID) return

    if (this.data.playingShadowRecordingId === id) {
      audioManager.pauseAudio()
      this.setData({ playingShadowRecordingId: '' })
      return
    }

    try {
      await audioManager.playAudio(fileID)
      this.setData({
        playingShadowRecordingId: id,
        isPlaying: false
      })
    } catch (err) {
      wx.showToast({ title: '播放录音失败', icon: 'none' })
    }
  },

  onDeleteShadowRecording(e) {
    const resource = this.data.resource
    const segment = this.data.currentShadowSegment
    const id = e.currentTarget.dataset.id
    const fileID = e.currentTarget.dataset.file
    if (!resource || !segment || !id) return

    wx.showModal({
      title: '删除跟读',
      content: '确定删除这条跟读录音吗？',
      success: async res => {
        if (!res.confirm) return
        let cloudDeleteFailed = false
        try {
          if (fileID) await cloud.deleteCloudFiles(fileID)
        } catch (err) {
          cloudDeleteFailed = true
          console.warn('删除云端跟读录音失败', err)
        }
        resourceStorage.deleteSegmentShadowRecord(resource.id, segment.index, id)
        this.refreshResource()
        wx.showToast({
          title: cloudDeleteFailed ? '本地已删除，云端稍后再试' : '已删除',
          icon: cloudDeleteFailed ? 'none' : 'success'
        })
      }
    })
  },

  async onPlaySegment(e) {
    const index = Number(e.currentTarget.dataset.index)
    const resource = this.data.resource
    if (!resource) return

    const segment = (resource.segments || []).find(s => s.index === index)
    if (!segment) return

    if (this.data.isPlaying && this.data.playingSegmentIndex === index) {
      audioManager.pauseAudio()
      this.setData({ isPlaying: false })
      return
    }

    this.setData({
      showPlayerPanel: true,
      activeSegmentIndex: index,
      playingSegmentIndex: index,
      isPlaying: false,
      currentTime: 0,
      duration: normalizeAudioSeconds(segment.duration),
      progressPercent: 0,
      timeLabel: formatTimeLabel(0, segment.duration)
    })

    const voice = this.getPreferredVoice()
    let audioFileID = this.canReuseSegmentAudio(segment, voice) ? segment.audioFileID : ''
    if (!audioFileID) {
      audioFileID = await this.generateSegmentAudio(index, voice)
      if (!audioFileID) return
    }

    try {
      await audioManager.playAudio(audioFileID)
      this.setData({ isPlaying: true })
      this.prefetchSegments(index + 1)
    } catch (err) {
      if (err && err.code === 'PLAY_INTERRUPTED') return
      this.setData({ isPlaying: false })
      wx.showToast({ title: '播放失败', icon: 'none' })
    }

    if (!segment.translation) {
      this.translateSegmentIfNeeded(index)
    }
  },

  async generateSegmentAudio(index, voice) {
    const resource = this.data.resource
    const segment = (resource.segments || []).find(s => s.index === index)
    if (!segment) return ''

    const audioVoice = ttsPreferences.normalizeTtsVoice(voice || this.getPreferredVoice())
    this.setData({ isGeneratingAudio: true })
    resourceStorage.updateSegment(resource.id, index, {
      audioFileID: '',
      audioStatus: 'generating',
      audioVoice
    })
    this.refreshResource()

    try {
      const audioFileID = await cloud.synthesizeSpeech(segment.text, 'resource', { voice: audioVoice })
      resourceStorage.updateSegment(resource.id, index, {
        audioFileID,
        audioVoice,
        audioStatus: 'ready',
        lastPlayedAt: Date.now()
      })
      this.refreshResource()
      return audioFileID
    } catch (err) {
      resourceStorage.updateSegment(resource.id, index, { audioStatus: 'error', audioVoice: '' })
      this.refreshResource()
      wx.showToast({ title: err.message || '音频生成失败', icon: 'none', duration: 2400 })
      return ''
    } finally {
      this.setData({ isGeneratingAudio: false })
    }
  },

  prefetchSegments(startIndex) {
    const resource = this.data.resource
    if (!resource) return

    const voice = this.getPreferredVoice()
    const audioTargets = (resource.segments || [])
      .filter(s => s.index >= startIndex && s.index < startIndex + 2 && !this.canReuseSegmentAudio(s, voice) && s.audioStatus !== 'generating')

    audioTargets.forEach(segment => {
      resourceStorage.updateSegment(resource.id, segment.index, {
        audioFileID: '',
        audioStatus: 'generating',
        audioVoice: voice
      })
      cloud.synthesizeSpeech(segment.text, 'resource', { voice })
        .then(audioFileID => {
          resourceStorage.updateSegment(resource.id, segment.index, { audioFileID, audioVoice: voice, audioStatus: 'ready' })
          this.refreshResource()
        })
        .catch(() => {
          resourceStorage.updateSegment(resource.id, segment.index, { audioStatus: 'idle', audioVoice: '' })
          this.refreshResource()
        })
    })

    if (audioTargets.length) this.refreshResource()

    const translateTarget = (resource.segments || [])
      .find(s => s.index === startIndex && !s.translation)

    if (translateTarget) {
      this.translateSegmentIfNeeded(translateTarget.index)
    }
  },

  onToggleCurrentPlayback() {
    const index = this.data.activeSegmentIndex || this.data.playingSegmentIndex || 1
    this.onPlaySegment({ currentTarget: { dataset: { index } } })
  },

  onRestartCurrent() {
    const index = this.data.activeSegmentIndex || 1
    audioManager.stopAudio()
    this.setData({
      isPlaying: false,
      currentTime: 0,
      progressPercent: 0
    })
    this.onPlaySegment({ currentTarget: { dataset: { index } } })
  },

  onClosePlayer() {
    audioManager.stopAudio()
    this.setData({
      showPlayerPanel: false,
      isPlaying: false,
      playingSegmentIndex: 0,
      activeSegmentIndex: 0,
      progressPercent: 0,
      currentTime: 0,
      duration: 0,
      timeLabel: '0:00 / 0:00'
    })
    wx.showToast({ title: '播放已停止', icon: 'none' })
  }
})
