const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

/**
 * 数据同步云函数
 * 将本地生词数据同步到云数据库
 * 使用 openid 隔离用户数据
 */
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const { words } = event

  if (!words || !Array.isArray(words)) {
    return { success: false, error: '数据格式错误' }
  }

  try {
    const collection = db.collection('words')
    const now = Date.now()

    // 逐个 upsert 单词
    const results = await Promise.allSettled(
      words.map(word => {
        const doc = {
          ...word,
          _openid: openid,
          syncedAt: now
        }
        return collection.where({
          id: word.id,
          _openid: openid
        }).get().then(res => {
          if (res.data.length > 0) {
            return collection.where({
              id: word.id,
              _openid: openid
            }).update({ data: doc })
          } else {
            return collection.add({ data: doc })
          }
        })
      })
    )

    const failed = results.filter(r => r.status === 'rejected')
    if (failed.length > 0) {
      console.error('部分同步失败', failed.map(f => f.reason))
    }

    return {
      success: true,
      total: words.length,
      synced: words.length - failed.length,
      failed: failed.length
    }
  } catch (err) {
    console.error('syncData error:', err)
    return { success: false, error: err.message || '数据同步失败' }
  }
}
