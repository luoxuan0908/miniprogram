/**
 * 本地上传习语音频到微信云存储
 * 
 * 不使用云函数，直接通过微信云开发 HTTP API 上传本地文件
 * 
 * 使用前需配置:
 *   WECHAT_APPSECRET - 小程序 AppSecret
 *   WECHAT_APPID 可选，默认读取 miniprogram/utils/constants.js 中的 APP_ID
 * 
 * 用法:
 *   WECHAT_APPSECRET="..." node scripts/upload-audio-local.js --start 1 --end 10
 *   node scripts/upload-audio-local.js --check-only --audio-dir "/path/to/audio"
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { APP_ID, CLOUD_ENV_ID } = require('../miniprogram/utils/constants')

// ====== 配置 ======
const DEFAULT_AUDIO_DIR = '/Users/luoxuan/技术/Most_Common_Amrican_Idioms/audio'
const CLOUD_PATH_PREFIX = 'idioms-audio/'
const TOTAL_IDIOMS = 1355
const DB_COLLECTION = 'course_items'

// ====== 命令行参数 ======
const args = process.argv.slice(2)
let startIndex = 1
let endIndex = TOTAL_IDIOMS
let concurrency = 3
let audioDir = process.env.IDIOM_AUDIO_DIR || DEFAULT_AUDIO_DIR
let appId = process.env.WECHAT_APPID || process.env.WX_APPID || APP_ID
let appSecret = process.env.WECHAT_APPSECRET || process.env.WX_APPSECRET || ''
let checkOnly = false
let updateDb = true

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--start' && args[i + 1]) startIndex = parseInt(args[i + 1])
  if (args[i] === '--end' && args[i + 1]) endIndex = parseInt(args[i + 1])
  if (args[i] === '--concurrency' && args[i + 1]) concurrency = parseInt(args[i + 1])
  if (args[i] === '--audio-dir' && args[i + 1]) audioDir = args[i + 1]
  if (args[i] === '--appid' && args[i + 1]) appId = args[i + 1]
  if (args[i] === '--appsecret' && args[i + 1]) appSecret = args[i + 1]
  if (args[i] === '--check-only') checkOnly = true
  if (args[i] === '--no-db') updateDb = false
}

// ====== 进度记录 ======
const PROGRESS_FILE = path.join(__dirname, 'output', 'upload-progress.json')
let progress = {}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
    }
  } catch (e) { /* ignore */ }
}

function saveProgress() {
  const dir = path.dirname(PROGRESS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2))
}

// ====== HTTP 请求工具 ======
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error(`JSON parse error: ${data.substring(0, 200)}`)) }
      })
    }).on('error', reject)
  })
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const data = typeof body === 'string' ? body : JSON.stringify(body)
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    }
    const req = https.request(options, (res) => {
      let result = ''
      res.on('data', chunk => result += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(result)) }
        catch (e) { reject(new Error(`JSON parse error: ${result.substring(0, 200)}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')) })
    req.write(data)
    req.end()
  })
}

/**
 * multipart/form-data 上传文件到 COS
 */
function uploadToCOS(url, fields, filePath) {
  return new Promise((resolve, reject) => {
    const fileBuffer = fs.readFileSync(filePath)
    const boundary = '----FormBoundary' + Math.random().toString(36).substring(2)
    
    const parts = []
    for (const [key, value] of Object.entries(fields)) {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      )
    }
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\nContent-Type: audio/mpeg\r\n\r\n`
    )

    const prefix = Buffer.from(parts.join(''))
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)

    const urlObj = new URL(url)
    const isHttps = urlObj.protocol === 'https:'
    const client = isHttps ? https : http

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': prefix.length + fileBuffer.length + suffix.length
      }
    }

    const req = client.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (res.statusCode === 204 || res.statusCode === 200) {
          resolve(true)
        } else {
          reject(new Error(`COS upload failed: ${res.statusCode} ${data.substring(0, 200)}`))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('COS upload timeout')) })
    req.write(prefix)
    req.write(fileBuffer)
    req.write(suffix)
    req.end()
  })
}

// ====== 核心逻辑 ======
let accessToken = ''
let tokenExpireTime = 0

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpireTime) return accessToken

  const placeholderSecrets = new Set(['你的小程序AppSecret', '你的密钥', 'APPSECRET', ''])
  if (!appId || !appSecret || placeholderSecrets.has(appSecret)) {
    console.error('❌ 请先配置 WECHAT_APPSECRET')
    console.error('   你刚才命令里的 “你的小程序AppSecret” 是占位文字，需要替换成真实 AppSecret。')
    console.error('   示例: WECHAT_APPSECRET=\"真实AppSecret\" node scripts/upload-audio-local.js --start 1 --end 10')
    console.error('   获取地址: https://mp.weixin.qq.com/ → 开发管理 → 开发设置')
    process.exit(1)
  }

  console.log('🔑 获取 access_token...')
  const res = await httpsGet(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`
  )

  if (res.access_token) {
    accessToken = res.access_token
    tokenExpireTime = Date.now() + (res.expires_in - 300) * 1000 // 提前5分钟刷新
    console.log('✅ access_token 获取成功')
    return accessToken
  } else {
    const secretHint = res.errcode === 40125
      ? 'AppSecret 无效：请确认使用的是当前 AppID 对应的小程序 AppSecret，不是 AppID、原始 ID、AppKey，也不是占位文字。'
      : '获取 access_token 失败'
    throw new Error(`${secretHint}: ${JSON.stringify(res)}`)
  }
}

function toItemId(index) {
  return `idiom-${String(index).padStart(4, '0')}`
}

function toAudioKey(index, sub) {
  return `${String(index).padStart(3, '0')}.${sub}`
}

function isCloudFileID(value) {
  return typeof value === 'string' && value.startsWith('cloud://')
}

function normalizeAudioPath(index, sub, audioPath) {
  const value = String(audioPath || '').trim()
  if (value && !isCloudFileID(value)) return value.replace(/^\/+/, '')
  return `audio/${toAudioKey(index, sub)}.mp3`
}

function fileNameFromAudioPath(index, sub, audioPath) {
  const fallback = `${toAudioKey(index, sub)}.mp3`
  return normalizeAudioPath(index, sub, audioPath).split('?')[0].split('/').pop() || fallback
}

async function queryCourseItem(index) {
  const itemId = toItemId(index)
  const token = await getAccessToken()

  const queryRes = await httpsPost(
    `https://api.weixin.qq.com/tcb/databasequery?access_token=${token}`,
    {
      env: CLOUD_ENV_ID,
      query: `db.collection("${DB_COLLECTION}").where({id: "${itemId}"}).limit(1).get()`
    }
  )

  if (queryRes.errcode !== 0 || !queryRes.data || queryRes.data.length === 0) {
    return null
  }

  return JSON.parse(queryRes.data[0])
}

async function uploadOneFile(index, sub, audioPath) {
  const fileName = fileNameFromAudioPath(index, sub, audioPath)
  const localPath = path.join(audioDir, fileName)
  const cloudPath = CLOUD_PATH_PREFIX + fileName

  // 检查本地文件
  if (!fs.existsSync(localPath)) {
    return { index, sub, fileID: '', error: '本地文件不存在' }
  }

  // 检查是否已上传
  const progressKey = fileName
  if (progress[progressKey]) {
    return { index, sub, fileID: progress[progressKey], skipped: true }
  }

  try {
    const token = await getAccessToken()

    // 步骤1: 获取上传链接
    const uploadInfo = await httpsPost(
      `https://api.weixin.qq.com/tcb/uploadfile?access_token=${token}`,
      { env: CLOUD_ENV_ID, path: cloudPath }
    )

    if (uploadInfo.errcode !== 0) {
      throw new Error(`获取上传链接失败: ${uploadInfo.errmsg}`)
    }

    // 步骤2: 上传文件到 COS
    await uploadToCOS(uploadInfo.url, {
      key: cloudPath,
      Signature: uploadInfo.authorization,
      'x-cos-security-token': uploadInfo.token,
      'x-cos-meta-fileid': uploadInfo.cos_file_id,
      file: ''  // 占位，实际文件通过 binary 发送
    }, localPath)

    const fileID = uploadInfo.file_id

    // 记录进度
    progress[progressKey] = fileID
    return { index, sub, fileID }
  } catch (err) {
    return { index, sub, fileID: '', error: err.message }
  }
}

async function updateDatabase(doc, audioFieldUpdates) {
  const token = await getAccessToken()
  const updateDataJson = JSON.stringify(audioFieldUpdates)

  // 更新记录
  const updateRes = await httpsPost(
    `https://api.weixin.qq.com/tcb/databaseupdate?access_token=${token}`,
    {
      env: CLOUD_ENV_ID,
      query: `db.collection("${DB_COLLECTION}").doc("${doc._id}").update({data:${updateDataJson}})`
    }
  )

  if (updateRes.errcode !== 0) {
    console.error(`  ❌ DB更新返回: ${JSON.stringify(updateRes)}`)
    return false
  }

  return true
}

async function processOneIdiom(index) {
  const doc = await queryCourseItem(index)
  if (!doc) {
    console.warn(`  ⚠️  条目 ${toItemId(index)} 未找到`)
    return { results: [], dbOk: false, notFound: true }
  }

  const examples = Array.isArray(doc.examples) ? doc.examples : []
  const results = []
  const audioFieldUpdates = {}

  for (let i = 0; i < examples.length; i++) {
    const sub = i + 1
    if (isCloudFileID(examples[i].audio)) {
      results.push({ index, sub, fileID: examples[i].audio, skipped: true })
      continue
    }

    const result = await uploadOneFile(index, sub, examples[i].audio)
    results.push(result)
    if (result.fileID) {
      audioFieldUpdates[`examples.${i}.audio`] = result.fileID
    }
  }

  // 更新数据库
  let dbOk = false
  const hasUpdates = Object.keys(audioFieldUpdates).length > 0
  if (updateDb && hasUpdates) {
    try {
      dbOk = await updateDatabase(doc, audioFieldUpdates)
    } catch (err) {
      console.error(`  ❌ DB更新失败 #${index}: ${err.message}`)
    }
  } else if (!updateDb || !hasUpdates) {
    dbOk = true
  }

  return { results, dbOk }
}

function checkLocalAudioFiles() {
  const missing = []
  for (let i = 1; i <= TOTAL_IDIOMS; i++) {
    for (let sub = 1; sub <= 3; sub++) {
      const fileName = `${String(i).padStart(3, '0')}.${sub}.mp3`
      if (!fs.existsSync(path.join(audioDir, fileName))) missing.push(fileName)
    }
  }

  console.log(`本地音频检查: ${TOTAL_IDIOMS * 3 - missing.length}/${TOTAL_IDIOMS * 3} 个标准编号文件存在`)
  if (missing.length > 0) {
    console.log(`缺失 ${missing.length} 个: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' ...' : ''}`)
  }
  return missing.length === 0
}

// ====== 主流程 ======
async function main() {
  console.log('========================================')
  console.log('  习语音频本地上传工具')
  console.log('========================================')
  console.log(`范围: #${startIndex} ~ #${endIndex}`)
  console.log(`音频目录: ${audioDir}`)
  console.log(`云存储路径: ${CLOUD_PATH_PREFIX}`)
  console.log(`云环境: ${CLOUD_ENV_ID}`)
  console.log('')

  // 检查音频目录
  if (!fs.existsSync(audioDir)) {
    console.error(`❌ 音频目录不存在: ${audioDir}`)
    process.exit(1)
  }
  const localFilesOk = checkLocalAudioFiles()
  if (checkOnly) {
    process.exit(localFilesOk ? 0 : 1)
  }

  // 加载进度
  loadProgress()
  const alreadyDone = Object.keys(progress).length
  console.log(`已上传: ${alreadyDone} 个文件（从进度文件恢复）`)
  console.log('')

  // 获取 access_token
  await getAccessToken()

  let totalSuccess = 0
  let totalFail = 0
  let totalSkipped = 0
  let totalDbUpdated = 0
  const failedIndices = []

  const startTime = Date.now()

  for (let i = startIndex; i <= endIndex; i++) {
    try {
      const { results, dbOk } = await processOneIdiom(i)

      const success = results.filter(r => r.fileID && !r.skipped).length
      const skipped = results.filter(r => r.skipped).length
      const failed = results.filter(r => !r.fileID).length

      totalSuccess += success
      totalSkipped += skipped
      totalFail += failed
      if (dbOk) totalDbUpdated++

      const numStr = String(i).padStart(3, '0')
      const done = i - startIndex + 1
      const total = endIndex - startIndex + 1
      const pct = ((done / total) * 100).toFixed(1)
      
      saveProgress()

      if (i % 20 === 0 || failed > 0 || startIndex === endIndex || dbOk === false) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
        console.log(`[${done}/${total} ${pct}%] #${numStr}: 成功${success} 跳过${skipped} 失败${failed} DB${dbOk ? '✓' : '✗'} (${elapsed}s)`)
      }

      if (failed > 0) failedIndices.push(i)

      // 每100条保存一次进度
      if (i % 100 === 0) saveProgress()

    } catch (err) {
      console.error(`❌ #${i} 异常: ${err.message}`)
      failedIndices.push(i)
      totalFail += 3
    }

    // 间隔 200ms，避免限流
    await new Promise(r => setTimeout(r, 200))
  }

  // 最终保存进度
  saveProgress()

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
  console.log('')
  console.log('========================================')
  console.log(`  完成！耗时 ${elapsed}s`)
  console.log(`  成功: ${totalSuccess}  跳过: ${totalSkipped}  失败: ${totalFail}`)
  console.log(`  DB更新: ${totalDbUpdated}`)
  if (failedIndices.length > 0) {
    console.log(`  失败编号: ${failedIndices.join(',')}`)
    console.log(`  重试: node scripts/upload-audio-local.js --start ${failedIndices[0]} --end ${failedIndices[failedIndices.length-1]}`)
  }
  console.log('========================================')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
