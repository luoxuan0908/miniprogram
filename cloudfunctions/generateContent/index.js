const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 优先读环境变量，否则用下方硬编码（部署后请替换为真实 key）
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '在此填入你的DeepSeek API Key'
const MODEL_KEY = 'deepseek-chat-text'
const MODEL_OPERATION = 'text_generation'

/**
 * Node.js 原生 HTTPS POST 请求
 */
function httpsPost(url, headers, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(data)
      }
    }

    const req = https.request(options, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, data: body })
      })
    })

    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const options = {
      hostname: urlObj.hostname,
      path: `${urlObj.pathname}${urlObj.search}`,
      method: 'GET',
      headers: {
        'User-Agent': 'StudyHubMiniProgram/1.0'
      }
    }

    const req = https.request(options, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, data: body })
      })
    })

    req.on('error', reject)
    req.end()
  })
}

/**
 * 构建 DeepSeek Prompt
 */
function buildPrompt(word) {
  return `你是一位专业的英语教学专家。请为英语单词/短语"${word}"生成结构化的学习内容。

请严格按以下JSON格式返回，不要添加任何额外说明：

{
  "phonetic": "IPA音标，例如 /juːˈbɪkwɪtəs/；短语或无法确定时填空字符串",
  "stressHint": "重音提示，例如 mini-PRO-gram；无法确定时填空字符串",
  "shortDefinition": "简洁英文释义（不超过15词）",
  "chineseHint": "中文提示（10字以内）",
  "examples": ["自然例句1（包含目标单词）", "自然例句2（包含目标单词）"],
  "collocations": ["常见搭配1", "常见搭配2"],
  "rootAffix": "词根词缀分析，如无则填'无'",
  "synonyms": ["近义词1", "近义词2"],
  "antonyms": ["反义词1（如无则留空数组）"],
  "memoryTip": "一条有趣的记忆提示或联想方法",
  "difficulty": 3
}`
}

function buildPhoneticPrompt(word) {
  return `请为英语单词/短语"${word}"返回 IPA 音标和重音提示。

请严格按以下JSON格式返回，不要添加任何额外说明：

{
  "phonetic": "IPA音标，例如 /bæk/；短语或无法确定时填空字符串",
  "stressHint": "重音提示，例如 mini-PRO-gram；无法确定时填空字符串"
}`
}

function normalizePhonetic(value) {
  if (!value) return ''
  if (Array.isArray(value)) {
    return value.map(normalizePhonetic).filter(Boolean).join(' ')
  }
  if (typeof value === 'object') {
    return [value.uk, value.us, value.gb, value.en, value.ipa, value.text, value.phonetic, value.pronunciation]
      .map(normalizePhonetic)
      .filter(Boolean)
      .join(' ')
  }

  const text = String(value).trim()
  if (!text) return ''
  if (text.includes('/') || text.includes('[') || text.includes(']')) return text
  return `/${text.replace(/^[/\[]|[/\]]$/g, '')}/`
}

async function lookupDictionaryPhonetic(word) {
  const text = String(word || '').trim().toLowerCase()
  if (!/^[a-z][a-z-]*$/.test(text)) return ''

  try {
    const response = await httpsGet(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text)}`)
    if (response.statusCode !== 200) return ''

    const entries = JSON.parse(response.data)
    if (!Array.isArray(entries) || !entries.length) return ''

    const entry = entries[0] || {}
    const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : []
    const candidates = [
      entry.phonetic,
      ...phonetics.map(item => item && item.text)
    ]

    return normalizePhonetic(candidates.find(Boolean))
  } catch (err) {
    console.warn('dictionary phonetic lookup failed:', err && err.message)
    return ''
  }
}

async function resolvePhonetic(parsed, word) {
  return normalizePhonetic(parsed.phonetic || parsed.phonetics || parsed.ipa || parsed.pronunciation) ||
    lookupDictionaryPhonetic(word)
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
  const inputTokens = messages.reduce((sum, message) => {
    return sum + estimateTextTokens(message.content) + 6
  }, 0)
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

exports.main = async (event, context) => {
  const { word, mode } = event
  const phoneticOnly = mode === 'phonetic'

  if (!word || !word.trim()) {
    return { success: false, error: '单词不能为空' }
  }

  if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === '在此填入你的DeepSeek API Key') {
    return { success: false, error: 'DEEPSEEK_API_KEY 未配置' }
  }

  try {
    const trimmedWord = word.trim()
    const prompt = phoneticOnly ? buildPhoneticPrompt(trimmedWord) : buildPrompt(trimmedWord)
    const maxTokens = phoneticOnly ? 300 : 2000
    const messages = [
      { role: 'system', content: '你是一个专业的英语教学助手。请始终以严格的JSON格式返回结果。' },
      { role: 'user', content: prompt }
    ]
    const requestId = event.requestId || createRequestId(phoneticOnly ? 'phonetic' : 'word_content')
    const estimatedMeters = estimateMessageTokens(messages, maxTokens)

    const billingPrecheck = await ensureBillingAllowed({
      requestId,
      modelKey: MODEL_KEY,
      operation: MODEL_OPERATION,
      meters: estimatedMeters,
      usageSource: 'estimated',
      metadata: {
        feature: phoneticOnly ? 'phonetic' : 'word_content',
        word: trimmedWord
      }
    })
    const providerModel = billingPrecheck.model && billingPrecheck.model.providerModel
    if (!providerModel) throw new Error('模型目录未返回 providerModel')

    const requestBody = JSON.stringify({
      model: providerModel,
      messages,
      temperature: 0.7,
      max_tokens: maxTokens
    })

    const response = await httpsPost(
      'https://api.deepseek.com/v1/chat/completions',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      requestBody
    )

    if (response.statusCode !== 200) {
      return { success: false, error: `DeepSeek API 返回错误: ${response.statusCode} - ${response.data}` }
    }

    const data = JSON.parse(response.data)
    const feature = phoneticOnly ? 'phonetic' : 'word_content'
    const billing = await callBilling('settle', {
      requestId,
      modelKey: MODEL_KEY,
      operation: MODEL_OPERATION,
      providerUsage: data.usage || null,
      meters: extractUsageMeters(data.usage, estimatedMeters),
      usageSource: data.usage ? 'provider' : 'estimated',
      metadata: {
        feature,
        word: trimmedWord
      }
    })
    const content = data.choices && data.choices[0] && data.choices[0].message.content

    if (!content) {
      return { success: false, error: 'DeepSeek 返回内容为空' }
    }

    // 尝试解析 JSON（处理可能的 markdown 代码块包裹）
    let parsed
    try {
      parsed = JSON.parse(content)
    } catch {
      // 尝试提取 ```json...``` 中的内容
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1])
      } else {
        return { success: false, error: 'DeepSeek 返回格式异常' }
      }
    }

    if (phoneticOnly) {
      return {
        success: true,
        content: {
          phonetic: await resolvePhonetic(parsed, trimmedWord),
          stressHint: parsed.stressHint || parsed.stress || ''
        },
        billing
      }
    }

    // 确保字段完整性
    const result = {
      phonetic: await resolvePhonetic(parsed, trimmedWord),
      stressHint: parsed.stressHint || parsed.stress || '',
      shortDefinition: parsed.shortDefinition || '',
      chineseHint: parsed.chineseHint || '',
      examples: Array.isArray(parsed.examples) ? parsed.examples : [],
      clozeExample: '',
      collocations: Array.isArray(parsed.collocations) ? parsed.collocations : [],
      rootAffix: parsed.rootAffix || '无',
      synonyms: Array.isArray(parsed.synonyms) ? parsed.synonyms : [],
      antonyms: Array.isArray(parsed.antonyms) ? parsed.antonyms : [],
      memoryTip: parsed.memoryTip || '',
      difficulty: Math.min(5, Math.max(1, parseInt(parsed.difficulty) || 3))
    }

    return { success: true, content: result, billing }
  } catch (err) {
    console.error('generateContent error:', err)
    return { success: false, error: err.message || '内容生成失败' }
  }
}
