const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const COURSE_COLLECTIONS = ['courses', 'course_sections', 'course_items', 'userCourseProgress']
const BUILT_IN_ITEM_MANIFEST = require('./data/manifest.json')

// 课程元数据
const coursesData = [
  {
    id: 'idioms-1355',
    type: 'idioms',
    title: '美语习语 1355',
    subtitle: 'Most Common American Idioms',
    description: '由 xiaolai 整理的 1355 条最常用美语习语，涵盖日常对话、商务交流、文学作品中高频出现的习语表达，适合中高级英语学习者系统学习。',
    totalItems: 1355,
    version: 1,
    sourceUrl: 'https://github.com/luoxuan0908/most-common-american-idioms',
    coverUrl: '',
    tags: ['习语', '美式英语', '口语', '中高级'],
    isActive: true,
    extra: {}
  }
]

function parseImportContent(content) {
  const text = String(content || '').trim()
  if (!text) return []

  if (text[0] === '[' || text[0] === '{') {
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : [parsed]
    } catch (err) {
      // Fall through: JSONL files also begin with "{".
    }
  }

  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return lines.map(line => JSON.parse(line))
}

async function readRecordsFromFile(fileID) {
  const downloadRes = await cloud.downloadFile({ fileID })
  return parseImportContent(downloadRes.fileContent.toString('utf8'))
}

function getBuiltInItemBatch(batch) {
  const batchNumber = Number(batch || 1)
  const manifestItem = BUILT_IN_ITEM_MANIFEST.batches.find(item => item.batch === batchNumber)
  if (!manifestItem) {
    return { error: `batch 必须在 1-${BUILT_IN_ITEM_MANIFEST.batches.length} 之间` }
  }

  return {
    manifestItem,
    items: require(`./data/${manifestItem.file}`)
  }
}

function removeSystemFields(record) {
  const { _id, _openid, ...data } = record || {}
  return data
}

function alreadyExistsError(err) {
  const message = String((err && (err.errMsg || err.message)) || err || '')
  return message.includes('already exists') || message.includes('collection exist') || err.errCode === -1
}

async function ensureCollections(collections = COURSE_COLLECTIONS) {
  const results = []
  for (const name of collections) {
    try {
      await db.createCollection(name)
      results.push({ collection: name, status: 'created' })
    } catch (err) {
      if (alreadyExistsError(err)) {
        results.push({ collection: name, status: 'already_exists' })
      } else {
        results.push({ collection: name, status: 'error', error: err.message })
      }
    }
  }
  return results
}

async function upsertRecord(collectionName, keyFields, record) {
  const data = removeSystemFields(record)
  const where = {}
  for (const field of keyFields) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      return { status: 'error', error: `missing key field: ${field}`, record: data.id || data.title || '' }
    }
    where[field] = data[field]
  }

  const { data: existing } = await db.collection(collectionName).where(where).limit(1).get()
  if (existing && existing.length > 0) {
    await db.collection(collectionName).doc(existing[0]._id).update({ data })
    return { status: 'updated', id: data.id || existing[0]._id }
  }

  const res = await db.collection(collectionName).add({ data })
  return { status: 'created', id: data.id || res._id, _id: res._id }
}

async function importRecords(collectionName, keyFields, records, options = {}) {
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 10, 20))
  const summary = {
    total: records.length,
    created: 0,
    updated: 0,
    error: 0,
    errors: []
  }

  for (let i = 0; i < records.length; i += concurrency) {
    const chunk = records.slice(i, i + concurrency)
    const results = await Promise.all(chunk.map(record =>
      upsertRecord(collectionName, keyFields, record).catch(err => ({
        status: 'error',
        record: record && (record.id || record.title),
        error: err.message
      }))
    ))

    for (const result of results) {
      if (result.status === 'created') summary.created++
      else if (result.status === 'updated') summary.updated++
      else {
        summary.error++
        if (summary.errors.length < 10) summary.errors.push(result)
      }
    }
  }

  return summary
}

async function countCollection(name) {
  try {
    return (await db.collection(name).count()).total
  } catch (err) {
    return null
  }
}

function normalizePage(event) {
  return Math.max(1, Number(event.page) || 1)
}

function normalizePageSize(event) {
  return Math.max(1, Math.min(Number(event.pageSize) || 50, 100))
}

exports.main = async (event, context) => {
  const { action } = event || {}

  if (action === 'ensureCollections') {
    const details = await ensureCollections()
    return { action, success: details.every(item => item.status !== 'error'), details }
  }

  // 导入课程元数据
  if (action === 'importCourses') {
    await ensureCollections(['courses'])
    const courses = event.fileID ? await readRecordsFromFile(event.fileID) : (event.courses || coursesData)
    const summary = await importRecords('courses', ['id'], courses, event)
    return { action, success: summary.error === 0, summary }
  }

  // 从云存储读取并导入条目批次
  if (action === 'importItemsBatch') {
    const items = event.fileID ? await readRecordsFromFile(event.fileID) : (event.items || [])
    if (!items.length) {
      return { action, success: false, error: '需要 fileID 或 items 参数' }
    }

    await ensureCollections(['course_items'])
    const summary = await importRecords('course_items', ['courseId', 'id'], items, event)
    return { action, success: summary.error === 0, summary }
  }

  // 导入随云函数一起部署的内置课程条目分片。
  if (action === 'importBuiltInItems') {
    const batch = getBuiltInItemBatch(event.batch)
    if (batch.error) {
      return { action, success: false, error: batch.error, manifest: BUILT_IN_ITEM_MANIFEST }
    }

    await ensureCollections(['course_items'])
    const summary = await importRecords('course_items', ['courseId', 'id'], batch.items, event)
    return {
      action,
      success: summary.error === 0,
      batch: batch.manifestItem,
      summary,
      remainingBatches: BUILT_IN_ITEM_MANIFEST.batches.length - batch.manifestItem.batch
    }
  }

  if (action === 'builtInItemsManifest') {
    return { action, success: true, manifest: BUILT_IN_ITEM_MANIFEST }
  }

  // 供小程序端读取公开课程数据。客户端数据库权限未放开时也能正常展示。
  if (action === 'listCourses') {
    const { data } = await db.collection('courses')
      .where({ isActive: true })
      .limit(100)
      .get()
    return { action, success: true, courses: data || [] }
  }

  if (action === 'listSections') {
    const { courseId } = event
    if (!courseId) return { action, success: false, error: '需要 courseId 参数' }
    const { data } = await db.collection('course_sections')
      .where({ courseId })
      .orderBy('index', 'asc')
      .limit(200)
      .get()
    return { action, success: true, sections: data || [] }
  }

  if (action === 'listItems') {
    const { courseId } = event
    if (!courseId) return { action, success: false, error: '需要 courseId 参数' }

    const page = normalizePage(event)
    const pageSize = normalizePageSize(event)
    const where = { courseId }
    if (event.sectionIndex !== undefined && event.sectionIndex !== null && event.sectionIndex !== '') {
      where['extra.sectionIndex'] = Number(event.sectionIndex)
    }

    const { data } = await db.collection('course_items')
      .where(where)
      .orderBy('index', 'asc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get()
    return { action, success: true, items: data || [], page, pageSize }
  }

  if (action === 'getItem') {
    const { courseId, itemId } = event
    if (!courseId || !itemId) return { action, success: false, error: '需要 courseId 和 itemId 参数' }

    const { data } = await db.collection('course_items')
      .where({ courseId, id: itemId })
      .limit(1)
      .get()
    return { action, success: true, item: data && data[0] ? data[0] : null }
  }

  if (action === 'searchItems') {
    const { courseId, keyword } = event
    if (!courseId || !keyword) return { action, success: true, items: [] }

    const { data } = await db.collection('course_items')
      .where({
        courseId,
        title: db.RegExp({ regexp: String(keyword).trim(), options: 'i' })
      })
      .limit(50)
      .get()
    return { action, success: true, items: data || [] }
  }

  // 一次导入课程元数据 + 多个条目文件
  if (action === 'importAll') {
    await ensureCollections()
    const courseRecords = event.courseFileID ? await readRecordsFromFile(event.courseFileID) : (event.courses || coursesData)
    const courses = await importRecords('courses', ['id'], courseRecords, event)
    const batches = []
    for (const fileID of event.itemFileIDs || []) {
      const items = await readRecordsFromFile(fileID)
      batches.push({
        fileID,
        summary: await importRecords('course_items', ['courseId', 'id'], items, event)
      })
    }
    const itemErrors = batches.reduce((sum, batch) => sum + batch.summary.error, 0)
    return { action, success: courses.error === 0 && itemErrors === 0, courses, batches }
  }

  // 查看导入状态
  if (action === 'status') {
    const coursesCount = await countCollection('courses')
    const itemsCount = await countCollection('course_items')
    const sectionsCount = await countCollection('course_sections')
    return {
      success: true,
      collections: { courses: coursesCount, course_items: itemsCount, course_sections: sectionsCount }
    }
  }

  // 清除数据
  if (action === 'cleanup') {
    const { collection, field, value } = event
    if (!collection) return { error: '需要 collection 参数' }

    let deleted = 0
    let hasMore = true
    while (hasMore) {
      const query = field && value ? { [field]: value } : {}
      const { data } = await db.collection(collection).where(query).limit(100).get()
      if (data.length === 0) { hasMore = false; break }
      for (const doc of data) {
        await db.collection(collection).doc(doc._id).remove()
        deleted++
      }
    }
    return { collection, field, value, deleted }
  }

  return { error: '未知 action' }
}
