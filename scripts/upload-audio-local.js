/**
 * 本地上传习语音频到微信云存储
 * 
 * 不使用云函数，直接通过微信云开发 HTTP API 上传本地文件
 * 
 * 使用前需配置:
 *   APPID - 小程序 AppID
 *   APPSECRET - 小程序 AppSecret
 * 
 * 用法: node scripts/upload-audio-local.js [--start 1] [--end 1355] [--concurrency 3]
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')

// ====== 配置 ======
const APPID = ''       // 填入你的小程序 AppID
const APPSECRET = ''   // 填入你的小程序 AppSecret
const ENV_ID = 'cloud1-d9g82wxrn9260a87b'
const AUDIO_DIR = '/Users/luoxuan/技术/Most_Common_Amrican_Idioms/audio'
const CLOUD_PATH_PREFIX = 'idioms-audio/'
const TOTAL_IDIOMS = 1355
const DB_COLLECTION = 'course_items'

// ====== 命令行参数 ======
const args = process.argv.slice(2)
let startIndex = 1
let endIndex = TOTAL_IDIOMS
let concurrency = 3

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--start' && args[i + 1]) startIndex = parseInt(args[i + 1])
  if (args[i] === '--end' && args[i + 1]) endIndex = parseInt(args[i + 1])
  if (args[i] === '--concurrency' && args[i + 1]) concurrency = parseInt(args[i + 1])
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

  if (!APPID || !APPSECRET) {
    console.error('❌ 请先配置 APPID 和 APPSECRET')
    console.error('   在脚本顶部填入你的小程序 AppID 和 AppSecret')
    console.error('   获取地址: https://mp.weixin.qq.com/ → 开发管理 → 开发设置')
    process.exit(1)
  }

  console.log('🔑 获取 access_token...')
  const res = await httpsGet(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${APPSECRET}`
  )

  if (res.access_token) {
    accessToken = res.access_token
    tokenExpireTime = Date.now() + (res.expires_in - 300) * 1000 // 提前5分钟刷新
    console.log('✅ access_token 获取成功')
    return accessToken
  } else {
    throw new Error(`获取 access_token 失败: ${JSON.stringify(res)}`)
  }
}

async function uploadOneFile(index, sub) {
  const numStr = String(index).padStart(3, '0')
  const fileName = `${numStr}.${sub}.mp3`
  const localPath = path.join(AUDIO_DIR, fileName)
  const cloudPath = CLOUD_PATH_PREFIX + fileName

  // 检查本地文件
  if (!fs.existsSync(localPath)) {
    return { index, sub, fileID: '', error: '本地文件不存在' }
  }

  // 检查是否已上传
  const progressKey = `${index}.${sub}`
  if (progress[progressKey]) {
    return { index, sub, fileID: progress[progressKey], skipped: true }
  }

  try {
    const token = await getAccessToken()

    // 步骤1: 获取上传链接
    const uploadInfo = await httpsPost(
      `https://api.weixin.qq.com/tcb/uploadfile?access_token=${token}`,
      { env: ENV_ID, path: cloudPath }
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
    if (sub === 3) saveProgress() // 每条习语3个文件都上传后保存

    return { index, sub, fileID }
  } catch (err) {
    return { index, sub, fileID: '', error: err.message }
  }
}

async function updateDatabase(index, audioMap) {
  const itemId = `idiom-${String(index).padStart(4, '0')}`
  const token = await getAccessToken()

  // 先查询记录
  const queryRes = await httpsPost(
    `https://api.weixin.qq.com/tcb/databasequery?access_token=${token}`,
    {
      env: ENV_ID,
      query: `db.collection("${DB_COLLECTION}").where({id: "${itemId}"}).limit(1).get()`
    }
  )

  if (queryRes.errcode !== 0 || !queryRes.data || queryRes.data.length === 0) {
    console.warn(`  ⚠️  条目 ${itemId} 未找到`)
    return false
  }

  const doc = JSON.parse(queryRes.data[0])
  const docId = doc._id
  const examples = doc.examples || []

  for (let i = 0; i < examples.length; i++) {
    const subIndex = i + 1
    const key = `${String(index).padStart(3, '0')}.${subIndex}`
    if (audioMap[key]) {
      examples[i].audio = audioMap[key]
    }
  }

  // 更新记录
  const updateRes = await httpsPost(
    `https://api.weixin.qq.com/tcb/databaseupdate?access_token=${token}`,
    {
      env: ENV_ID,
      query: `db.collection("${DB_COLLECTION}").doc("${docId}").update({data:{examples:${JSON.stringify(examples)}}})`
    }
  )

  return updateRes.errcode === 0
}

async function processOneIdiom(index) {
  const audioMap = {}
  const results = []

  for (let sub = 1; sub <= 3; sub++) {
    const result = await uploadOneFile(index, sub)
    results.push(result)
    if (result.fileID) {
      const numStr = String(index).padStart(3, '0')
      audioMap[`${numStr}.${sub}`] = result.fileID
    }
  }

  // 更新数据库
  let dbOk = false
  const hasFiles = Object.values(audioMap).some(v => v)
  if (hasFiles) {
    try {
      dbOk = await updateDatabase(index, audioMap)
    } catch (err) {
      console.error(`  ❌ DB更新失败 #${index}: ${err.message}`)
    }
  }

  return { results, dbOk }
}

// ====== 主流程 ======
async function main() {
  console.log('========================================')
  console.log('  习语音频本地上传工具')
  console.log('========================================')
  console.log(`范围: #${startIndex} ~ #${endIndex}`)
  console.log(`音频目录: ${AUDIO_DIR}`)
  console.log(`云存储路径: ${CLOUD_PATH_PREFIX}`)
  console.log('')

  if (!APPID || !APPSECRET) {
    console.error('❌ 请先配置 APPID 和 APPSECRET')
    console.error('')
    console.error('打开脚本文件，在顶部填入:')
    console.error('  APPID = "你的小程序AppID"')
    console.error('  APPSECRET = "你的小程序AppSecret"')
    console.error('')
    console.error('获取方式:')
    console.error('  1. 登录 https://mp.weixin.qq.com/')
    console.error('  2. 开发管理 → 开发设置')
    console.error('  3. AppID(小程序ID) 和 AppSecret(小程序密钥)')
    process.exit(1)
  }

  // 检查音频目录
  if (!fs.existsSync(AUDIO_DIR)) {
    console.error(`❌ 音频目录不存在: ${AUDIO_DIR}`)
    process.exit(1)
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
      
      if (i % 20 === 0 || failed > 0 || startIndex === endIndex) {
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
