/**
 * audio-manager.js - 音频播放管理
 * 基于 wx.createInnerAudioContext 封装，支持播放/暂停/停止/预加载
 */

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
let suppressNextStopEvent = false
const tempFileCache = {}

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

function createInterruptedError() {
  const err = new Error('播放被新的请求打断')
  err.code = 'PLAY_INTERRUPTED'
  return err
}

function configureInnerAudioOption() {
  if (typeof wx.setInnerAudioOption !== 'function') return
  wx.setInnerAudioOption({
    obeyMuteSwitch: false,
    mixWithOther: true
  })
}

function tryStartPlayback() {
  if (!audioContext || audioState !== 'loading' || !pendingPlayResolve) return

  try {
    audioContext.play()
  } catch (err) {
    rejectPendingPlay(err)
  }
}

function armPlaybackGuards() {
  clearPendingTimers()
  pendingPlayTimer = setTimeout(() => {
    tryStartPlayback()
  }, 800)
  pendingFailTimer = setTimeout(() => {
    if (audioState === 'loading') {
      audioState = 'stopped'
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
      audioState = 'stopped'
      currentFileID = ''
      if (onEndCallback) onEndCallback()
    })

    audioContext.onError((err) => {
      console.error('音频播放错误', err)
      audioState = 'stopped'
      currentFileID = ''
      if (onErrorCallback) onErrorCallback(err)
      rejectPendingPlay(new Error('播放失败: ' + (err.errMsg || err.errCode)))
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
    })
  }
  return audioContext
}

function setAudioSourceAndPlay(ctx, src) {
  ctx.src = src
  armPlaybackGuards()
  tryStartPlayback()
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
      armPlaybackGuards()
      ctx.play()
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

    const isCurrentRequest = () => requestId === playRequestId && currentFileID === fileID && audioState === 'loading'

    // cloud:// 格式需要先转换为临时链接
    if (fileID.startsWith('cloud://')) {
      if (tempFileCache[fileID]) {
        setAudioSourceAndPlay(ctx, tempFileCache[fileID])
        return
      }

      wx.cloud.downloadFile({
        fileID,
        success: res => {
          if (!isCurrentRequest()) return

          if (res.tempFilePath) {
            tempFileCache[fileID] = res.tempFilePath
            setAudioSourceAndPlay(ctx, res.tempFilePath)
          } else {
            audioState = 'stopped'
            rejectPendingPlay(new Error('下载音频文件失败'))
          }
        },
        fail: err => {
          if (!isCurrentRequest()) return

          wx.cloud.getTempFileURL({
            fileList: [fileID],
            success: res => {
              if (!isCurrentRequest()) return

              if (res.fileList && res.fileList[0] && res.fileList[0].tempFileURL) {
                setAudioSourceAndPlay(ctx, res.fileList[0].tempFileURL)
              } else {
                audioState = 'stopped'
                rejectPendingPlay(new Error('获取音频临时链接失败'))
              }
            },
            fail: () => {
              if (!isCurrentRequest()) return
              audioState = 'stopped'
              rejectPendingPlay(err)
            }
          })
        }
      })
    } else {
      // 直接 URL 或本地临时文件路径
      setAudioSourceAndPlay(ctx, fileID)
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
    ctx.play()
  }
}

/** 停止音频 */
function stopAudio() {
  const ctx = audioContext
  if (ctx) {
    ctx.stop()
    currentFileID = ''
    audioState = 'stopped'
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
  destroyAudio
}
