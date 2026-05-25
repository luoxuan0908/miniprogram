/**
 * 云数据库课程数据导入脚本
 * 
 * 用法: 在小程序云开发控制台运行，或通过云函数执行
 * 
 * 步骤:
 * 1. 创建 courses / course_items / userCourseProgress 集合
 * 2. 导入 courses.json 和 course_items.json
 * 
 * 注意: 由于云数据库的限制，大量数据需要分批导入
 * 本脚本生成按云数据库导入格式的要求拆分后的JSON文件
 */

const fs = require('fs')
const path = require('path')

const OUTPUT_DIR = path.resolve(__dirname, 'output')
const IMPORT_DIR = path.resolve(__dirname, 'output/cloud-import')

function main() {
  // 读取解析好的数据
  const courses = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'courses.json'), 'utf-8'))
  const items = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'course_items.json'), 'utf-8'))

  if (!fs.existsSync(IMPORT_DIR)) {
    fs.mkdirSync(IMPORT_DIR, { recursive: true })
  }

  // 1. courses 集合导入文件（每行一个JSON对象，云数据库导入格式）
  const coursesImport = courses.map(c => JSON.stringify(c)).join('\n')
  fs.writeFileSync(path.join(IMPORT_DIR, 'courses.jsonl'), coursesImport, 'utf-8')
  console.log(`courses.jsonl 已生成 (${courses.length} 条)`)

  // 2. course_items 集合导入文件
  // 云数据库单次导入限制，按500条一批拆分
  const BATCH_SIZE = 500
  const batchCount = Math.ceil(items.length / BATCH_SIZE)

  for (let i = 0; i < batchCount; i++) {
    const batch = items.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)
    const batchData = batch.map(item => JSON.stringify(item)).join('\n')
    const filename = `course_items_${String(i + 1).padStart(3, '0')}.jsonl`
    fs.writeFileSync(path.join(IMPORT_DIR, filename), batchData, 'utf-8')
    console.log(`${filename} 已生成 (${batch.length} 条)`)
  }

  // 3. 生成集合权限配置说明
  const securityRules = {
    courses: {
      read: true,
      write: false  // 仅管理员可写
    },
    course_items: {
      read: true,
      write: false  // 仅管理员可写
    },
    userCourseProgress: {
      read: 'auth',   // 登录用户可读自己的
      write: 'auth'    // 登录用户可写自己的
    }
  }

  fs.writeFileSync(
    path.join(IMPORT_DIR, 'security-rules.json'),
    JSON.stringify(securityRules, null, 2),
    'utf-8'
  )

  console.log('\n--- 导入指南 ---')
  console.log('1. 在云开发控制台创建 3 个集合: courses, course_items, userCourseProgress')
  console.log('2. 配置集合权限（参考 security-rules.json）:')
  console.log('   - courses / course_items: 所有用户可读，仅创建者可读写')
  console.log('   - userCourseProgress: 仅创建者可读写')
  console.log('3. 在云开发控制台 → 数据库 → 导入，选择对应的 .jsonl 文件')
  console.log(`4. course_items 共 ${batchCount} 个批次，需逐个导入`)
  console.log('5. 导入格式选择: JSONL (每行一个JSON)')
  console.log(`\n总数据量: courses=${courses.length}条, course_items=${items.length}条`)
}

main()
