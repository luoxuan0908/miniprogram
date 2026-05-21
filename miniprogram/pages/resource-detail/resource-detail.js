const cloud = require('../../utils/cloud')
const audioManager = require('../../utils/audio-manager')
const resourceStorage = require('../../utils/resource-storage')

const MAX_SEGMENT_AUDIO_SECONDS = 10 * 60

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
    showPlayerPanel: true,
    isGeneratingAudio: false,
    translatingSegments: {},
    translationsOpen: {},
    waveBars: [0, 1, 2, 3, 4, 2, 1, 3, 0, 4, 1, 2, 3, 1, 4, 2],
    currentTime: 0,
    duration: 0,
    progressPercent: 0,
    timeLabel: '0:00 / 0:00'
  },

  onLoad(options) {
    this.bindAudioEvents()
    if (options.id) {
      this.loadResource(options.id)
    } else {
      this.setData({ loading: false })
    }
  },

  onUnload() {
    audioManager.stopAudio()
    audioManager.onEnded(null)
    audioManager.onError(null)
    audioManager.onTimeUpdate(null)
    audioManager.onCanplay(null)
  },

  bindAudioEvents() {
    audioManager.onEnded(() => {
      const safeDuration = normalizeAudioSeconds(this.data.duration)

      this.setData({
        isPlaying: false,
        duration: safeDuration,
        currentTime: 0,
        progressPercent: 0,
        timeLabel: formatTimeLabel(0, safeDuration)
      })
    })

    audioManager.onError(() => {
      this.setData({ isPlaying: false, isGeneratingAudio: false })
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
    this.setData({
      resource: this.decorateResource(resourceStorage.getResourceById(id)),
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
    this.setData({ resource })
  },

  decorateResource(resource) {
    if (!resource) return null
    const translationsOpen = this.data.translationsOpen || {}
    const translatingSegments = this.data.translatingSegments || {}
    return {
      ...resource,
      segments: (resource.segments || []).map(segment => ({
        ...segment,
        translationOpen: !!translationsOpen[segment.index],
        isTranslating: !!translatingSegments[segment.index]
      }))
    }
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

    let audioFileID = segment.audioFileID
    if (!audioFileID) {
      audioFileID = await this.generateSegmentAudio(index)
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

  async generateSegmentAudio(index) {
    const resource = this.data.resource
    const segment = (resource.segments || []).find(s => s.index === index)
    if (!segment) return ''

    this.setData({ isGeneratingAudio: true })
    resourceStorage.updateSegment(resource.id, index, { audioStatus: 'generating' })
    this.refreshResource()

    try {
      const audioFileID = await cloud.synthesizeSpeech(segment.text, 'resource')
      resourceStorage.updateSegment(resource.id, index, {
        audioFileID,
        audioStatus: 'ready',
        lastPlayedAt: Date.now()
      })
      this.refreshResource()
      return audioFileID
    } catch (err) {
      resourceStorage.updateSegment(resource.id, index, { audioStatus: 'error' })
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

    const audioTargets = (resource.segments || [])
      .filter(s => s.index >= startIndex && s.index < startIndex + 2 && !s.audioFileID && s.audioStatus !== 'generating')

    audioTargets.forEach(segment => {
      resourceStorage.updateSegment(resource.id, segment.index, { audioStatus: 'generating' })
      cloud.synthesizeSpeech(segment.text, 'resource')
        .then(audioFileID => {
          resourceStorage.updateSegment(resource.id, segment.index, { audioFileID, audioStatus: 'ready' })
          this.refreshResource()
        })
        .catch(() => {
          resourceStorage.updateSegment(resource.id, segment.index, { audioStatus: 'idle' })
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
