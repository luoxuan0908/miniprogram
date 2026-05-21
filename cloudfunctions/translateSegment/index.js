const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '在此填入你的DeepSeek API Key'

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
exports.main = async (event) => {
  const { text, texts } = event

  // 批量模式
  if (texts && Array.isArray(texts) && texts.length > 0) {
    const batch = texts.slice(0, 12) // 最多 12 段
    const translations = await translateBatch(batch)
    return {
      success: true,
      translations
    }
  }

  // 单段模式
  if (!text || !text.trim()) {
    return { success: false, error: '翻译文本不能为空' }
  }

  const translations = await translateBatch([text.trim()])
  return {
    success: true,
    translation: translations[0] || ''
  }
}

async function translateBatch(texts) {
  if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === '在此填入你的DeepSeek API Key') {
    return texts.map(() => '')
  }

  const prompt = `Translate these English learning paragraphs into concise, natural Simplified Chinese. Return only a JSON array of strings with the same order and length.\n\n${JSON.stringify(texts)}`
  const body = JSON.stringify({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'You return strict JSON only.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2,
    max_tokens: 3000
  })

  try {
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
      return texts.map(() => '')
    }

    const data = JSON.parse(response.data)
    const content = data.choices && data.choices[0] && data.choices[0].message.content
    if (!content) return texts.map(() => '')

    let parsed
    try {
      parsed = JSON.parse(content)
    } catch (e) {
      const match = content.match(/```(?:json)?\s*([\s\S]*?)```/)
      parsed = match ? JSON.parse(match[1]) : []
    }

    return texts.map((_, index) => Array.isArray(parsed) ? (parsed[index] || '') : '')
  } catch (e) {
    console.error('translateBatch failed:', e)
    return texts.map(() => '')
  }
}
