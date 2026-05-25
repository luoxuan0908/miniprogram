/**
 * audio-manager.js - 音频播放管理
 * 基于 wx.createInnerAudioContext 封装，支持播放/暂停/停止/预加载
 */

const ttsPreferences = require('./tts-preferences')

let audioContext = null
let currentFileID = ''
let audioState = 'stopped' // 'playing' | 'paused' | 'stopped'
let onEndCallback = null
let onErrorCallback = null
let onTimeUpdateCallback = null
let onCanplayCallback = null
let pendingPlayResolve = null
let pendingPlayReject = null
let pendingPlayTimer = null
let pendingFailTimer = null
let playRequestId = 0
let sourcePlayId = 0
let suppressNextStopEvent = false
let activeFallbackSources = []
const tempFileCache = {}
const AUDIO_EXT_RE = /\.(mp3|aac|m4a|wav)(\?|#|$)/i

function clearPendingTimers() {
  if (pendingPlayTimer) {
    clearTimeout(pendingPlayTimer)
    pendingPlayTimer = null
  }
  if (pendingFailTimer) {
    clearTimeout(pendingFailTimer)
    pendingFailTimer = null
  }
}

function clearPendingPlay() {
  clearPendingTimers()
  pendingPlayResolve = null
  pendingPlayReject = null
}

function resolvePendingPlay() {
  if (!pendingPlayResolve) return
  const resolve = pendingPlayResolve
  clearPendingPlay()
  resolve()
}

function rejectPendingPlay(err) {
  if (!pendingPlayReject) return
  const reject = pendingPlayReject
  clearPendingPlay()
  reject(err)
}

function resetActivePlayback() {
  audioState = 'stopped'
  currentFileID = ''
  activeFallbackSources = []
}

function createInterruptedError() {
  const err = new Error('播放被新的请求打断')
  err.code = 'PLAY_INTERRUPTED'
  return err
}

function createPlaybackError(err) {
  if (err instanceof Error) return err
  const message = (err && (err.errMsg || err.message || err.errCode)) || '播放失败'
  const error = new Error('播放失败: ' + message)
  error.originalError = err
  return error
}

function configureInnerAudioOption() {
  if (typeof wx.setInnerAudioOption !== 'function') return
  wx.setInnerAudioOption({
    obeyMuteSwitch: false,
    mixWithOther: true
  })
}

function safePlay(ctx, sourceId = sourcePlayId) {
  try {
    const result = ctx.play()
    if (result && typeof result.catch === 'function') {
      result.catch(err => {
        if (sourceId !== sourcePlayId) return
        if (!pendingPlayReject) return
        if (tryPlayFallbackSource(err)) return
        resetActivePlayback()
        rejectPendingPlay(createPlaybackError(err))
      })
    }
  } catch (err) {
    if (tryPlayFallbackSource(err)) return
    resetActivePlayback()
    rejectPendingPlay(createPlaybackError(err))
  }
}

function tryStartPlayback(sourceId = sourcePlayId) {
  if (!audioContext || audioState !== 'loading' || !pendingPlayResolve) return

  applyPlaybackRate(audioContext)
  safePlay(audioContext, sourceId)
}

function armPlaybackGuards(sourceId = sourcePlayId) {
  clearPendingTimers()
  pendingPlayTimer = setTimeout(() => {
    tryStartPlayback(sourceId)
  }, 800)
  pendingFailTimer = setTimeout(() => {
    if (sourceId === sourcePlayId && audioState === 'loading') {
      resetActivePlayback()
      rejectPendingPlay(new Error('音频播放启动超时'))
    }
  }, 15000)
}

/** 获取或创建音频上下文 */
function getAudioContext() {
  if (!audioContext) {
    configureInnerAudioOption()
    // 不使用 useWebAudioImplement，让微信选择原生实现，iOS 兼容性更好
    audioContext = wx.createInnerAudioContext()
    audioContext.obeyMuteSwitch = false // 静音模式下也播放

    // iOS 要求 obeyMuteSwitch 在 src 设置前赋值才生效
    // 已在上面创建时设置

    audioContext.onEnded(() => {
      resetActivePlayback()
      if (onEndCallback) onEndCallback()
    })

    audioContext.onError((err) => {
      if (tryPlayFallbackSource(err)) return

      console.error('音频播放错误', err)
      resetActivePlayback()
      if (onErrorCallback) onErrorCallback(err)
      rejectPendingPlay(createPlaybackError(err))
    })

    audioContext.onTimeUpdate(() => {
      if (onTimeUpdateCallback) {
        onTimeUpdateCallback({
          currentTime: audioContext.currentTime || 0,
          duration: audioContext.duration || 0
        })
      }
    })

    audioContext.onCanplay(() => {
      // 在音频加载完成后立即设置语速
      applyPlaybackRate(audioContext)

      if (onCanplayCallback) {
        setTimeout(() => {
          onCanplayCallback({
            currentTime: audioContext.currentTime || 0,
            duration: audioContext.duration || 0
          })
        }, 120)
      }
      // iOS 兼容：等 canplay 后再触发 play，确保音频已缓冲
      if (audioState === 'loading' && pendingPlayResolve) {
        tryStartPlayback()
      }
    })

    audioContext.onPlay(() => {
      audioState = 'playing'
      // 播放开始后再次确认语速（部分平台需要 play() 之后才接受 playbackRate）
      applyPlaybackRate(audioContext)
      resolvePendingPlay()
    })

    audioContext.onPause(() => {
      audioState = 'paused'
    })

    audioContext.onStop(() => {
      if (suppressNextStopEvent) {
        suppressNextStopEvent = false
        return
      }
      audioState = 'stopped'
      activeFallbackSources = []
    })
  }
  return audioContext
}

function normalizeTtsSpeed(value) {
  return ttsPreferences.normalizeTtsSpeed(value)
}

function getPreferredTtsSpeed() {
  return ttsPreferences.getTtsPreferences().ttsSpeed
}

function applyPlaybackRate(ctx) {
  if (!ctx) return
  const speed = getPreferredTtsSpeed()
  const rate = Math.max(0.5, Math.min(2.0, speed / 100))
  try {
    ctx.playbackRate = rate
  } catch (e) {
    // 部分平台可能不支持 playbackRate
  }
  return rate
}

function refreshPlaybackRate(speed) {
  const ctx = audioContext
  const normalized = normalizeTtsSpeed(speed === undefined ? getPreferredTtsSpeed() : speed)
  const rate = Math.max(0.5, Math.min(2.0, normalized / 100))
  if (!ctx) return rate

  try {
    ctx.playbackRate = rate
  } catch (e) {
    // 部分平台可能不支持 playbackRate
  }
  return rate
}

function uniqueSources(sources) {
  return Array.from(new Set((sources || []).filter(Boolean)))
}

function setAudioSourceAndPlay(ctx, src) {
  const sourceId = ++sourcePlayId
  applyPlaybackRate(ctx)
  ctx.src = src
  armPlaybackGuards(sourceId)
  tryStartPlayback(sourceId)
}

function tryPlayFallbackSource(err) {
  const ctx = audioContext
  if (!ctx || !pendingPlayReject || !activeFallbackSources.length) return false

  const nextSource = activeFallbackSources.shift()
  if (!nextSource) return tryPlayFallbackSource(err)

  audioState = 'loading'
  setAudioSourceAndPlay(ctx, nextSource)
  return true
}

function isCloudFile(fileID) {
  return typeof fileID === 'string' && fileID.startsWith('cloud://')
}

function isRemoteUrl(src) {
  return /^https?:\/\//i.test(src || '')
}

function isLocalAudioPath(src) {
  if (!src || isRemoteUrl(src) || isCloudFile(src)) return false
  return src.startsWith('wxfile://') || src.startsWith('file://') || src.startsWith('/') || src.indexOf('_doc/') !== -1
}

function needsLocalExtensionFallback(src) {
  return isLocalAudioPath(src) && !AUDIO_EXT_RE.test(src)
}

function copyLocalAudioWithExtension(src) {
  if (!needsLocalExtensionFallback(src)) return Promise.resolve('')
  if (!wx.getFileSystemManager || !wx.env || !wx.env.USER_DATA_PATH) return Promise.resolve('')

  const fileName = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`
  const destPath = `${wx.env.USER_DATA_PATH}/${fileName}`
  return new Promise(resolve => {
    wx.getFileSystemManager().copyFile({
      srcPath: src,
      destPath,
      success: () => resolve(destPath),
      fail: () => resolve('')
    })
  })
}

function expandLocalAudioSource(src) {
  return copyLocalAudioWithExtension(src).then(fallback => fallback ? [fallback, src] : [src])
}

function prepareAudioSources(sources) {
  return (sources || []).reduce((promise, src) => {
    return promise.then(list => expandLocalAudioSource(src).then(expanded => list.concat(expanded)))
  }, Promise.resolve([])).then(uniqueSources)
}

function getCloudTempFileURL(fileID) {
  return new Promise(resolve => {
    wx.cloud.getTempFileURL({
      fileList: [fileID],
      success: res => {
        const file = res.fileList && res.fileList[0]
        resolve(file && file.tempFileURL ? file.tempFileURL : '')
      },
      fail: () => resolve('')
    })
  })
}

function downloadCloudAudioFile(fileID) {
  if (tempFileCache[fileID]) return Promise.resolve(tempFileCache[fileID])

  return new Promise(resolve => {
    wx.cloud.downloadFile({
      fileID,
      success: res => {
        if (res.tempFilePath) {
          tempFileCache[fileID] = res.tempFilePath
          resolve(res.tempFilePath)
        } else {
          resolve('')
        }
      },
      fail: () => resolve('')
    })
  })
}

function resolveCloudAudioSources(fileID) {
  return Promise.all([
    getCloudTempFileURL(fileID),
    downloadCloudAudioFile(fileID)
  ]).then(([tempUrl, tempFilePath]) => {
    return prepareAudioSources([tempUrl, tempFilePath])
  })
}

function startResolvedSources(ctx, sources) {
  const candidates = uniqueSources(sources)
  const primary = candidates[0]
  if (!primary) {
    resetActivePlayback()
    rejectPendingPlay(new Error('音频文件不可用'))
    return
  }

  activeFallbackSources = candidates.slice(1)
  setAudioSourceAndPlay(ctx, primary)
}

/**
 * 播放音频
 * @param {string} fileID - cloud:// 格式音频文件 ID
 * @returns {Promise<void>}
 */
function playAudio(fileID) {
  return new Promise((resolve, reject) => {
    if (!fileID) {
      reject(new Error('音频文件ID为空'))
      return
    }

    const ctx = getAudioContext()
    const requestId = ++playRequestId

    if (pendingPlayReject) {
      rejectPendingPlay(createInterruptedError())
    }

    // 如果是同一个音频文件且处于暂停状态，则恢复播放
    if (currentFileID === fileID && audioState === 'paused') {
      pendingPlayResolve = resolve
      pendingPlayReject = reject
      applyPlaybackRate(ctx)
      armPlaybackGuards()
      safePlay(ctx)
      return
    }

    // 停止当前播放
    if (audioState === 'playing' || audioState === 'paused') {
      suppressNextStopEvent = true
      ctx.stop()
    }

    currentFileID = fileID
    audioState = 'loading'
    pendingPlayResolve = resolve
    pendingPlayReject = reject
    activeFallbackSources = []

    const isCurrentRequest = () => requestId === playRequestId && currentFileID === fileID && audioState === 'loading'

    if (isCloudFile(fileID)) {
      resolveCloudAudioSources(fileID)
        .then(sources => {
          if (!isCurrentRequest()) return
          startResolvedSources(ctx, sources)
        })
        .catch(err => {
          if (!isCurrentRequest()) return
          resetActivePlayback()
          rejectPendingPlay(createPlaybackError(err))
        })
    } else {
      prepareAudioSources([fileID])
        .then(sources => {
          if (!isCurrentRequest()) return
          startResolvedSources(ctx, sources)
        })
        .catch(err => {
          if (!isCurrentRequest()) return
          resetActivePlayback()
          rejectPendingPlay(createPlaybackError(err))
        })
    }
  })
}

/** 暂停音频 */
function pauseAudio() {
  const ctx = audioContext
  if (ctx && audioState === 'playing') {
    ctx.pause()
  }
}

/** 恢复播放 */
function resumeAudio() {
  const ctx = audioContext
  if (ctx && audioState === 'paused') {
    applyPlaybackRate(ctx)
    ctx.play()
  }
}

/** 停止音频 */
function stopAudio() {
  const ctx = audioContext
  if (ctx) {
    ctx.stop()
    resetActivePlayback()
    clearPendingPlay()
  }
}

/** 获取当前音频状态 */
function getAudioState() {
  return audioState
}

/** 获取当前播放的音频 ID */
function getCurrentFileID() {
  return currentFileID
}

function getCurrentTime() {
  return audioContext ? (audioContext.currentTime || 0) : 0
}

function getDuration() {
  return audioContext ? (audioContext.duration || 0) : 0
}

function seekAudio(position) {
  const ctx = audioContext
  if (ctx && typeof ctx.seek === 'function') {
    ctx.seek(position)
  }
}

/** 设置播放结束回调 */
function onEnded(callback) {
  onEndCallback = callback
}

/** 设置播放错误回调 */
function onError(callback) {
  onErrorCallback = callback
}

function onTimeUpdate(callback) {
  onTimeUpdateCallback = callback
}

function onCanplay(callback) {
  onCanplayCallback = callback
}

/** 预加载音频（获取临时链接缓存） */
function preloadAudio(fileIDs) {
  if (!fileIDs || fileIDs.length === 0) return Promise.resolve()

  const cloudFiles = fileIDs.filter(id => id && id.startsWith('cloud://'))
  if (cloudFiles.length === 0) return Promise.resolve()

  return Promise.all(cloudFiles.map(fileID => {
    if (tempFileCache[fileID]) return Promise.resolve()

    return new Promise(resolve => {
      wx.cloud.downloadFile({
        fileID,
        success: res => {
          if (res.tempFilePath) tempFileCache[fileID] = res.tempFilePath
          resolve()
        },
        fail: () => resolve()
      })
    })
  })).then(() => undefined)
}

/** 销毁音频上下文 */
function destroyAudio() {
  if (audioContext) {
    audioContext.destroy()
    audioContext = null
    currentFileID = ''
    audioState = 'stopped'
    activeFallbackSources = []
    onTimeUpdateCallback = null
    onCanplayCallback = null
    clearPendingPlay()
  }
}

module.exports = {
  playAudio,
  pauseAudio,
  resumeAudio,
  stopAudio,
  getAudioState,
  getCurrentFileID,
  getCurrentTime,
  getDuration,
  seekAudio,
  onEnded,
  onError,
  onTimeUpdate,
  onCanplay,
  preloadAudio,
  refreshPlaybackRate,
  destroyAudio
}
