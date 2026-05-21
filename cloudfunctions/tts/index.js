const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 优先读环境变量，否则用下方硬编码
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '在此填入你的DashScope API Key'

/**
 * Node.js HTTPS POST
 */
function httpsPost(url, headers, data) {
  return new Promise((resolve, reject) => {
    console.log('[DEBUG] httpsPost raw URL:', url)
    const urlObj = new URL(url)
    console.log('[DEBUG] parsed hostname:', urlObj.hostname, 'port:', urlObj.port || '443', 'pathname:', urlObj.pathname)
    console.log('[DEBUG] HTTPS_PROXY:', process.env.HTTPS_PROXY, 'HTTP_PROXY:', process.env.HTTP_PROXY)

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(data)
      }
    }

    console.log('[DEBUG] request options:', JSON.stringify(options))

    const req = https.request(options, (res) => {
      const chunks = []
      res.on('data', chunk => { chunks.push(chunk) })
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        resolve({ statusCode: res.statusCode, data: body })
      })
    })

    req.on('error', reject)
    req.setTimeout(25000, () => {
      req.destroy(new Error('请求超时'))
    })
    req.write(data)
    req.end()
  })
}

/**
 * 下载音频文件（复用 httpsPost 的相同模式，method 改 GET）
 */
function downloadAudio(audioUrl) {
  return new Promise((resolve, reject) => {
    console.log('[DEBUG] downloadAudio raw:', typeof audioUrl, JSON.stringify(audioUrl))

    if (!audioUrl || typeof audioUrl !== 'string') {
      return reject(new Error('audioUrl is not a string: ' + typeof audioUrl))
    }

    let url = audioUrl.trim()
    if (!url) {
      return reject(new Error('audioUrl is empty'))
    }

    // 补全协议（某些返回可能是协议相对URL）
    if (url.startsWith('//')) {
      url = 'https:' + url
    }

    let urlObj
    try {
      urlObj = new URL(url)
    } catch (e) {
      console.error('[DEBUG] Invalid URL string:', url)
      return reject(new Error('Invalid URL: ' + url))
    }

    console.log('[DEBUG] downloadAudio parsed:', urlObj.hostname, urlObj.port || '443')

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET'
    }

    const req = https.request(options, (res) => {
      console.log('[DEBUG] downloadAudio status:', res.statusCode, 'location:', !!res.headers.location)

      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log('[DEBUG] redirect to:', res.headers.location.substring(0, 100))
        req.destroy()
        return downloadAudio(res.headers.location).then(resolve).catch(reject)
      }

      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const buffer = Buffer.concat(chunks)
        console.log('[DEBUG] downloadAudio done, size:', buffer.length)
        resolve(buffer)
      })
    })

    req.on('error', (err) => {
      console.error('[DEBUG] downloadAudio error:', err.message)
      reject(err)
    })
    req.setTimeout(25000, () => req.destroy(new Error('下载超时')))
    req.end()
  })
}

/**
 * 阿里云百炼 Qwen-TTS 语音合成（非流式 HTTP API）
 * 返回音频 URL → 下载 → 上传云存储
 */
exports.main = async (event, context) => {
  const { text, type = 'word' } = event

  if (!text || !text.trim()) {
    return { success: false, error: '文本不能为空' }
  }

  if (!DASHSCOPE_API_KEY || DASHSCOPE_API_KEY === '在此填入你的DashScope API Key') {
    return { success: false, error: 'DASHSCOPE_API_KEY 未配置' }
  }

  try {
    // 根据文本类型选择语音和语言
    const isEnglish = /[a-zA-Z]/.test(text.trim())
    const voice = isEnglish ? 'Cherry' : 'longxiaochun'
    const languageType = isEnglish ? 'English' : 'Chinese'

    const requestBody = JSON.stringify({
      model: 'qwen3-tts-flash',
      input: {
        text: text.trim(),
        voice: voice,
        language_type: languageType
      }
    })

    console.log('TTS request:', text.trim().substring(0, 50), 'voice:', voice, 'type:', type)

    const response = await httpsPost(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DASHSCOPE_API_KEY}`
      },
      requestBody
    )

    console.log('TTS response status:', response.statusCode)

    if (response.statusCode !== 200) {
      return { success: false, error: `TTS API 返回错误: ${response.statusCode} - ${response.data.substring(0, 500)}` }
    }

    const data = JSON.parse(response.data)

    console.log('[DEBUG] TTS response output:', JSON.stringify(data.output || data).substring(0, 500))

    // 从响应中提取音频 URL
    let audioUrl = null

    if (data.output) {
      // data.output.audio 可能是对象 { data, expires_at, id, url } 或字符串 URL
      if (data.output.audio && typeof data.output.audio === 'object' && data.output.audio.url) {
        audioUrl = data.output.audio.url
      } else if (typeof data.output.audio === 'string') {
        audioUrl = data.output.audio
      }
      // 也兼容 results 数组格式
      if (!audioUrl && data.output.results && data.output.results[0]) {
        const r = data.output.results[0]
        if (r.audio && typeof r.audio === 'object' && r.audio.url) {
          audioUrl = r.audio.url
        } else if (typeof r.audio === 'string') {
          audioUrl = r.audio
        } else if (r.url) {
          audioUrl = r.url
        }
      }
    }

    console.log('[DEBUG] extracted audioUrl type:', typeof audioUrl, 'value:', JSON.stringify(audioUrl))

    if (!audioUrl || typeof audioUrl !== 'string') {
      const errMsg = data.message || JSON.stringify(data.output || data).substring(0, 300)
      return { success: false, error: `TTS 响应异常（未获取到有效音频URL）: ${errMsg}` }
    }

    console.log('Audio URL obtained, downloading...')

    // 下载音频文件
    const audioData = await downloadAudio(audioUrl)

    if (!audioData || audioData.length === 0) {
      return { success: false, error: '下载音频数据为空' }
    }

    console.log('Audio downloaded, size:', audioData.length, 'bytes')

    // 上传到云存储
    const safeText = text.replace(/[^\w\u4e00-\u9fff]/g, '_').substring(0, 20)
    const cloudPath = `audio/${type}/${safeText}_${Date.now()}.mp3`

    const uploadResult = await cloud.uploadFile({
      cloudPath: cloudPath,
      fileContent: audioData
    })

    console.log('Audio uploaded, fileID:', uploadResult.fileID)

    return {
      success: true,
      fileID: uploadResult.fileID,
      cloudPath: cloudPath
    }
  } catch (err) {
    console.error('tts error:', err)
    return { success: false, error: err.message || '语音合成失败' }
  }
}
