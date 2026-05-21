/**
 * resource-storage.js - Documents/resource local persistence.
 * Keeps resource data separate from the existing vocab_words store.
 */

const STORAGE_KEY = 'learning_resources_v1'
const MAX_SEGMENTS = 80

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6)
}

function now() {
  return Date.now()
}

function getAllResources() {
  try {
    return wx.getStorageSync(STORAGE_KEY) || []
  } catch (e) {
    return []
  }
}

function saveAllResources(resources) {
  try {
    wx.setStorageSync(STORAGE_KEY, resources)
  } catch (e) {
    console.error('保存资源失败', e)
  }
}

function normalizeSegment(segment, index) {
  const text = typeof segment === 'string' ? segment : (segment.text || '')
  return {
    index: index + 1,
    text: text.trim(),
    translation: segment.translation || '',
    audioFileID: segment.audioFileID || '',
    audioStatus: segment.audioStatus || 'idle',
    duration: segment.duration || 0,
    lastPlayedAt: segment.lastPlayedAt || 0
  }
}

function buildSummary(segments) {
  const first = segments.find(s => s.text)
  if (!first) return ''
  return first.text.length > 90 ? first.text.slice(0, 90) + '...' : first.text
}

function addResource(resourceData) {
  const resources = getAllResources()
  const createdAt = now()
  const segments = (resourceData.segments || [])
    .slice(0, MAX_SEGMENTS)
    .map(normalizeSegment)
    .filter(s => s.text)

  const resource = {
    id: generateId(),
    type: 'document',
    title: resourceData.title || 'Untitled Resource',
    sourceType: resourceData.sourceType || 'url',
    sourceUrl: resourceData.sourceUrl || '',
    fileName: resourceData.fileName || '',
    fileType: resourceData.fileType || '',
    format: resourceData.format || 'html',
    segments,
    summary: resourceData.summary || buildSummary(segments),
    createdAt,
    updatedAt: createdAt,
    lastOpenedAt: 0
  }

  resources.unshift(resource)
  saveAllResources(resources)
  return resource
}

function updateResource(id, updates) {
  const resources = getAllResources()
  const index = resources.findIndex(r => r.id === id)
  if (index === -1) return null

  resources[index] = {
    ...resources[index],
    ...updates,
    id: resources[index].id,
    createdAt: resources[index].createdAt,
    updatedAt: now()
  }
  saveAllResources(resources)
  return resources[index]
}

function deleteResource(id) {
  saveAllResources(getAllResources().filter(r => r.id !== id))
}

function getResourceById(id) {
  return getAllResources().find(r => r.id === id) || null
}

function markOpened(id) {
  return updateResource(id, { lastOpenedAt: now() })
}

function searchResources(query) {
  const resources = getAllResources()
  if (!query || !query.trim()) return resources

  const q = query.trim().toLowerCase()
  return resources.filter(resource => {
    return (resource.title || '').toLowerCase().includes(q) ||
      (resource.summary || '').toLowerCase().includes(q) ||
      (resource.sourceUrl || '').toLowerCase().includes(q)
  })
}

function getRecentResources(limit = 4) {
  return getAllResources()
    .slice()
    .sort((a, b) => (b.lastOpenedAt || b.createdAt) - (a.lastOpenedAt || a.createdAt))
    .slice(0, limit)
}

function updateSegment(resourceId, segmentIndex, updates) {
  const resource = getResourceById(resourceId)
  if (!resource) return null

  const segments = (resource.segments || []).map(segment => {
    if (segment.index !== segmentIndex) return segment
    return {
      ...segment,
      ...updates
    }
  })

  return updateResource(resourceId, { segments })
}

function getStats() {
  const resources = getAllResources()
  const segments = resources.reduce((sum, r) => sum + ((r.segments || []).length), 0)
  const cachedAudio = resources.reduce((sum, r) => {
    return sum + (r.segments || []).filter(s => !!s.audioFileID).length
  }, 0)

  return {
    total: resources.length,
    documents: resources.filter(r => r.type === 'document').length,
    segments,
    cachedAudio
  }
}

function clearAllAudioReferences() {
  const resources = getAllResources().map(resource => ({
    ...resource,
    segments: (resource.segments || []).map(segment => ({
      ...segment,
      audioFileID: '',
      audioStatus: 'idle',
      duration: 0
    })),
    updatedAt: now()
  }))
  saveAllResources(resources)
}

module.exports = {
  getAllResources,
  saveAllResources,
  addResource,
  updateResource,
  deleteResource,
  getResourceById,
  markOpened,
  searchResources,
  getRecentResources,
  updateSegment,
  getStats,
  clearAllAudioReferences,
  generateId
}
