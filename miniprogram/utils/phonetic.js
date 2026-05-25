const LOCAL_PHONETICS = {
  back: '/bæk/',
  mini: '/ˈmɪni/',
  program: '/ˈproʊɡræm/',
  programme: '/ˈprəʊɡræm/',
  miniprogram: '/ˈmɪniˌproʊɡræm/',
  'mini program': '/ˈmɪni ˈproʊɡræm/',
  'mini-program': '/ˈmɪniˌproʊɡræm/'
}

function normalizePhonetic(value) {
  if (!value) return ''
  if (Array.isArray(value)) {
    return value.map(normalizePhonetic).filter(Boolean).join(' ')
  }
  if (typeof value === 'object') {
    return [
      value.uk,
      value.us,
      value.gb,
      value.en,
      value.ipa,
      value.text,
      value.phonetic,
      value.pronunciation
    ].map(normalizePhonetic).filter(Boolean).join(' ')
  }

  const text = String(value).trim()
  if (!text) return ''
  if (text.includes('/') || text.includes('[') || text.includes(']')) return text
  return `/${text.replace(/^[/\[]|[/\]]$/g, '')}/`
}

function getContentPhonetic(content = {}) {
  return normalizePhonetic(
    content.phonetic ||
    content.phonetics ||
    content.ipa ||
    content.pronunciation
  )
}

function normalizeWordText(word) {
  return String(word || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function getLocalPhonetic(word) {
  const key = normalizeWordText(word)
  if (!key) return ''
  if (LOCAL_PHONETICS[key]) return LOCAL_PHONETICS[key]

  const compactKey = key.replace(/[\s-]+/g, '')
  if (LOCAL_PHONETICS[compactKey]) return LOCAL_PHONETICS[compactKey]

  return ''
}

function ensureContentPhonetic(word, content = {}) {
  const phonetic = getContentPhonetic(content) || getLocalPhonetic(word)
  return {
    ...content,
    phonetic,
    stressHint: content.stressHint || content.stress || ''
  }
}

module.exports = {
  normalizePhonetic,
  getContentPhonetic,
  getLocalPhonetic,
  ensureContentPhonetic
}
