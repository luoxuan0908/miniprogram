// 初始化云数据库集合
// 在云开发控制台的云函数中执行，或在小程序端调用
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 集合定义：名称 + 权限 + 说明
const COLLECTIONS = [
  {
    name: 'userProfiles',
    description: '用户资料（头像、昵称）',
    rules: {
      read: true,
      write: 'doc._openid == auth.openid'
    }
  },
  {
    name: 'words',
    description: '用户生词本',
    rules: {
      read: 'doc._openid == auth.openid',
      write: 'doc._openid == auth.openid'
    }
  },
  {
    name: 'resources',
    description: '学习资源（文档）',
    rules: {
      read: 'doc._openid == auth.openid',
      write: 'doc._openid == auth.openid'
    }
  },
  {
    name: 'preferences',
    description: '用户偏好设置',
    rules: {
      read: 'doc._openid == auth.openid',
      write: 'doc._openid == auth.openid'
    }
  },
  {
    name: 'courses',
    description: '课程元数据',
    rules: {
      read: true,
      write: false
    }
  },
  {
    name: 'course_sections',
    description: '课程章节',
    rules: {
      read: true,
      write: false
    }
  },
  {
    name: 'course_items',
    description: '课程条目（含音频）',
    rules: {
      read: true,
      write: false
    }
  },
  {
    name: 'userCourseProgress',
    description: '用户课程学习进度',
    rules: {
      read: 'doc._openid == auth.openid',
      write: 'doc._openid == auth.openid'
    }
  },
  {
    name: 'billing_accounts',
    description: '计费账户',
    rules: {
      read: 'doc._openid == auth.openid',
      write: 'doc._openid == auth.openid'
    }
  },
  {
    name: 'billing_ledger',
    description: '计费流水',
    rules: {
      read: 'doc._openid == auth.openid',
      write: 'doc._openid == auth.openid'
    }
  }
]

exports.main = async (event, context) => {
  const results = []

  for (const col of COLLECTIONS) {
    try {
      // 尝试创建集合（如果已存在会报错，忽略）
      await db.createCollection(col.name)
      results.push({ collection: col.name, status: 'created', description: col.description })
    } catch (err) {
      if (err.errCode === -1 || err.message.includes('already exists')) {
        results.push({ collection: col.name, status: 'already_exists', description: col.description })
      } else {
        results.push({ collection: col.name, status: 'error', error: err.message, description: col.description })
      }
    }
  }

  return {
    success: true,
    message: `初始化完成：${results.filter(r => r.status === 'created').length} 个新建，${results.filter(r => r.status === 'already_exists').length} 个已存在`,
    details: results
  }
}
