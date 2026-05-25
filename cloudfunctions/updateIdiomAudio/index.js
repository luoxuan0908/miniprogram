/**
 * updateIdiomAudio - 更新习语课程条目的音频字段
 * 
 * 只做数据库更新，不做下载/上传，不会超时
 * 
 * 输入:
 *   { index: number, audioMap: object }
 *   - index: 习语编号（1-1355）
 *   - audioMap: { "001.1": "cloud://xxx", "001.2": "cloud://xxx", ... }
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const DB = cloud.database()

exports.main = async (event) => {
  const { index, audioMap } = event
  if (!index || !audioMap) {
    return { success: false, error: '缺少参数' }
  }

  const itemId = `idiom-${String(index).padStart(4, '0')}`

  try {
    const { data } = await DB.collection('course_items')
      .where({ id: itemId })
      .limit(1)
      .get()

    if (!data || data.length === 0) {
      return { success: false, error: `条目 ${itemId} 未找到` }
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

    return { success: true, itemId }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
