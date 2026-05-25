/**
 * 本地音频文件 HTTP 服务
 * 
 * 启动后，小程序端可通过 http://localhost:8080/audio/001.1.mp3 访问本地音频文件
 * 
 * 用法: node scripts/audio-server.js
 * 
 * 注意: 需要在微信开发者工具中勾选「不校验合法域名」才能访问 localhost
 */

const http = require('http')
const fs = require('fs')
const path = require('path')

const AUDIO_DIR = '/Users/luoxuan/技术/Most_Common_Amrican_Idioms/audio'
const PORT = 8080

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Range')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // 解析路径 /audio/001.1.mp3
  const urlPath = req.url.split('?')[0]
  
  if (urlPath === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Audio server running. Access /audio/NNN.N.mp3')
    return
  }

  if (urlPath.startsWith('/audio/')) {
    const fileName = urlPath.replace('/audio/', '')
    const filePath = path.join(AUDIO_DIR, fileName)

    // 安全检查：防止路径遍历
    if (!filePath.startsWith(AUDIO_DIR)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    const stat = fs.statSync(filePath)
    
    // 支持Range请求（音频seek）
    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Content-Length', stat.size)
    res.setHeader('Accept-Ranges', 'bytes')

    const range = req.headers.range
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
      const chunkSize = end - start + 1

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': chunkSize
      })

      const stream = fs.createReadStream(filePath, { start, end })
      stream.pipe(res)
    } else {
      res.writeHead(200)
      const stream = fs.createReadStream(filePath)
      stream.pipe(res)
    }
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

server.listen(PORT, () => {
  console.log('========================================')
  console.log('  音频文件服务已启动')
  console.log(`  http://localhost:${PORT}/audio/001.1.mp3`)
  console.log(`  音频目录: ${AUDIO_DIR}`)
  console.log('')
  console.log('  请确保微信开发者工具勾选了:')
  console.log('  详情 → 本地设置 → 不校验合法域名')
  console.log('========================================')
})
