const userStorage = require('./user-storage')

const DEFAULT_TTS_SPEED = 100
const MIN_TTS_SPEED = 50
const MAX_TTS_SPEED = 200
const DEFAULT_TTS_VOICE = 'Cherry'

const TTS_VOICE_OPTIONS = [
  { value: 'Cherry', name: '芊悦', desc: '阳光亲切 · 女声' },
  { value: 'Serena', name: '苏瑶', desc: '温柔自然 · 女声' },
  { value: 'Ethan', name: '晨煦', desc: '温暖活力 · 男声' },
  { value: 'Moon', name: '月白', desc: '率性清亮 · 男声' },
  { value: 'Chelsie', name: '千雪', desc: '轻快甜亮 · 女声' }
]

function normalizeTtsSpeed(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_TTS_SPEED
  return Math.max(MIN_TTS_SPEED, Math.min(MAX_TTS_SPEED, Math.round(numeric)))
}

function formatTtsSpeed(value) {
  return `${(normalizeTtsSpeed(value) / 100).toFixed(1)}x`
}

function normalizeTtsVoice(value) {
  const voice = String(value || '').trim()
  return TTS_VOICE_OPTIONS.some(option => option.value === voice)
    ? voice
    : DEFAULT_TTS_VOICE
}

function getVoiceOption(value) {
  const voice = normalizeTtsVoice(value)
  return TTS_VOICE_OPTIONS.find(option => option.value === voice) || TTS_VOICE_OPTIONS[0]
}

function getVoiceIndex(value) {
  const voice = normalizeTtsVoice(value)
  const index = TTS_VOICE_OPTIONS.findIndex(option => option.value === voice)
  return index === -1 ? 0 : index
}

function getTtsPreferences() {
  const prefs = userStorage.getPreferences()
  const ttsSpeed = normalizeTtsSpeed(prefs.ttsSpeed)
  const ttsVoice = normalizeTtsVoice(prefs.ttsVoice)
  const voiceOption = getVoiceOption(ttsVoice)

  return {
    ttsSpeed,
    ttsSpeedLabel: formatTtsSpeed(ttsSpeed),
    ttsVoice,
    ttsVoiceIndex: getVoiceIndex(ttsVoice),
    ttsVoiceLabel: voiceOption.name,
    ttsVoiceDesc: voiceOption.desc
  }
}

function saveTtsPreferences(updates) {
  const normalized = {}

  if (updates && Object.prototype.hasOwnProperty.call(updates, 'ttsSpeed')) {
    normalized.ttsSpeed = normalizeTtsSpeed(updates.ttsSpeed)
  }

  if (updates && Object.prototype.hasOwnProperty.call(updates, 'ttsVoice')) {
    normalized.ttsVoice = normalizeTtsVoice(updates.ttsVoice)
  }

  if (Object.keys(normalized).length) {
    userStorage.savePreferences(normalized)
  }
}

module.exports = {
  DEFAULT_TTS_SPEED,
  MIN_TTS_SPEED,
  MAX_TTS_SPEED,
  DEFAULT_TTS_VOICE,
  TTS_VOICE_OPTIONS,
  normalizeTtsSpeed,
  formatTtsSpeed,
  normalizeTtsVoice,
  getVoiceOption,
  getVoiceIndex,
  getTtsPreferences,
  saveTtsPreferences
}
