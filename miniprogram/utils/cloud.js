/**
 * cloud.js - 云函数调用封装
 * 所有外部 API 调用统一通过云函数代理，保护密钥安全
 */

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
      data: { word },
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

/**
 * 调用 tts 云函数，合成语音
 * @param {string} text - 要合成的文本
 * @param {string} type - 'word' | 'cloze' | 'full'（用于区分不同音频）
 * @returns {Promise<string>} cloud://fileID 格式的音频文件 ID
 */
function synthesizeSpeech(text, type = 'word') {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'tts',
      data: { text, type },
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
 * 批量合成音频（单词发音 + 挖空例句 + 完整例句）
 * @param {string} word - 单词
 * @param {string} clozeExample - 挖空例句（带 ___）
 * @param {string} fullExample - 完整例句
 * @returns {Promise<Object>} { wordAudio, clozeAudio, fullAudio }
 */
async function synthesizeAllAudio(word, clozeExample, fullExample) {
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

  if (clozeExample) {
    try {
      // 挖空例句用原文（让 TTS 自然读出 "blank" 停顿）
      const clozeText = clozeExample.replace(/___/g, '...')
      results.clozeAudio = await synthesizeSpeech(clozeText, 'cloze')
    } catch (e) {
      console.error('挖空例句音频生成失败', e)
    }
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
 * @param {Array} words - 要同步的生词数组
 * @returns {Promise<void>}
 */
function syncToCloud(words) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'syncData',
      data: { words },
      success: res => {
        if (res.result && res.result.success) {
          resolve()
        } else {
          reject(new Error(res.result.error || '数据同步失败'))
        }
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
      data: { text },
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
      data: { texts },
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

module.exports = {
  login,
  generateContent,
  synthesizeSpeech,
  parseResource,
  translateText,
  translateTexts,
  synthesizeAllAudio,
  syncToCloud
}
