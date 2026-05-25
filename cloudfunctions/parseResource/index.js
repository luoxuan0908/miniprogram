const cloud = require('wx-server-sdk')
const http = require('http')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const MAX_TEXT_LENGTH = 20000
const MAX_SEGMENTS = 80
const MAX_IMAGES = 40
const IMAGE_MARKER_RE = /__RESOURCE_IMAGE_(\d+)__/g

function requestText(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 4) {
      reject(new Error('URL 重定向次数过多'))
      return
    }

    let urlObj
    try {
      urlObj = new URL(url)
    } catch (e) {
      reject(new Error('URL 格式不正确'))
      return
    }

    const client = urlObj.protocol === 'http:' ? http : https
    const req = client.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 MiniProgram Resource Parser',
        'Accept-Encoding': 'identity'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy()
        const nextUrl = new URL(res.headers.location, urlObj).toString()
        requestText(nextUrl, redirectCount + 1).then(resolve).catch(reject)
        return
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`URL 请求失败: ${res.statusCode}`))
        return
      }

      const chunks = []
      let size = 0
      res.on('data', chunk => {
        size += chunk.length
        if (size <= 1024 * 1024) chunks.push(chunk)
      })
      res.on('end', () => {
        resolve({
          text: Buffer.concat(chunks).toString('utf8'),
          contentType: res.headers['content-type'] || ''
        })
      })
    })

    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('URL 请求超时')))
    req.end()
  })
}

function decodeEntities(text) {
  const entities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
  }

  return text
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
      if (entity[0] === '#') {
        const isHex = entity[1] && entity[1].toLowerCase() === 'x'
        const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10)
        return Number.isFinite(code) ? String.fromCharCode(code) : match
      }
      return entities[entity] || match
    })
}

function extractTitle(raw, fallback) {
  const h1 = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  if (h1) return cleanInline(h1[1]).slice(0, 80)

  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (title) return cleanInline(title[1]).slice(0, 80)

  return fallback || '未命名文档'
}

function cleanInline(text) {
  return decodeEntities(String(text || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function getAttr(attrs, name) {
  const pattern = new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))", 'i')
  const match = String(attrs || '').match(pattern)
  return match ? decodeEntities(match[1] || match[2] || match[3] || '') : ''
}

function firstSrcsetUrl(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim().split(/\s+/)[0])
    .find(Boolean) || ''
}

function resolveImageUrl(value, baseUrl) {
  const raw = decodeEntities(String(value || '').trim())
  if (!raw || /^(data|blob|javascript):/i.test(raw)) return ''

  try {
    const resolved = baseUrl
      ? new URL(raw, baseUrl).toString()
      : (raw.indexOf('//') === 0 ? `https:${raw}` : raw)
    return /^https?:\/\//i.test(resolved) ? resolved : ''
  } catch (e) {
    return /^https?:\/\//i.test(raw) ? raw : ''
  }
}

function extractImageFromAttrs(attrs, baseUrl) {
  const directAttrs = ['data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-image', 'data-img-url', 'data-actualsrc', 'src']
  const srcsetAttrs = ['data-srcset', 'srcset']
  const candidates = directAttrs
    .map(name => getAttr(attrs, name))
    .concat(srcsetAttrs.map(name => firstSrcsetUrl(getAttr(attrs, name))))

  const src = candidates
    .map(value => resolveImageUrl(value, baseUrl))
    .find(Boolean)

  if (!src) return null

  return {
    src,
    alt: cleanInline(getAttr(attrs, 'alt') || getAttr(attrs, 'title')).slice(0, 120)
  }
}

function injectImageMarkers(raw, baseUrl) {
  const images = []
  const seen = new Set()
  const html = String(raw || '').replace(/<img\b([^>]*)>/gi, (match, attrs) => {
    if (images.length >= MAX_IMAGES) return '\n'

    const image = extractImageFromAttrs(attrs, baseUrl)
    if (!image || seen.has(image.src)) return '\n'

    seen.add(image.src)
    images.push({
      ...image,
      index: images.length + 1
    })
    return `\n\n__RESOURCE_IMAGE_${images.length - 1}__\n\n`
  })

  return { html, images }
}

function stripHtml(raw) {
  return decodeEntities(String(raw || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '\n')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|main|li|h[1-6]|blockquote|br|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim())
}

function splitSentences(text) {
  const normalized = text
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  let blocks = normalized
    .split(/\n{2,}/)
    .map(s => s.replace(/\n+/g, ' ').trim())
    .filter(s => s.length >= 12)

  if (blocks.length < 3) {
    blocks = (normalized.replace(/\n+/g, ' ').match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [])
      .map(s => s.trim())
      .filter(s => s.length >= 12)
  }

  const segments = []
  let current = ''
  blocks.forEach(block => {
    if (!current) {
      current = block
    } else if ((current + ' ' + block).length <= 420) {
      current += ' ' + block
    } else {
      segments.push(current)
      current = block
    }
  })
  if (current) segments.push(current)

  return segments
    .map(text => text.slice(0, 700).trim())
    .filter(Boolean)
    .slice(0, MAX_SEGMENTS)
}

function createSegment(text, index, imagesBefore) {
  const segment = {
    index,
    text,
    translation: '',
    audioFileID: '',
    audioStatus: 'idle',
    audioVoice: ''
  }

  if (imagesBefore && imagesBefore.length) {
    segment.imagesBefore = imagesBefore
  }

  return segment
}

function buildTextSegments(segmentTexts) {
  return segmentTexts.map((text, index) => createSegment(text, index + 1))
}

function splitSegmentsWithImages(plainText, images) {
  const segments = []
  let pendingImages = []
  let lastIndex = 0
  let match

  IMAGE_MARKER_RE.lastIndex = 0

  function appendTextSegments(text) {
    splitSentences(text).forEach(segmentText => {
      if (segments.length >= MAX_SEGMENTS) return

      const segment = createSegment(segmentText, segments.length + 1, pendingImages)
      pendingImages = []
      segments.push(segment)
    })
  }

  while ((match = IMAGE_MARKER_RE.exec(plainText)) !== null) {
    appendTextSegments(plainText.slice(lastIndex, match.index))

    const image = images[Number(match[1])]
    if (image) pendingImages.push(image)

    lastIndex = IMAGE_MARKER_RE.lastIndex
  }

  appendTextSegments(plainText.slice(lastIndex))

  if (pendingImages.length && segments.length) {
    const lastSegment = segments[segments.length - 1]
    lastSegment.imagesAfter = (lastSegment.imagesAfter || []).concat(pendingImages)
  }

  return segments
}

function inferFileType(name, contentType) {
  const lower = String(name || '').toLowerCase()
  if (lower.endsWith('.txt') || /text\/plain/.test(contentType || '')) return 'txt'
  return 'html'
}

/**
 * parseResource - 只做抓取 + 分段，不做翻译
 * 翻译由独立的 translateSegment 云函数按需调用
 */
exports.main = async (event) => {
  const url = (event.url || '').trim()
  const fileName = event.fileName || ''
  let raw = event.text || ''
  let sourceType = event.sourceType || (url ? 'url' : 'file')
  let titleFallback = fileName || '未命名文档'
  let contentType = ''

  try {
    if (url) {
      const fetched = await requestText(url)
      raw = fetched.text
      contentType = fetched.contentType
      titleFallback = new URL(url).hostname
      sourceType = 'url'
    }

    if (!raw || !raw.trim()) {
      return { success: false, error: '资源内容为空' }
    }

    const fileType = event.fileType || inferFileType(fileName || url, contentType)
    const title = fileType === 'html' ? extractTitle(raw, titleFallback) : (fileName || titleFallback)
    const imageParse = fileType === 'html' ? injectImageMarkers(raw, url) : { html: raw, images: [] }
    const plainText = (fileType === 'html' ? stripHtml(imageParse.html) : String(raw || '')).slice(0, MAX_TEXT_LENGTH)
    const segments = fileType === 'html'
      ? splitSegmentsWithImages(plainText, imageParse.images)
      : buildTextSegments(splitSentences(plainText))

    if (segments.length === 0) {
      return { success: false, error: '没有解析到可学习的英文段落' }
    }

    return {
      success: true,
      resource: {
        type: 'document',
        title,
        sourceType,
        sourceUrl: url,
        fileName,
        fileType,
        format: fileType,
        images: imageParse.images,
        segments,
        summary: segments[0] ? segments[0].text.slice(0, 100) : ''
      }
    }
  } catch (err) {
    console.error('parseResource error:', err)
    return { success: false, error: err.message || '资源解析失败' }
  }
}
