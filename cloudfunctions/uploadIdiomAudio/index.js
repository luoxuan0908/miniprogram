/**
 * uploadIdiomAudio - 下载习语音频并上传到云存储，同时更新课程条目
 *
 * 输入:
 *   { index: number, updateDb?: boolean }
 *   - index: 习语编号（1-1355），每次只处理1条
 *   - updateDb: 是否同时更新数据库（默认 true）
 *   { action: 'uploadBatch', start: number, end: number }
 *   - 分批处理习语编号，建议一次 5-10 条
 *   { action: 'audioStatus' }
 *   - 统计 course_items 中音频字段的云存储写入进度
 */

const cloud = require('wx-server-sdk')
const https = require('https')
const http = require('http')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/luoxuan0908/most-common-american-idioms@main/audio/'
const CLOUD_PATH_PREFIX = 'idioms-audio/'
const DB = cloud.database()
const TOTAL_IDIOMS = 1355
const MAX_BATCH_SIZE = 10

function toIdiomId(index) {
  return `idiom-${String(index).padStart(4, '0')}`
}

function toAudioKey(index, subIndex) {
  return `${String(index).padStart(3, '0')}.${subIndex}`
}

function isCloudFileID(value) {
  return typeof value === 'string' && value.startsWith('cloud://')
}

function normalizeAudioPath(index, subIndex, currentAudio) {
  const value = String(currentAudio || '').trim()
  if (value && !isCloudFileID(value)) {
    return value.replace(/^\/+/, '')
  }
  return `audio/${toAudioKey(index, subIndex)}.mp3`
}

function fileNameFromAudioPath(audioPath, index, subIndex) {
  const fallback = `${toAudioKey(index, subIndex)}.mp3`
  const normalized = String(audioPath || fallback).split('?')[0]
  return normalized.split('/').pop() || fallback
}

function downloadToBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const req = client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadToBuffer(res.headers.location).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        res.resume()
        return
      }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(15000, () => {
      req.destroy()
      reject(new Error(`Download timeout: ${url}`))
    })
  })
}

async function uploadToCloud(buffer, cloudPath) {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')

  const tmpPath = path.join(os.tmpdir(), `idiom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`)
  fs.writeFileSync(tmpPath, buffer)

  try {
    const result = await cloud.uploadFile({ cloudPath, filePath: tmpPath })
    return result.fileID
  } finally {
    try { fs.unlinkSync(tmpPath) } catch (e) { /* ignore */ }
  }
}

async function updateItemAudio(index, audioMap) {
  const itemId = toIdiomId(index)

  try {
    const { data } = await DB.collection('course_items')
      .where({ id: itemId })
      .limit(1)
      .get()

    if (!data || data.length === 0) {
      console.warn(`条目 ${itemId} 未找到`)
      return false
    }

    const doc = data[0]
    const examples = doc.examples || []

    for (let i = 0; i < examples.length; i++) {
      const subIndex = i + 1
      const key = `${String(index).padStart(3, '0')}.${subIndex}`
      if (audioMap[key]) {
        examples[i].audio = audioMap[key]
      }
    }

    await DB.collection('course_items').doc(doc._id).update({
      data: { examples }
    })

    return true
  } catch (err) {
    console.error(`更新条目 ${itemId} 失败:`, err.message)
    return false
  }
}

exports.main = async (event) => {
  if (event && event.action === 'audioStatus') {
    return getAudioStatus()
  }

  if (event && event.action === 'uploadBatch') {
    return uploadBatch(event)
  }

  const index = event.index || 1
  const updateDb = event.updateDb !== false
  return uploadOneIdiom(index, { updateDb, force: event.force === true })
}

async function getItemDoc(index) {
  const itemId = toIdiomId(index)
  const { data } = await DB.collection('course_items')
    .where({ id: itemId })
    .limit(1)
    .get()

  return data && data.length > 0 ? data[0] : null
}

async function uploadOneIdiom(index, options = {}) {
  const updateDb = options.updateDb !== false
  const force = options.force === true
  const doc = await getItemDoc(index)
  if (!doc) {
    return {
      success: false,
      index,
      itemId: toIdiomId(index),
      error: 'course item not found'
    }
  }

  const examples = doc.examples || []
  const results = []
  const audioMap = {}

  for (let i = 0; i < examples.length; i++) {
    const sub = i + 1
    const currentAudio = examples[i].audio || ''
    if (!force && isCloudFileID(currentAudio)) {
      results.push({ index, subIndex: sub, fileID: currentAudio, skipped: true })
      audioMap[toAudioKey(index, sub)] = currentAudio
      continue
    }

    const audioPath = normalizeAudioPath(index, sub, currentAudio)
    const fileName = fileNameFromAudioPath(audioPath, index, sub)
    const cdnUrl = CDN_BASE + fileName
    const cloudPath = CLOUD_PATH_PREFIX + fileName

    try {
      const buffer = await downloadToBuffer(cdnUrl)
      const fileID = await uploadToCloud(buffer, cloudPath)

      results.push({ index, subIndex: sub, fileID })
      audioMap[toAudioKey(index, sub)] = fileID
    } catch (err) {
      console.error(`上传失败: ${fileName}`, err.message)
      results.push({ index, subIndex: sub, fileID: '', source: cdnUrl, error: err.message })
    }
  }

  // 更新数据库
  let dbUpdated = 0
  if (updateDb) {
    const hasFiles = Object.values(audioMap).some(v => v)
    if (hasFiles) {
      const ok = await updateItemAudio(index, audioMap)
      if (ok) dbUpdated = 1
    }
  }

  const successCount = results.filter(r => r.fileID).length
  const failCount = results.filter(r => !r.fileID).length
  const skippedCount = results.filter(r => r.skipped).length

  return {
    success: failCount === 0,
    index,
    total: results.length,
    successCount,
    failCount,
    skippedCount,
    dbUpdated,
    results
  }
}

async function uploadBatch(event) {
  const batchSize = Math.max(1, Math.min(Number(event.batchSize || MAX_BATCH_SIZE), MAX_BATCH_SIZE))
  const batchNumber = Number(event.batch || 0)
  const start = batchNumber > 0
    ? ((batchNumber - 1) * batchSize) + 1
    : Math.max(1, Number(event.start || event.index || 1))
  const requestedEnd = batchNumber > 0
    ? start + batchSize - 1
    : Number(event.end || start)
  const end = Math.min(TOTAL_IDIOMS, requestedEnd)
  const count = end - start + 1

  if (count <= 0) {
    return { success: false, error: 'start/end 参数不正确' }
  }
  if (count > MAX_BATCH_SIZE) {
    return {
      success: false,
      error: `单次最多处理 ${MAX_BATCH_SIZE} 条，请缩小 start/end 范围`,
      start,
      end,
      maxBatchSize: MAX_BATCH_SIZE
    }
  }

  const results = []
  for (let index = start; index <= end; index++) {
    results.push(await uploadOneIdiom(index, {
      updateDb: event.updateDb !== false,
      force: event.force === true
    }))
  }

  const summary = results.reduce((acc, item) => {
    acc.totalItems++
    acc.totalAudio += item.total || 0
    acc.successAudio += item.successCount || 0
    acc.failedAudio += item.failCount || 0
    acc.skippedAudio += item.skippedCount || 0
    acc.dbUpdated += item.dbUpdated || 0
    if (!item.success) acc.failedIndices.push(item.index)
    return acc
  }, {
    totalItems: 0,
    totalAudio: 0,
    successAudio: 0,
    failedAudio: 0,
    skippedAudio: 0,
    dbUpdated: 0,
    failedIndices: []
  })

  return {
    success: summary.failedIndices.length === 0,
    action: 'uploadBatch',
    start,
    end,
    batch: batchNumber || undefined,
    batchSize,
    summary,
    results
  }
}

async function getAudioStatus() {
  const limit = 100
  let skip = 0
  let totalItems = 0
  let totalExamples = 0
  let cloudAudio = 0
  const pendingIndices = []

  while (true) {
    const { data } = await DB.collection('course_items')
      .where({ courseId: 'idioms-1355' })
      .orderBy('index', 'asc')
      .skip(skip)
      .limit(limit)
      .get()

    if (!data || data.length === 0) break

    for (const item of data) {
      totalItems++
      const examples = item.examples || []
      const exampleCount = examples.length
      const itemCloudAudio = examples.filter(example => isCloudFileID(example.audio)).length
      totalExamples += exampleCount
      cloudAudio += itemCloudAudio
      if (itemCloudAudio < exampleCount && pendingIndices.length < 50) {
        pendingIndices.push(item.index)
      }
    }

    if (data.length < limit) break
    skip += data.length
  }

  return {
    success: true,
    action: 'audioStatus',
    totalItems,
    totalExamples,
    cloudAudio,
    pendingAudio: totalExamples - cloudAudio,
    progressPercent: totalExamples > 0 ? Math.round((cloudAudio / totalExamples) * 10000) / 100 : 100,
    pendingIndices
  }
}
