const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

/**
 * syncData - 用户隔离的数据同步云函数。
 *
 * 支持：
 * - 默认 push：{ words, resources, preferences, deletedWordIds, deletedResourceIds }
 * - 拉取：{ action: 'pull', scope?: 'words' | 'resources' | 'all' }
 */
exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const ownerId = openid

  if (!openid) {
    return { success: false, error: '未获取到 openid' }
  }

  // 自动创建集合（如果集合不存在，get()/update() 可能报错）
  if (event.action !== 'pull') {
    await ensureCollection('words')
    await ensureCollection('resources')
    await ensureCollection('preferences')
  }

  if (event.action === 'pull') {
    return pullData(openid, event.scope || 'all')
  }

  try {
    const words = Array.isArray(event.words) ? event.words : []
    const resources = Array.isArray(event.resources) ? event.resources : []
    const deletedWordIds = Array.isArray(event.deletedWordIds) ? event.deletedWordIds : []
    const deletedResourceIds = Array.isArray(event.deletedResourceIds) ? event.deletedResourceIds : []
    const preferences = event.preferences && typeof event.preferences === 'object' ? event.preferences : null
    const syncedAt = Date.now()

    const wordResult = await upsertRecords('words', words, openid, ownerId, syncedAt)
    const resourceResult = await upsertRecords('resources', resources, openid, ownerId, syncedAt)
    const deletedWords = await deleteRecords('words', deletedWordIds, openid)
    const deletedResources = await deleteRecords('resources', deletedResourceIds, openid)
    const preferenceResult = preferences
      ? await upsertPreference(preferences, openid, ownerId, syncedAt)
      : { synced: 0, failed: 0 }

    const hasAnyPayload = words.length > 0 || resources.length > 0 || deletedWordIds.length > 0 || deletedResourceIds.length > 0 || preferences
    const allFailed = hasAnyPayload &&
      wordResult.failed === wordResult.total &&
      resourceResult.failed === resourceResult.total &&
      deletedWords.failed === deletedWords.total &&
      deletedResources.failed === deletedResources.total &&
      preferenceResult.failed === preferenceResult.total

    if (allFailed) {
      return {
        success: false,
        error: '所有记录同步失败，请检查云数据库集合是否存在（words、resources、preferences）',
        words: wordResult,
        resources: resourceResult,
        preferences: preferenceResult,
        deletedWords,
        deletedResources
      }
    }

    return {
      success: true,
      words: wordResult,
      resources: resourceResult,
      preferences: preferenceResult,
      deletedWords,
      deletedResources
    }
  } catch (err) {
    console.error('syncData error:', err)
    return { success: false, error: err.message || '数据同步失败' }
  }
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name)
  } catch (e) {
    // 集合已存在或 createCollection 不支持时忽略
  }
}

async function pullData(openid, scope) {
  try {
    const result = { success: true }

    if (scope === 'all' || scope === 'words') {
      result.words = await getAllRecords('words', openid)
    }

    if (scope === 'all' || scope === 'resources') {
      result.resources = await getAllRecords('resources', openid)
    }

    if (scope === 'all' || scope === 'preferences') {
      try {
        const preferences = await db.collection('preferences').where({
          _openid: openid,
          type: 'study_preferences'
        }).get()
        result.preferences = preferences.data && preferences.data[0] ? preferences.data[0].data || {} : {}
      } catch (e) {
        result.preferences = {}
      }
    }

    return result
  } catch (err) {
    console.error('pullData error:', err)
    return { success: false, error: err.message || '数据拉取失败' }
  }
}

async function getAllRecords(collectionName, openid) {
  try {
    const collection = db.collection(collectionName)
    const pageSize = 100
    let skip = 0
    let all = []

    while (true) {
      const res = await collection.where({ _openid: openid }).skip(skip).limit(pageSize).get()
      const data = res.data || []
      all = all.concat(data)
      if (data.length < pageSize) break
      skip += pageSize
    }

    return all
  } catch (e) {
    console.error(`getAllRecords ${collectionName} error:`, e)
    return []
  }
}

async function upsertRecords(collectionName, records, openid, ownerId, syncedAt) {
  if (!records.length) return { total: 0, synced: 0, failed: 0 }

  const collection = db.collection(collectionName)
  const results = await Promise.allSettled(records.map(async record => {
    const id = record.id
    if (!id) throw new Error(`${collectionName} 记录缺少 id`)

    const doc = {
      ...record,
      _openid: openid,
      ownerId,
      createdBy: record.createdBy || ownerId,
      updatedBy: ownerId,
      syncedAt
    }

    delete doc._id

    // 先尝试查询记录是否存在
    try {
      const res = await collection.where({ id, _openid: openid }).get()
      if (res.data && res.data.length > 0) {
        // 记录存在，执行 update
        return collection.where({ id, _openid: openid }).update({ data: doc })
      }
      // 记录不存在，执行 add（add 会自动创建集合）
      return collection.add({ data: doc })
    } catch (getErr) {
      // get 失败（集合不存在等情况），直接尝试 add
      return collection.add({ data: doc })
    }
  }))

  const failed = results.filter(result => result.status === 'rejected')
  if (failed.length) {
    console.error(`${collectionName} 部分同步失败`, failed.map(item => item.reason))
  }

  return {
    total: records.length,
    synced: records.length - failed.length,
    failed: failed.length
  }
}

async function deleteRecords(collectionName, ids, openid) {
  if (!ids.length) return { total: 0, deleted: 0, failed: 0 }

  const collection = db.collection(collectionName)
  const results = await Promise.allSettled(ids.map(async id => {
    try {
      return await collection.where({ id, _openid: openid }).remove()
    } catch (e) {
      // 集合不存在时忽略删除错误
      return { stats: { removed: 0 } }
    }
  }))

  const failed = results.filter(result => result.status === 'rejected')
  if (failed.length) {
    console.error(`${collectionName} 部分删除失败`, failed.map(item => item.reason))
  }

  return {
    total: ids.length,
    deleted: ids.length - failed.length,
    failed: failed.length
  }
}

async function upsertPreference(preferences, openid, ownerId, syncedAt) {
  const collection = db.collection('preferences')
  const doc = {
    type: 'study_preferences',
    data: preferences,
    _openid: openid,
    ownerId,
    createdBy: preferences.createdBy || ownerId,
    updatedBy: ownerId,
    syncedAt
  }

  try {
    const existing = await collection.where({
      _openid: openid,
      type: 'study_preferences'
    }).get()

    if (existing.data && existing.data.length > 0) {
      await collection.where({
        _openid: openid,
        type: 'study_preferences'
      }).update({ data: doc })
    } else {
      await collection.add({ data: doc })
    }

    return { total: 1, synced: 1, failed: 0 }
  } catch (e) {
    console.error('upsertPreference error:', e)
    return { total: 1, synced: 0, failed: 1, error: e.message || '偏好同步失败' }
  }
}
