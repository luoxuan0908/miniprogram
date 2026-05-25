const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || ''
const DEFAULT_VOICE = 'Cherry'
const SUPPORTED_VOICES = ['Cherry', 'Serena', 'Ethan', 'Moon', 'Chelsie']
const MODEL_KEY = 'dashscope-qwen3-tts-flash'
const MODEL_OPERATION = 'tts'

function normalizeVoice(value) {
  const voice = String(value || '').trim()
  return SUPPORTED_VOICES.indexOf(voice) === -1 ? DEFAULT_VOICE : voice
}

function createRequestId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

async function callBilling(action, payload) {
  try {
    const res = await cloud.callFunction({
      name: 'billing',
      data: { action, ...payload }
    })
    return res.result || { success: false, error: '计费服务无返回' }
  } catch (err) {
    console.warn('billing call failed:', err && err.message)
    return { success: false, skipped: true, allowed: true, error: err && err.message }
  }
}

async function ensureBillingAllowed(payload) {
  const result = await callBilling('precheck', payload)
  if (!result.success) throw new Error(result.error || '计费服务不可用')
  if (result.success && result.allowed === false) throw new Error(result.error || 'AI 余额不足')
  return result
}

function httpsPost(url, headers, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
    }

    const req = https.request(options, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ statusCode: res.statusCode, data: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.setTimeout(25000, () => req.destroy(new Error('请求超时')))
    req.write(data)
    req.end()
  })
}

function downloadAudio(audioUrl) {
  return new Promise((resolve, reject) => {
    if (!audioUrl || typeof audioUrl !== 'string') {
      return reject(new Error('audioUrl is not a string: ' + typeof audioUrl))
    }

    let url = audioUrl.trim()
    if (!url) return reject(new Error('audioUrl is empty'))
    if (url.startsWith('//')) url = 'https:' + url

    let urlObj
    try { urlObj = new URL(url) }
    catch (e) { return reject(new Error('Invalid URL: ' + url)) }

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET'
    }

    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy()
        return downloadAudio(res.headers.location).then(resolve).catch(reject)
      }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('error', reject)
    req.setTimeout(25000, () => req.destroy(new Error('下载超时')))
    req.end()
  })
}

exports.main = async (event, context) => {
  const { text, type = 'word' } = event

  if (!text || !text.trim()) return { success: false, error: '文本不能为空' }
  if (!DASHSCOPE_API_KEY) return { success: false, error: 'DASHSCOPE_API_KEY 未配置' }

  try {
    const trimmedText = text.trim()
    const requestId = event.requestId || createRequestId('tts')
    const meters = { tts_chars: trimmedText.length }

    const billingPrecheck = await ensureBillingAllowed({
      requestId, modelKey: MODEL_KEY, operation: MODEL_OPERATION,
      meters, usageSource: 'estimated', metadata: { feature: 'tts', type }
    })
    const providerModel = billingPrecheck.model && billingPrecheck.model.providerModel
    if (!providerModel) throw new Error('模型目录未返回 providerModel')

    const isEnglish = /[a-zA-Z]/.test(trimmedText)
    const voice = normalizeVoice(event.voice)
    const languageType = isEnglish ? 'English' : 'Chinese'

    const requestBody = JSON.stringify({
      model: providerModel,
      input: { text: trimmedText, voice, language_type: languageType }
    })

    const response = await httpsPost(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DASHSCOPE_API_KEY}` },
      requestBody
    )

    if (response.statusCode !== 200) {
      return { success: false, error: `TTS API 返回错误: ${response.statusCode} - ${response.data.substring(0, 500)}` }
    }

    const data = JSON.parse(response.data)

    // 从响应中提取音频 URL
    let audioUrl = null
    if (data.output) {
      if (data.output.audio && typeof data.output.audio === 'object' && data.output.audio.url) {
        audioUrl = data.output.audio.url
      } else if (typeof data.output.audio === 'string') {
        audioUrl = data.output.audio
      }
      if (!audioUrl && data.output.results && data.output.results[0]) {
        const r = data.output.results[0]
        if (r.audio && typeof r.audio === 'object' && r.audio.url) audioUrl = r.audio.url
        else if (typeof r.audio === 'string') audioUrl = r.audio
        else if (r.url) audioUrl = r.url
      }
    }

    if (!audioUrl || typeof audioUrl !== 'string') {
      const errMsg = data.message || JSON.stringify(data.output || data).substring(0, 300)
      return { success: false, error: `TTS 响应异常: ${errMsg}` }
    }

    const audioData = await downloadAudio(audioUrl)
    if (!audioData || audioData.length === 0) return { success: false, error: '下载音频数据为空' }

    const safeText = trimmedText.replace(/[^\w\u4e00-\u9fff]/g, '_').substring(0, 20)
    const safeType = String(type || 'word').replace(/[^\w-]/g, '_').substring(0, 24)
    const cloudPath = `audio/${safeType}/${voice}_${safeText}_${Date.now()}.mp3`

    const uploadResult = await cloud.uploadFile({ cloudPath, fileContent: audioData })

    await callBilling('settle', {
      requestId, modelKey: MODEL_KEY, operation: MODEL_OPERATION,
      providerUsage: data.usage || null, meters, usageSource: 'estimated',
      metadata: { feature: 'tts', type, voice, cloudPath }
    })

    return { success: true, fileID: uploadResult.fileID, cloudPath }
  } catch (err) {
    console.error('tts error:', err)
    return { success: false, error: err.message || '语音合成失败' }
  }
}
