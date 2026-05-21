const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 优先读环境变量，否则用下方硬编码（部署后请替换为真实 key）
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '在此填入你的DeepSeek API Key'

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

/**
 * 构建 DeepSeek Prompt
 */
function buildPrompt(word) {
  return `你是一位专业的英语教学专家。请为英语单词/短语"${word}"生成结构化的学习内容。

请严格按以下JSON格式返回，不要添加任何额外说明：

{
  "shortDefinition": "简洁英文释义（不超过15词）",
  "chineseHint": "中文提示（10字以内）",
  "examples": ["自然例句1（包含目标单词）", "自然例句2（包含目标单词）"],
  "clozeExample": "挖空例句（用___替换目标单词的句子）",
  "collocations": ["常见搭配1", "常见搭配2"],
  "rootAffix": "词根词缀分析，如无则填'无'",
  "synonyms": ["近义词1", "近义词2"],
  "antonyms": ["反义词1（如无则留空数组）"],
  "memoryTip": "一条有趣的记忆提示或联想方法",
  "difficulty": 3
}`
}

exports.main = async (event, context) => {
  const { word } = event

  if (!word || !word.trim()) {
    return { success: false, error: '单词不能为空' }
  }

  if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === '在此填入你的DeepSeek API Key') {
    return { success: false, error: 'DEEPSEEK_API_KEY 未配置' }
  }

  try {
    const requestBody = JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是一个专业的英语教学助手。请始终以严格的JSON格式返回结果。' },
        { role: 'user', content: buildPrompt(word.trim()) }
      ],
      temperature: 0.7,
      max_tokens: 2000
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

    // 确保字段完整性
    const result = {
      shortDefinition: parsed.shortDefinition || '',
      chineseHint: parsed.chineseHint || '',
      examples: Array.isArray(parsed.examples) ? parsed.examples : [],
      clozeExample: parsed.clozeExample || '',
      collocations: Array.isArray(parsed.collocations) ? parsed.collocations : [],
      rootAffix: parsed.rootAffix || '无',
      synonyms: Array.isArray(parsed.synonyms) ? parsed.synonyms : [],
      antonyms: Array.isArray(parsed.antonyms) ? parsed.antonyms : [],
      memoryTip: parsed.memoryTip || '',
      difficulty: Math.min(5, Math.max(1, parseInt(parsed.difficulty) || 3))
    }

    return { success: true, content: result }
  } catch (err) {
    console.error('generateContent error:', err)
    return { success: false, error: err.message || '内容生成失败' }
  }
}
