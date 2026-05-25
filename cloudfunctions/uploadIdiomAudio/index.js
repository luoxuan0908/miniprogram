/**
 * uploadIdiomAudio - 下载习语音频并上传到云存储，同时更新课程条目
 *
 * 输入:
 *   { index: number, updateDb?: boolean }
 *   - index: 习语编号（1-1355），每次只处理1条
 *   - updateDb: 是否同时更新数据库（默认 true）
 */

const cloud = require('wx-server-sdk')
const https = require('https')
const http = require('http')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/luoxuan0908/most-common-american-idioms@main/audio/'
const CLOUD_PATH_PREFIX = 'idioms-audio/'
const DB = cloud.database()

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
  const itemId = `idiom-${String(index).padStart(4, '0')}`

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
  const index = event.index || 1
  const updateDb = event.updateDb !== false

  const numStr = String(index).padStart(3, '0')
  const results = []
  const audioMap = {}

  for (let sub = 1; sub <= 3; sub++) {
    const fileName = `${numStr}.${sub}.mp3`
    const cdnUrl = CDN_BASE + fileName
    const cloudPath = CLOUD_PATH_PREFIX + fileName

    try {
      const buffer = await downloadToBuffer(cdnUrl)
      const fileID = await uploadToCloud(buffer, cloudPath)

      results.push({ index, subIndex: sub, fileID })
      audioMap[`${numStr}.${sub}`] = fileID
    } catch (err) {
      console.error(`上传失败: ${fileName}`, err.message)
      results.push({ index, subIndex: sub, fileID: '', error: err.message })
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

  return {
    success: true,
    index,
    total: results.length,
    successCount,
    failCount,
    dbUpdated,
    results
  }
}
