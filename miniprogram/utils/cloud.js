const ttsPreferences = require('./tts-preferences')

/**
 * cloud.js - 云函数调用封装
 * 所有外部 API 调用统一通过云函数代理，保护密钥安全
 */

function createRequestId(prefix) {
  const random = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now()}_${random}`
}

/** 调用 login 云函数，返回 openid */
function login() {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'login',
      success: res => resolve(res.result.openid),
      fail: err => reject(err)
    })
  })
}

/**
 * 调用 generateContent 云函数
 * @param {string} word - 要生成内容的单词
 * @returns {Promise<Object>} 结构化学习内容
 */
function generateContent(word) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'generateContent',
      data: {
        word,
        requestId: createRequestId('word_content')
      },
      success: res => {
        if (res.result && res.result.success) {
          resolve(res.result.content)
        } else {
          reject(new Error(res.result.error || '内容生成失败'))
        }
      },
      fail: err => reject(err)
    })
  })
}

function generatePhonetic(word) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'generateContent',
      data: {
        word,
        mode: 'phonetic',
        requestId: createRequestId('phonetic')
      },
      success: res => {
        if (res.result && res.result.success) {
          const content = res.result.content || {}
          resolve(content.phonetic || '')
        } else {
          reject(new Error((res.result && res.result.error) || '音标生成失败'))
        }
      },
      fail: err => reject(err)
    })
  })
}

function generatePronunciation(word) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'generateContent',
      data: {
        word,
        mode: 'phonetic',
        requestId: createRequestId('phonetic')
      },
      success: res => {
        if (res.result && res.result.success) {
          resolve(res.result.content || {})
        } else {
          reject(new Error((res.result && res.result.error) || '发音信息生成失败'))
        }
      },
      fail: err => reject(err)
    })
  })
}

function uploadPronunciationRecording(tempFilePath, word) {
  const safeWord = String(word || 'word').replace(/[^\w-]/g, '_').slice(0, 32) || 'word'
  const cloudPath = `pronunciation/${Date.now()}-${safeWord}.mp3`
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath,
      filePath: tempFilePath,
      success: res => resolve(res.fileID),
      fail: err => reject(err)
    })
  })
}

function uploadShadowRecording(tempFilePath, resourceId, segmentIndex) {
  const safeResourceId = String(resourceId || 'resource').replace(/[^\w-]/g, '_').slice(0, 48) || 'resource'
  const safeSegment = String(segmentIndex || 0).replace(/[^\w-]/g, '_') || '0'
  const cloudPath = `shadowing/${safeResourceId}/${Date.now()}-segment-${safeSegment}.mp3`
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath,
      filePath: tempFilePath,
      success: res => resolve(res.fileID),
      fail: err => reject(err)
    })
  })
}

function deleteCloudFiles(fileIDs) {
  const fileList = (Array.isArray(fileIDs) ? fileIDs : [fileIDs]).filter(Boolean)
  if (!fileList.length) return Promise.resolve()
  return new Promise((resolve, reject) => {
    wx.cloud.deleteFile({
      fileList,
      success: res => resolve(res),
      fail: err => reject(err)
    })
  })
}

function generateResourceStudyPack(payload) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'generateResourceStudyPack',
      data: {
        ...(payload || {}),
        requestId: createRequestId('resource_study_pack')
      },
      success: res => {
        if (res.result && res.result.success) {
          resolve(res.result.studyPack)
        } else {
          reject(new Error((res.result && res.result.error) || '精读任务生成失败'))
        }
      },
      fail: err => reject(err)
    })
  })
}

/**
 * 调用 tts 云函数，合成语音
 * @param {string} text - 要合成的文本
 * @param {string} type - 'word' | 'cloze' | 'full'（用于区分不同音频）
 * @param {{ voice?: string }} options - TTS 音色选项
 * @returns {Promise<string>} cloud://fileID 格式的音频文件 ID
 */
function synthesizeSpeech(text, type = 'word', options = {}) {
  const voice = ttsPreferences.normalizeTtsVoice(
    options.voice || ttsPreferences.getTtsPreferences().ttsVoice
  )

  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'tts',
      data: {
        text,
        type,
        voice,
        requestId: createRequestId('tts')
      },
      success: res => {
        if (res.result && res.result.success) {
          resolve(res.result.fileID)
        } else {
          reject(new Error(res.result.error || '语音合成失败'))
        }
      },
      fail: err => reject(err)
    })
  })
}

/**
 * 调用 parseResource 云函数，解析 URL 或本地文件文本为文档段落
 * @param {{ url?: string, text?: string, fileName?: string, fileType?: string, sourceType?: string }} payload
 * @returns {Promise<Object>} Resource draft
 */
function parseResource(payload) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'parseResource',
      data: payload,
      success: res => {
        if (res.result && res.result.success) {
          resolve(res.result.resource)
        } else {
          reject(new Error((res.result && res.result.error) || '资源解析失败'))
        }
      },
      fail: err => reject(err)
    })
  })
}

/**
 * 批量合成音频（单词发音 + 完整例句）
 * @param {string} word - 单词
 * @param {string} fullExample - 完整例句
 * @returns {Promise<Object>} { wordAudio, fullAudio }
 */
async function synthesizeAllAudio(word, fullExample) {
  const results = {
    wordAudio: '',
    clozeAudio: '',
    fullAudio: ''
  }

  try {
    // 单词音频
    results.wordAudio = await synthesizeSpeech(word, 'word')
  } catch (e) {
    console.error('单词音频生成失败', e)
  }

  if (fullExample) {
    try {
      results.fullAudio = await synthesizeSpeech(fullExample, 'full')
    } catch (e) {
      console.error('完整例句音频生成失败', e)
    }
  }

  return results
}

/**
 * 调用 syncData 云函数，同步本地数据到云端
 * @param {Array|Object} payload - 兼容旧的 words 数组，也支持增量同步 payload
 * @returns {Promise<void>}
 */
function syncToCloud(payload) {
  const data = Array.isArray(payload) ? { words: payload } : (payload || {})
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'syncData',
      data,
      success: res => {
        const result = res.result || {}
        if (!result.success) {
          reject(new Error(result.error || '数据同步失败'))
          return
        }
        // 检查是否有部分失败
        const wordFailed = result.words && result.words.failed > 0 ? result.words.failed : 0
        const resourceFailed = result.resources && result.resources.failed > 0 ? result.resources.failed : 0
        const prefFailed = result.preferences && result.preferences.failed > 0 ? result.preferences.failed : 0
        const totalFailed = wordFailed + resourceFailed + prefFailed
        if (totalFailed > 0) {
          console.warn(`同步部分失败: words=${wordFailed}, resources=${resourceFailed}, preferences=${prefFailed}`)
        }
        resolve(result)
      },
      fail: err => reject(err)
    })
  })
}

/**
 * 调用 translateSegment 云函数，翻译单段文本
 * @param {string} text - 要翻译的英文文本
 * @returns {Promise<string>} 中文翻译
 */
function translateText(text) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'translateSegment',
      data: {
        text,
        requestId: createRequestId('translate_one')
      },
      success: res => {
        if (res.result && res.result.success) {
          resolve(res.result.translation || '')
        } else {
          reject(new Error((res.result && res.result.error) || '翻译失败'))
        }
      },
      fail: err => reject(err)
    })
  })
}

/**
 * 调用 translateSegment 云函数，批量翻译多段文本（最多 12 段）
 * @param {string[]} texts - 要翻译的英文文本数组
 * @returns {Promise<string[]>} 中文翻译数组
 */
function translateTexts(texts) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'translateSegment',
      data: {
        texts,
        requestId: createRequestId('translate_batch')
      },
      success: res => {
        if (res.result && res.result.success) {
          resolve(res.result.translations || [])
        } else {
          reject(new Error((res.result && res.result.error) || '批量翻译失败'))
        }
      },
      fail: err => reject(err)
    })
  })
}

function getBillingAccount() {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'billing',
      data: { action: 'getAccount' },
      success: res => {
        const result = res.result || {}
        if (result.success) {
          resolve(result)
        } else {
          reject(new Error(result.error || '获取余额失败'))
        }
      },
      fail: err => reject(err)
    })
  })
}

function getBillingLedger(options = {}) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'billing',
      data: {
        action: 'getLedger',
        limit: options.limit || 20,
        offset: options.offset || 0
      },
      success: res => {
        const result = res.result || {}
        if (result.success) {
          resolve(result)
        } else {
          reject(new Error(result.error || '获取用量明细失败'))
        }
      },
      fail: err => reject(err)
    })
  })
}

module.exports = {
  login,
  generateContent,
  generatePhonetic,
  generatePronunciation,
  uploadPronunciationRecording,
  uploadShadowRecording,
  deleteCloudFiles,
  generateResourceStudyPack,
  synthesizeSpeech,
  parseResource,
  translateText,
  translateTexts,
  synthesizeAllAudio,
  syncToCloud,
  getBillingAccount,
  getBillingLedger
}
