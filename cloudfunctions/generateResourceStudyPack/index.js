const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '在此填入你的DeepSeek API Key'
const MODEL_KEY = 'deepseek-chat-text'
const MODEL_OPERATION = 'text_generation'

function httpsPost(url, headers, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname,
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
    req.write(data)
    req.end()
  })
}

function buildPrompt(title, segments) {
  const text = segments
    .map((segment, index) => `#${index + 1} ${segment}`)
    .join('\n\n')
    .slice(0, 9000)

  return `你是一位英语精读老师。请基于文档"${title || 'Untitled'}"生成轻量精读任务。

请严格按以下JSON格式返回，不要添加任何额外说明：

{
  "keyWords": [
    { "word": "keyword", "chineseHint": "中文提示", "reason": "为什么值得学" }
  ],
  "hardSentences": [
    { "sentence": "英文难句", "explanation": "中文拆解说明" }
  ],
  "dictationSentences": [
    { "sentence": "适合听写的英文句子", "hint": "中文提示" }
  ],
  "segmentSummaries": [
    { "index": 1, "summary": "该段中文大意" }
  ]
}

要求：
- keyWords 5到10个，优先选择真实语境中高价值词/短语。
- hardSentences 1到3句。
- dictationSentences 3句，句子不要太长。
- segmentSummaries 覆盖输入段落，每段一句中文大意。

文档内容：
${text}`
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : []
}

function pickValue(source, names, fallback) {
  if (typeof source === 'string') {
    const stringFields = ['word', 'keyword', 'term', 'phrase', 'text', 'sentence', 'original', 'summary', 'mainIdea', 'gist']
    return names.some(name => stringFields.indexOf(name) !== -1) ? source : fallback
  }
  const data = source && typeof source === 'object' ? source : {}
  for (const name of names) {
    if (data[name] !== undefined && data[name] !== null) return data[name]
  }
  return fallback
}

function pickArray(source, names) {
  return normalizeArray(pickValue(source, names, []))
}

function hasStudyPackContent(studyPack) {
  return !!(
    studyPack.keyWords.length ||
    studyPack.hardSentences.length ||
    studyPack.dictationSentences.length ||
    studyPack.segmentSummaries.length
  )
}

function normalizeStudyPack(parsed) {
  const source = pickValue(parsed, ['studyPack', 'data', 'result'], parsed)
  const pack = {
    keyWords: pickArray(source, ['keyWords', 'keywords', 'key_words', 'vocabulary', 'words']).slice(0, 10).map(item => ({
      word: pickValue(item, ['word', 'keyword', 'term', 'phrase', 'text'], ''),
      chineseHint: pickValue(item, ['chineseHint', 'hint', 'chinese', 'meaning', 'translation'], ''),
      reason: pickValue(item, ['reason', 'note', 'explanation'], '')
    })).filter(item => item.word),
    hardSentences: pickArray(source, ['hardSentences', 'difficultSentences', 'hard_sentences', 'sentenceAnalysis']).slice(0, 3).map(item => ({
      sentence: pickValue(item, ['sentence', 'text', 'original'], ''),
      explanation: pickValue(item, ['explanation', 'analysis', 'note', 'translation'], '')
    })).filter(item => item.sentence),
    dictationSentences: pickArray(source, ['dictationSentences', 'dictation', 'dictation_sentences', 'listeningSentences']).slice(0, 3).map(item => ({
      sentence: pickValue(item, ['sentence', 'text', 'original'], ''),
      hint: pickValue(item, ['hint', 'chineseHint', 'translation', 'note'], '')
    })).filter(item => item.sentence),
    segmentSummaries: pickArray(source, ['segmentSummaries', 'summaries', 'segment_summaries', 'paragraphSummaries']).map((item, index) => ({
      index: Number(pickValue(item, ['index', 'segmentIndex', 'paragraphIndex', 'id'], 0)) || index + 1,
      summary: pickValue(item, ['summary', 'text', 'mainIdea', 'gist'], '')
    })).filter(item => item.index && item.summary),
    generatedAt: Date.now()
  }
  return {
    ...pack,
    hasContent: hasStudyPackContent(pack)
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

exports.main = async (event = {}) => {
  const title = event.title || ''
  const segments = normalizeArray(event.segments)
    .map(segment => typeof segment === 'string' ? segment : segment.text)
    .filter(Boolean)
    .slice(0, 12)

  if (!segments.length) return { success: false, error: '没有可分析的段落' }
  if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === '在此填入你的DeepSeek API Key') {
    return { success: false, error: 'DEEPSEEK_API_KEY 未配置' }
  }

  try {
    const maxTokens = 2200
    const prompt = buildPrompt(title, segments)
    const messages = [
      { role: 'system', content: '你是专业英语精读老师，只返回严格JSON。' },
      { role: 'user', content: prompt }
    ]
    const requestId = event.requestId || createRequestId('resource_study_pack')
    const estimatedMeters = estimateMessageTokens(messages, maxTokens)

    const billingPrecheck = await ensureBillingAllowed({
      requestId,
      modelKey: MODEL_KEY,
      operation: MODEL_OPERATION,
      meters: estimatedMeters,
      usageSource: 'estimated',
      metadata: {
        feature: 'resource_study_pack',
        title,
        segmentCount: segments.length
      }
    })
    const providerModel = billingPrecheck.model && billingPrecheck.model.providerModel
    if (!providerModel) throw new Error('模型目录未返回 providerModel')

    const requestBody = JSON.stringify({
      model: providerModel,
      messages,
      temperature: 0.5,
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
      return { success: false, error: `DeepSeek API 返回错误: ${response.statusCode}` }
    }

    const data = JSON.parse(response.data)
    const content = data.choices && data.choices[0] && data.choices[0].message.content
    const billing = await callBilling('settle', {
      requestId,
      modelKey: MODEL_KEY,
      operation: MODEL_OPERATION,
      providerUsage: data.usage || null,
      meters: extractUsageMeters(data.usage, estimatedMeters),
      usageSource: data.usage ? 'provider' : 'estimated',
      metadata: {
        feature: 'resource_study_pack',
        title,
        segmentCount: segments.length
      }
    })

    let parsed
    try {
      parsed = JSON.parse(content)
    } catch {
      const jsonMatch = String(content || '').match(/```(?:json)?\s*([\s\S]*?)```/)
      if (!jsonMatch) return { success: false, error: 'DeepSeek 返回格式异常' }
      parsed = JSON.parse(jsonMatch[1])
    }

    const studyPack = normalizeStudyPack(parsed)
    if (!studyPack.hasContent) {
      return { success: false, error: 'DeepSeek 返回精读内容为空', billing }
    }

    return { success: true, studyPack, billing }
  } catch (err) {
    console.error('generateResourceStudyPack error:', err)
    return { success: false, error: err.message || '精读任务生成失败' }
  }
}
