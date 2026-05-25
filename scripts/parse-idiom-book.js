/**
 * book.md → courses JSON + course_items JSON 解析脚本
 * 
 * 用法: node scripts/parse-idiom-book.js
 * 
 * 输入: most-common-american-idioms/book.md
 * 输出: 
 *   - scripts/output/courses.json (1条课程元数据)
 *   - scripts/output/course_items.json (1355条习语条目)
 */

const fs = require('fs')
const path = require('path')

const INPUT_FILE = path.resolve(__dirname, '../../most-common-american-idioms/book.md')
const OUTPUT_DIR = path.resolve(__dirname, 'output')

const COURSE_ID = 'idioms-1355'

function parseBookMd(content) {
  const items = []
  
  // 按 ## N. title 分割每个习语条目
  // 注意: 源文件部分条目编号有多余空格(如 "##  24.")或编号错误(如 "## 1." 而非 "## 858.")
  // 策略: 按顺序匹配所有 ## 标题行，用自增序号作为真实 index
  const entryRegex = /^##\s+\d+\.\s+(.+?)\s*$/gm
  const entries = []
  let match
  
  while ((match = entryRegex.exec(content)) !== null) {
    entries.push({
      title: match[1].trim(),
      startPos: match.index,
      endPos: -1
    })
  }
  
  // 设置每个条目的结束位置，并用自增序号作为真实 index
  for (let i = 0; i < entries.length; i++) {
    entries[i].endPos = i + 1 < entries.length ? entries[i + 1].startPos : content.length
    entries[i].index = i + 1  // 自增序号，不依赖源文件编号
  }
  
  console.log(`找到 ${entries.length} 个习语条目`)
  
  for (const entry of entries) {
    const block = content.substring(entry.startPos, entry.endPos)
    const item = parseEntry(block, entry.index, entry.title)
    if (item) {
      items.push(item)
    }
  }
  
  return items
}

function parseEntry(block, index, title) {
  // 提取释义部分（**释义** 到 **例句**/**举例** 之间）
  const defMatch = block.match(/\*\*释义\*\*\s*\n([\s\S]*?)\n\*\*(?:例句|举例)\*\*/)
  if (!defMatch) {
    console.warn(`条目 ${index}: 无法解析释义部分`)
    return null
  }
  
  const defBlock = defMatch[1].trim()
  
  // 分离中文和英文释义
  // 中文释义通常在前，英文释义在后
  // 中文段落以"。"结尾，英文段落包含完整英文句子
  const lines = defBlock.split('\n').filter(l => l.trim())
  
  let cnDefinition = ''
  let cnOrigin = ''
  let enDefinition = ''
  let enOrigin = ''
  
  // 分离策略：中文行 和 英文行
  const cnLines = []
  const enLines = []
  
  for (const line of lines) {
    // 判断是否为英文行：以大写字母开头，或包含较多英文字符
    const isEnglish = /^[A-Z""]/.test(line.trim()) && 
                      (line.match(/[a-zA-Z]/g) || []).length > (line.match(/[\u4e00-\u9fa5]/g) || []).length
    if (isEnglish) {
      enLines.push(line.trim())
    } else {
      cnLines.push(line.trim())
    }
  }
  
  // 中文释义：第一行是简短定义，后续是词源/详细解释
  if (cnLines.length > 0) {
    cnDefinition = cnLines[0]
    cnOrigin = cnLines.slice(1).join(' ').trim()
  }
  
  // 英文释义：类似处理
  if (enLines.length > 0) {
    enDefinition = enLines[0]
    enOrigin = enLines.slice(1).join(' ').trim()
  }
  
  // 提取例句
  const examples = []
  const exampleRegex = /<span lang="en">(.+?)<\/span>\s*<span lang="cn">(.+?)<\/span>/g
  let exMatch
  
  while ((exMatch = exampleRegex.exec(block)) !== null) {
    let en = exMatch[1].trim()
    const cn = exMatch[2].trim()
    
    // 移除习语的斜体标记 *phrase*
    en = en.replace(/\*([^*]+)\*/g, '$1')
    
    // 提取音频路径
    const audioMatch = block.substring(exMatch.index, exMatch.index + 500).match(/src="(audio\/[^"]+)"/)
    const audio = audioMatch ? audioMatch[1] : ''
    
    examples.push({ en, cn, audio })
  }
  
  // 估算难度（基于标题长度和内容复杂度）
  const difficulty = estimateDifficulty(title, cnDefinition)
  
  return {
    id: `idiom-${String(index).padStart(4, '0')}`,
    courseId: COURSE_ID,
    index,
    title,
    definition: {
      cn: cnDefinition,
      en: enDefinition
    },
    examples,
    difficulty,
    tags: generateTags(title, cnDefinition),
    extra: {
      origin: {
        cn: cnOrigin,
        en: enOrigin
      }
    }
  }
}

function estimateDifficulty(title, cnDefinition) {
  // 简单启发式规则
  let score = 1
  
  // 标题越长越难
  if (title.split(' ').length > 5) score += 1
  if (title.split(' ').length > 8) score += 1
  
  // 包含隐喻/典故的中文定义通常更难
  if (cnDefinition.includes('起源') || cnDefinition.includes('典故')) score += 1
  if (cnDefinition.includes('中世纪') || cnDefinition.includes('圣经') || cnDefinition.includes('神话')) score += 1
  
  return Math.min(score, 5)
}

function generateTags(title, cnDefinition) {
  const tags = []
  
  // 根据内容特征打标签
  if (/proverb|saying|谚语|格言/i.test(title + cnDefinition)) tags.push('谚语')
  if (/slang|俚语/i.test(title + cnDefinition)) tags.push('俚语')
  if (/formal|正式/i.test(title + cnDefinition)) tags.push('正式')
  if (/informal|非正式|口语/i.test(title + cnDefinition)) tags.push('口语')
  if (/business|商业|职场/i.test(title + cnDefinition)) tags.push('商务')
  if (/animal|动物|cat|dog|horse|bird|fish/i.test(title.toLowerCase())) tags.push('动物')
  if (/food|食物|cake|bread|egg|butter/i.test(title.toLowerCase())) tags.push('食物')
  if (/body|身体|hand|head|heart|foot|eye|ear/i.test(title.toLowerCase())) tags.push('身体')
  if (/color|颜色|red|blue|green|black|white/i.test(title.toLowerCase())) tags.push('颜色')
  if (/money|钱|dollar|cent|penny|pay/i.test(title.toLowerCase())) tags.push('金钱')
  
  return tags
}

function generateCourseMetadata(itemCount) {
  return {
    id: COURSE_ID,
    type: 'idioms',
    title: '美语习语 1355',
    subtitle: 'Most Common American Idioms',
    description: '由 xiaolai 整理的 1355 条最常用美语习语，包含中英释义、词源和例句。适合有一定英语基础的学习者提升地道表达能力。',
    totalItems: itemCount,
    version: 1,
    sourceUrl: 'https://github.com/luoxuan0908/most-common-american-idioms',
    coverUrl: '',
    tags: ['习语', '美式英语', '口语', '地道表达'],
    isActive: true,
    extra: {}
  }
}

// 主流程
function main() {
  console.log('读取 book.md...')
  const content = fs.readFileSync(INPUT_FILE, 'utf-8')
  
  console.log('解析习语条目...')
  const items = parseBookMd(content)
  
  console.log(`成功解析 ${items.length} 条习语`)
  
  // 生成课程元数据
  const course = generateCourseMetadata(items.length)
  
  // 输出
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  }
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'courses.json'),
    JSON.stringify([course], null, 2),
    'utf-8'
  )
  console.log(`课程元数据已写入 output/courses.json`)
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'course_items.json'),
    JSON.stringify(items, null, 2),
    'utf-8'
  )
  console.log(`课程条目已写入 output/course_items.json (${items.length} 条)`)
  
  // 统计
  const withOrigin = items.filter(i => i.extra.origin && (i.extra.origin.cn || i.extra.origin.en)).length
  const withExamples = items.filter(i => i.examples.length > 0).length
  const avgExamples = (items.reduce((s, i) => s + i.examples.length, 0) / items.length).toFixed(1)
  
  console.log('\n--- 数据统计 ---')
  console.log(`总条目: ${items.length}`)
  console.log(`含词源: ${withOrigin} (${(withOrigin/items.length*100).toFixed(1)}%)`)
  console.log(`含例句: ${withExamples} (${(withExamples/items.length*100).toFixed(1)}%)`)
  console.log(`平均例句数: ${avgExamples}`)
  
  // 难度分布
  const diffDist = {}
  items.forEach(i => { diffDist[i.difficulty] = (diffDist[i.difficulty] || 0) + 1 })
  console.log('难度分布:', JSON.stringify(diffDist))
  
  // 标签统计
  const tagSet = new Set()
  items.forEach(i => i.tags.forEach(t => tagSet.add(t)))
  console.log(`标签种类: ${tagSet.size}`, [...tagSet].join(', '))
}

main()
