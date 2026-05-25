const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

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

exports.main = async (event, context) => {
  const { action } = event

  // 导入课程元数据
  if (action === 'importCourses') {
    const results = []
    for (const course of coursesData) {
      try {
        const { data: existing } = await db.collection('courses')
          .where({ id: course.id })
          .limit(1)
          .get()
        if (existing.length > 0) {
          results.push({ id: course.id, status: 'skipped', reason: 'already exists' })
          continue
        }
        const res = await db.collection('courses').add({ data: course })
        results.push({ id: course.id, status: 'ok', _id: res._id })
      } catch (err) {
        results.push({ id: course.id, status: 'error', error: err.message })
      }
    }
    return { action: 'importCourses', results }
  }

  // 从云存储读取并导入条目批次
  if (action === 'importItemsBatch') {
    const { fileID } = event
    if (!fileID) {
      return { error: '需要 fileID 参数（云存储文件ID）' }
    }

    try {
      // 从云存储下载文件
      const downloadRes = await cloud.downloadFile({ fileID })
      const content = downloadRes.fileContent.toString('utf8')
      const items = JSON.parse(content)

      // 批量写入，每5条一组并发
      let success = 0, error = 0, errors = []
      for (let i = 0; i < items.length; i += 5) {
        const chunk = items.slice(i, i + 5)
        const promises = chunk.map(async (item) => {
          try {
            await db.collection('course_items').add({ data: item })
            return { ok: true }
          } catch (err) {
            // 重复则跳过
            if (err.message && err.message.includes('duplicate')) {
              return { ok: true, skipped: true }
            }
            return { ok: false, id: item.id, error: err.message }
          }
        })
        const results = await Promise.all(promises)
        for (const r of results) {
          if (r.ok) success++
          else { error++; if (errors.length < 5) errors.push(r) }
        }
      }

      return { action: 'importItemsBatch', fileID, total: items.length, success, error, errors }
    } catch (err) {
      return { action: 'importItemsBatch', error: err.message }
    }
  }

  // 查看导入状态
  if (action === 'status') {
    const coursesCount = (await db.collection('courses').count()).total
    const itemsCount = (await db.collection('course_items').count()).total
    const sectionsCount = (await db.collection('course_sections').count()).total
    return {
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
