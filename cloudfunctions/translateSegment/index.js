const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '在此填入你的DeepSeek API Key'
const MODEL_KEY = 'deepseek-chat-text'
const MODEL_OPERATION = 'text_generation'

/**
 * Node.js HTTPS POST
 */
function httpsPost(url, headers, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, data: body }))
    })

    req.on('error', reject)
    req.setTimeout(25000, () => req.destroy(new Error('翻译请求超时')))
    req.write(data)
    req.end()
  })
}

/**
 * translateSegment - 独立翻译云函数
 *
 * 支持两种调用方式：
 * 1. 单段翻译：{ text: "English text" }
 * 2. 批量翻译：{ texts: ["text1", "text2", ...] }（最多 12 段）
 *
 * 返回：
 * - 单段：{ success: true, translation: "中文翻译" }
 * - 批量：{ success: true, translations: ["翻译1", "翻译2", ...] }
 */
exports.main = async (event = {}) => {
  const { text, texts } = event

  // 批量模式
  if (texts && Array.isArray(texts) && texts.length > 0) {
    const batch = texts.slice(0, 12) // 最多 12 段
    const result = await translateBatch(batch, event.requestId || createRequestId('translate_batch'))
    if (!result.success) return result
    return {
      success: true,
      translations: result.translations,
      billing: result.billing
    }
  }

  // 单段模式
  if (!text || !text.trim()) {
    return { success: false, error: '翻译文本不能为空' }
  }

  const result = await translateBatch([text.trim()], event.requestId || createRequestId('translate_one'))
  if (!result.success) return result
  return {
    success: true,
    translation: result.translations[0] || '',
    billing: result.billing
  }
}

function createRequestId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function estimateTextTokens(text) {
  const content = String(text || '').trim()
  if (!content) return 1
  return Math.max(1, Math.ceil(content.length / 4))
}

function estimateMessageTokens(messages, maxOutputTokens) {
  const inputTokens = messages.reduce((sum, message) => sum + estimateTextTokens(message.content) + 6, 0)
  return {
    input_tokens: inputTokens,
    output_tokens: Math.max(1, Number(maxOutputTokens) || 1)
  }
}

function extractUsageMeters(usage, fallbackMeters) {
  if (!usage || typeof usage !== 'object') return fallbackMeters
  const promptTokens = Number(usage.prompt_tokens || usage.input_tokens || 0)
  const completionTokens = Number(usage.completion_tokens || usage.output_tokens || 0)
  const cachedTokens = Number(usage.cached_input_tokens || usage.prompt_cache_hit_tokens || 0)
  const meters = {}
  if (promptTokens > 0) meters.input_tokens = Math.max(0, promptTokens - Math.max(0, cachedTokens))
  if (completionTokens > 0) meters.output_tokens = completionTokens
  if (cachedTokens > 0) meters.cached_input_tokens = cachedTokens
  return Object.keys(meters).length ? meters : fallbackMeters
}

function getCurrentOpenid() {
  try {
    const wxContext = cloud.getWXContext()
    return (wxContext && wxContext.OPENID) || ''
  } catch (err) {
    return ''
  }
}

async function callBilling(action, payload) {
  try {
    const openid = getCurrentOpenid()
    const res = await cloud.callFunction({
      name: 'billing',
      data: {
        action,
        ...payload,
        ...(openid ? { openid } : {})
      }
    })
    return res.result || { success: false, error: '计费服务无返回' }
  } catch (err) {
    console.warn('billing call failed:', err && err.message)
    return {
      success: false,
      skipped: true,
      allowed: true,
      error: err && err.message
    }
  }
}

async function ensureBillingAllowed(payload) {
  const result = await callBilling('precheck', payload)
  if (!result.success) {
    throw new Error(result.error || '计费服务不可用')
  }
  if (result.success && result.allowed === false) {
    throw new Error(result.error || 'AI 余额不足')
  }
  return result
}

async function translateBatch(texts, requestId) {
  if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === '在此填入你的DeepSeek API Key') {
    return { success: true, translations: texts.map(() => '') }
  }

  const prompt = `Translate these English learning paragraphs into concise, natural Simplified Chinese. Return only a JSON array of strings with the same order and length.\n\n${JSON.stringify(texts)}`
  const maxTokens = 3000
  const messages = [
    { role: 'system', content: 'You return strict JSON only.' },
    { role: 'user', content: prompt }
  ]
  const estimatedMeters = estimateMessageTokens(messages, maxTokens)

  try {
    const billingPrecheck = await ensureBillingAllowed({
      requestId,
      modelKey: MODEL_KEY,
      operation: MODEL_OPERATION,
      meters: estimatedMeters,
      usageSource: 'estimated',
      metadata: {
        feature: 'segment_translate',
        itemCount: texts.length
      }
    })
    const providerModel = billingPrecheck.model && billingPrecheck.model.providerModel
    if (!providerModel) throw new Error('模型目录未返回 providerModel')

    const body = JSON.stringify({
      model: providerModel,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens
    })

    const response = await httpsPost(
      'https://api.deepseek.com/v1/chat/completions',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      body
    )

    if (response.statusCode !== 200) {
      console.error('DeepSeek API error:', response.statusCode, response.data.substring(0, 300))
      return { success: true, translations: texts.map(() => '') }
    }

    const data = JSON.parse(response.data)
    const billing = await callBilling('settle', {
      requestId,
      modelKey: MODEL_KEY,
      operation: MODEL_OPERATION,
      providerUsage: data.usage || null,
      meters: extractUsageMeters(data.usage, estimatedMeters),
      usageSource: data.usage ? 'provider' : 'estimated',
      metadata: {
        feature: 'segment_translate',
        itemCount: texts.length
      }
    })
    const content = data.choices && data.choices[0] && data.choices[0].message.content
    if (!content) return { success: true, translations: texts.map(() => ''), billing }

    let parsed
    try {
      parsed = JSON.parse(content)
    } catch (e) {
      const match = content.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (!match) {
        console.warn('DeepSeek translation parse failed: no JSON block')
        return { success: true, translations: texts.map(() => ''), billing }
      }
      parsed = JSON.parse(match[1])
    }

    if (!Array.isArray(parsed)) {
      console.warn('DeepSeek translation parse failed: response is not an array')
      return { success: true, translations: texts.map(() => ''), billing }
    }

    const translations = texts.map((_, index) => Array.isArray(parsed) ? (parsed[index] || '') : '')
    return { success: true, translations, billing }
  } catch (e) {
    console.error('translateBatch failed:', e)
    return { success: false, error: e.message || '翻译失败', translations: texts.map(() => '') }
  }
}
