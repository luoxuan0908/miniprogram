/**
 * course-storage.js - Course module three-layer persistence.
 * 
 * L1: module memory (course catalog + loaded items per course)
 * L2: partitioned wx.Storage (u:{openid}:course_*)
 * L3: cloud database (courses + course_sections + course_items + userCourseProgress)
 * 
 * 数据模型（通用设计，支持多课程类型）:
 * - courses: 课程元数据（轻量，启动全量加载）→ type + extra 支持扩展
 * - course_sections: 章节分组（可选，二级课程不需要）→ 支持三级: 课程→章节→条目
 * - course_items: 课程条目（按需分页拉取）→ sectionIndex 标记所属章节
 * - userCourseProgress: 用户进度 → status(new/learning/mastered) + extra
 * 
 * 懒加载策略:
 * - 课程目录(courses)随app启动全量加载(轻量元数据)
 * - 课程章节(course_sections)按需加载(进课程时拉取)
 * - 课程条目(course_items)按需分页拉取(每页50条)
 * - 用户进度(userCourseProgress)独立管理
 */

const userStorage = require('./user-storage')
const builtInCourses = require('../data/built-in-courses')

const COURSE_INDEX_KEY = 'course_index'
const COURSE_KEY_PREFIX = 'course_'
const SECTION_KEY_PREFIX = 'course_sections_'
const PROGRESS_KEY_PREFIX = 'course_progress_'
const PAGE_SIZE = 50

// ============================
// 课程类型配置（新增课程类型只需在此添加）
// ============================
const COURSE_TYPE_CONFIG = {
  'idioms': {
    label: '习语',
    hasSections: false,       // 二级结构：课程→条目
    itemUnit: '条',           // 条目单位
    detailTemplate: 'phrase'  // 详情页模板类型
  },
  'phrasal-verbs': {
    label: '短语动词',
    hasSections: false,
    itemUnit: '条',
    detailTemplate: 'phrase'
  },
  'collocations': {
    label: '搭配',
    hasSections: false,
    itemUnit: '条',
    detailTemplate: 'phrase'
  },
  'academic-vocab': {
    label: '学术词汇',
    hasSections: false,
    itemUnit: '条',
    detailTemplate: 'phrase'
  },
  'essay-vocab': {
    label: '短文词汇',
    hasSections: true,        // 三级结构：课程→短文→词汇
    itemUnit: '个',
    sectionLabel: '篇',       // 章节单位
    detailTemplate: 'phrase'  // 词汇详情也是 phrase 类型
  },
  'dialogues': {
    label: '场景对话',
    hasSections: true,
    itemUnit: '句',
    sectionLabel: '课',
    detailTemplate: 'dialogue'
  },
  'grammar': {
    label: '语法',
    hasSections: true,
    itemUnit: '条',
    sectionLabel: '章',
    detailTemplate: 'grammar'
  }
}

/**
 * 获取课程类型配置，未知类型返回默认值
 */
function getTypeConfig(type) {
  return COURSE_TYPE_CONFIG[type] || {
    label: type,
    hasSections: false,
    itemUnit: '条',
    detailTemplate: 'phrase'
  }
}

let state = createEmptyState()
let courseHydrationPromise = null
let courseHydrationUserId = ''

function createEmptyState(userId = '') {
  return {
    userId,
    loaded: false,
    courses: [],              // 课程目录（轻量元数据）
    courseMap: new Map(),     // courseId → course
    sectionsMap: new Map(),   // courseId → sections[]
    itemPages: new Map(),     // courseId → Map(page → items[])
    progressMap: new Map(),   // courseId → Map(itemId → progress)
    meta: createDefaultMeta()
  }
}

function createDefaultMeta() {
  return {
    lastSyncTime: 0,
    updatedAt: 0
  }
}

function now() { return Date.now() }

function cloneCourse(course) {
  return {
    ...(course || {}),
    tags: Array.isArray(course && course.tags) ? course.tags.slice() : [],
    extra: {
      ...((course && course.extra) || {})
    }
  }
}

function getBuiltInCourses() {
  return builtInCourses.map(cloneCourse)
}

function setCourseCatalog(courses, options = {}) {
  const catalog = (Array.isArray(courses) ? courses : [])
    .filter(c => c && c.id)
    .map(cloneCourse)

  state.courses = catalog
  state.courseMap.clear()
  catalog.forEach(c => state.courseMap.set(c.id, c))

  if (options.persist !== false) {
    persistCourseIndex()
  }

  return catalog
}

function hydrateCoursesFromBuiltIn() {
  return setCourseCatalog(getBuiltInCourses())
}

function hasCloudDatabase() {
  return typeof wx !== 'undefined' &&
    wx.cloud &&
    typeof wx.cloud.database === 'function'
}

function callCourseDataFunction(data) {
  if (typeof wx === 'undefined' ||
    !wx.cloud ||
    typeof wx.cloud.callFunction !== 'function') {
    return Promise.resolve(null)
  }

  return new Promise(resolve => {
    wx.cloud.callFunction({
      name: 'importCourseData',
      data,
      success: res => resolve(res && res.result),
      fail: err => {
        console.warn('课程云函数读取失败', data && data.action, err)
        resolve(null)
      }
    })
  })
}

function ensureState() {
  if (!state.loaded) {
    loadStateForActiveUser()
  }
}

// ============================
// L1: 内存缓存读写
// ============================

function loadStateForActiveUser() {
  const userId = userStorage.getActiveUserId()
  if (state.userId === userId && state.loaded) return

  state = createEmptyState(userId)

  // 从 L2 加载课程目录
  const index = userStorage.getUserStorageSync(COURSE_INDEX_KEY, [], userId)
  if (Array.isArray(index) && index.length > 0) {
    state.courses = index
    index.forEach(c => state.courseMap.set(c.id, c))
  }

  // 从 L2 加载进度
  const progressIndex = userStorage.getUserStorageSync('course_progress_index', [], userId)
  if (Array.isArray(progressIndex)) {
    progressIndex.forEach(p => {
      if (!state.progressMap.has(p.courseId)) {
        state.progressMap.set(p.courseId, new Map())
      }
      state.progressMap.get(p.courseId).set(p.itemId, p)
    })
  }

  state.loaded = true

  // L3 回填（仅本地为空时）。课程目录是公开数据，不依赖用户进度登录态。
  if (state.courses.length === 0) {
    hydrateCoursesFromCloud()
  }
}

// ============================
// 课程目录 (courses) 操作
// ============================

/**
 * 获取所有课程目录
 */
function getAllCourses() {
  ensureState()
  return state.courses.filter(c => c.isActive !== false)
}

async function getAllCoursesAsync(options = {}) {
  ensureState()

  let courses = getAllCourses()
  if (courses.length > 0 && !options.forceRefresh) {
    return courses
  }

  await hydrateCoursesFromCloud()
  courses = getAllCourses()
  return courses
}

/**
 * 获取单个课程
 */
function getCourse(courseId) {
  ensureState()
  return state.courseMap.get(courseId) || null
}

/**
 * 获取课程学习统计
 */
function getCourseStats(courseId) {
  ensureState()
  const course = state.courseMap.get(courseId)
  if (!course) return null

  const progressMap = state.progressMap.get(courseId) || new Map()
  let newCount = 0, learningCount = 0, masteredCount = 0
  progressMap.forEach(p => {
    if (p.status === 'mastered') masteredCount++
    else if (p.status === 'learning') learningCount++
    else newCount++
  })

  return {
    courseId,
    totalItems: course.totalItems || 0,
    newCount,
    learningCount,
    masteredCount,
    progressPercent: course.totalItems > 0
      ? Math.round((masteredCount / course.totalItems) * 100)
      : 0
  }
}

// ============================
// 课程章节 (course_sections) 操作
// ============================

/**
 * 获取课程章节列表
 * @param {string} courseId
 * @returns {Array} 章节列表
 */
async function getCourseSections(courseId) {
  ensureState()

  // L1 命中
  if (state.sectionsMap.has(courseId)) {
    return state.sectionsMap.get(courseId)
  }

  // L2 命中
  const l2Key = `${SECTION_KEY_PREFIX}${courseId}`
  const l2Data = userStorage.getUserStorageSync(l2Key, null)
  if (l2Data && Array.isArray(l2Data) && l2Data.length > 0) {
    state.sectionsMap.set(courseId, l2Data)
    return l2Data
  }

  // L3: 云数据库拉取。课程章节是公开数据，登录完成前也允许读取。
  try {
    const db = wx.cloud.database()
    const { data } = await db.collection('course_sections')
      .where({ courseId })
      .orderBy('index', 'asc')
      .limit(200)
      .get()

    if (data && data.length > 0) {
      // 写入 L1 + L2
      state.sectionsMap.set(courseId, data)
      userStorage.setUserStorageSync(l2Key, data, state.userId)
      return data
    }
  } catch (err) {
    console.error('拉取课程章节失败', courseId, err)
  }

  const functionSections = await fetchCourseSectionsFromFunction(courseId)
  if (functionSections.length > 0) {
    state.sectionsMap.set(courseId, functionSections)
    userStorage.setUserStorageSync(l2Key, functionSections, state.userId)
    return functionSections
  }

  return []
}

// ============================
// 课程条目 (course_items) 操作
// ============================

/**
 * 获取课程条目（分页）
 * @param {string} courseId
 * @param {number} page 从1开始
 * @param {object} options 可选: { sectionIndex } 按章节过滤
 */
async function getCourseItems(courseId, page = 1, options = {}) {
  ensureState()

  // 如果有 sectionIndex 过滤，走单独的查询逻辑
  if (options.sectionIndex !== undefined) {
    return getCourseItemsBySection(courseId, options.sectionIndex, page)
  }

  const cacheKey = courseId
  if (!state.itemPages.has(cacheKey)) {
    state.itemPages.set(cacheKey, new Map())
  }
  const pages = state.itemPages.get(cacheKey)

  // L1 命中
  if (pages.has(page)) {
    return pages.get(page)
  }

  // L2 命中
  const l2Key = `${COURSE_KEY_PREFIX}${courseId}_p${page}`
  const l2Data = userStorage.getUserStorageSync(l2Key, null)
  if (l2Data && Array.isArray(l2Data) && l2Data.length > 0) {
    pages.set(page, l2Data)
    return l2Data
  }

  // L3: 云数据库拉取。课程条目是公开数据，登录完成前也允许读取。
  try {
    const db = wx.cloud.database()
    const skip = (page - 1) * PAGE_SIZE
    const { data } = await db.collection('course_items')
      .where({ courseId })
      .orderBy('index', 'asc')
      .skip(skip)
      .limit(PAGE_SIZE)
      .get()

    if (data && data.length > 0) {
      // 写入 L1
      pages.set(page, data)
      // 写入 L2
      userStorage.setUserStorageSync(l2Key, data, state.userId)
      return data
    }
  } catch (err) {
    console.error('拉取课程条目失败', courseId, page, err)
  }

  const functionItems = await fetchCourseItemsFromFunction(courseId, page)
  if (functionItems.length > 0) {
    pages.set(page, functionItems)
    userStorage.setUserStorageSync(l2Key, functionItems, state.userId)
    return functionItems
  }

  return []
}

/**
 * 按章节获取条目
 */
async function getCourseItemsBySection(courseId, sectionIndex, page = 1) {
  ensureState()

  const cacheKey = `${courseId}_s${sectionIndex}`
  if (!state.itemPages.has(cacheKey)) {
    state.itemPages.set(cacheKey, new Map())
  }
  const pages = state.itemPages.get(cacheKey)

  // L1 命中
  if (pages.has(page)) {
    return pages.get(page)
  }

  // L2 命中
  const l2Key = `${COURSE_KEY_PREFIX}${courseId}_s${sectionIndex}_p${page}`
  const l2Data = userStorage.getUserStorageSync(l2Key, null)
  if (l2Data && Array.isArray(l2Data) && l2Data.length > 0) {
    pages.set(page, l2Data)
    return l2Data
  }

  // L3: 云数据库拉取。课程条目是公开数据，登录完成前也允许读取。
  try {
    const db = wx.cloud.database()
    const skip = (page - 1) * PAGE_SIZE
    const where = {
      courseId,
      'extra.sectionIndex': sectionIndex
    }
    const { data } = await db.collection('course_items')
      .where(where)
      .orderBy('index', 'asc')
      .skip(skip)
      .limit(PAGE_SIZE)
      .get()

    if (data && data.length > 0) {
      pages.set(page, data)
      userStorage.setUserStorageSync(l2Key, data, state.userId)
      return data
    }
  } catch (err) {
    console.error('拉取章节条目失败', courseId, sectionIndex, page, err)
  }

  const functionItems = await fetchCourseItemsFromFunction(courseId, page, { sectionIndex })
  if (functionItems.length > 0) {
    pages.set(page, functionItems)
    userStorage.setUserStorageSync(l2Key, functionItems, state.userId)
    return functionItems
  }

  return []
}

/**
 * 获取单个条目
 */
async function getCourseItem(courseId, itemId) {
  ensureState()

  // 先在已加载的页中查找
  const pages = state.itemPages.get(courseId)
  if (pages) {
    for (const [, items] of pages) {
      const found = items.find(i => i.id === itemId)
      if (found) return found
    }
  }

  // 也查 section 维度的缓存
  for (const [key, pages] of state.itemPages) {
    if (key.startsWith(courseId + '_s')) {
      for (const [, items] of pages) {
        const found = items.find(i => i.id === itemId)
        if (found) return found
      }
    }
  }

  // L3 查询。课程条目是公开数据，登录完成前也允许读取。
  try {
    const db = wx.cloud.database()
    const { data } = await db.collection('course_items')
      .where({ courseId, id: itemId })
      .limit(1)
      .get()
    if (data && data.length > 0) return data[0]
  } catch (err) {
    console.error('获取课程条目失败', itemId, err)
  }

  return fetchCourseItemFromFunction(courseId, itemId)
}

/**
 * 搜索课程条目（通用搜索：递归遍历对象所有字符串值）
 */
async function searchCourseItems(courseId, keyword) {
  ensureState()

  if (!keyword || !keyword.trim()) return []
  
  const kw = keyword.trim().toLowerCase()
  const results = []

  // 先在已加载的页中搜索
  for (const [key, pages] of state.itemPages) {
    // 只搜该课程的缓存
    if (!key.startsWith(courseId)) continue
    for (const [, items] of pages) {
      items.forEach(item => {
        if (matchItem(item, kw)) results.push(item)
      })
    }
  }

  // 去重
  const seen = new Set()
  const unique = results.filter(item => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })

  // 如果已加载页有结果，直接返回
  if (unique.length > 0) return unique

  // 否则 L3 搜索（用正则）。课程条目是公开数据，登录完成前也允许读取。
  try {
    const db = wx.cloud.database()
    const { data } = await db.collection('course_items')
      .where({
        courseId,
        title: db.RegExp({ regexp: kw, options: 'i' })
      })
      .limit(50)
      .get()
    if (data) return data
  } catch (err) {
    console.error('搜索课程条目失败', courseId, kw, err)
  }

  const functionItems = await fetchCourseSearchFromFunction(courseId, kw)
  if (functionItems.length > 0) return functionItems

  return unique
}

/**
 * 通用匹配：递归提取对象中所有字符串值进行匹配
 * 不再硬编码字段名，任何课程类型的条目都能搜索
 */
function matchItem(item, keyword) {
  return extractSearchableText(item).includes(keyword)
}

/**
 * 递归提取对象中所有可搜索的文本
 */
function extractSearchableText(obj, depth = 0) {
  if (depth > 4) return '' // 防止无限递归
  if (typeof obj === 'string') return obj.toLowerCase()
  if (typeof obj === 'number') return String(obj)
  if (!obj || typeof obj !== 'object') return ''

  // 跳过不需要搜索的系统字段
  const skipKeys = new Set(['_id', '_openid', 'courseId', 'id'])
  const parts = []
  
  for (const key of Object.keys(obj)) {
    if (skipKeys.has(key)) continue
    const val = obj[key]
    if (typeof val === 'string') {
      parts.push(val.toLowerCase())
    } else if (typeof val === 'object' && val !== null) {
      parts.push(extractSearchableText(val, depth + 1))
    }
  }

  return parts.join(' ')
}

// ============================
// 用户进度 (userCourseProgress) 操作
// ============================

/**
 * 获取某课程的用户进度
 */
function getCourseProgress(courseId) {
  ensureState()
  return state.progressMap.get(courseId) || new Map()
}

/**
 * 获取单个条目的进度
 */
function getItemProgress(courseId, itemId) {
  ensureState()
  const map = state.progressMap.get(courseId)
  return map ? map.get(itemId) || null : null
}

/**
 * 更新条目进度
 */
function updateItemProgress(courseId, itemId, status) {
  ensureState()

  if (!state.progressMap.has(courseId)) {
    state.progressMap.set(courseId, new Map())
  }
  const map = state.progressMap.get(courseId)

  const existing = map.get(itemId) || {
    courseId,
    itemId,
    status: 'new',
    lastStudiedAt: 0
  }

  existing.status = status
  existing.lastStudiedAt = now()

  // L1 更新
  map.set(itemId, existing)

  // L2 更新
  persistProgressIndex(courseId)

  // L3 异步同步
  if (!userStorage.isAnonymousUser(state.userId)) {
    syncProgressToCloud(courseId, existing).catch(err => {
      console.error('同步课程进度失败', courseId, itemId, err)
    })
  }

  return existing
}

/**
 * 标记条目为学习中
 */
function markAsLearning(courseId, itemId) {
  return updateItemProgress(courseId, itemId, 'learning')
}

/**
 * 标记条目为已掌握
 */
function markAsMastered(courseId, itemId) {
  return updateItemProgress(courseId, itemId, 'mastered')
}

/**
 * 重置条目进度
 */
function resetItemProgress(courseId, itemId) {
  return updateItemProgress(courseId, itemId, 'new')
}

// ============================
// L2 持久化
// ============================

function persistCourseIndex() {
  userStorage.setUserStorageSync(COURSE_INDEX_KEY, state.courses, state.userId)
}

function persistProgressIndex(courseId) {
  const map = state.progressMap.get(courseId)
  if (!map) return
  const list = Array.from(map.values())
  const key = `${PROGRESS_KEY_PREFIX}${courseId}`
  userStorage.setUserStorageSync(key, list, state.userId)

  // 更新全量进度索引，避免多课程时后写入的课程覆盖其它课程进度。
  const allProgress = []
  state.progressMap.forEach(courseProgress => {
    allProgress.push(...Array.from(courseProgress.values()))
  })
  userStorage.setUserStorageSync('course_progress_index', allProgress, state.userId)
}

// ============================
// L3 云数据库同步
// ============================

async function hydrateCoursesFromCloud() {
  const targetUserId = state.userId || userStorage.getActiveUserId()
  if (courseHydrationPromise && courseHydrationUserId === targetUserId) {
    return courseHydrationPromise
  }

  courseHydrationUserId = targetUserId
  courseHydrationPromise = (async () => {
    if (hasCloudDatabase()) {
      try {
        const db = wx.cloud.database()
        const { data } = await db.collection('courses')
          .where({ isActive: true })
          .limit(100)
          .get()

        if (data && data.length > 0) {
          return setCourseCatalog(data)
        }
      } catch (err) {
        console.error('回填课程目录失败', err)
      }
    }

    const functionResult = await callCourseDataFunction({ action: 'listCourses' })
    if (functionResult && functionResult.success && Array.isArray(functionResult.courses) && functionResult.courses.length > 0) {
      return setCourseCatalog(functionResult.courses)
    }

    return hydrateCoursesFromBuiltIn()
  })().finally(() => {
    if (courseHydrationUserId === targetUserId) {
      courseHydrationPromise = null
      courseHydrationUserId = ''
    }
  })

  return courseHydrationPromise
}

async function fetchCourseItemsFromFunction(courseId, page, options = {}) {
  const result = await callCourseDataFunction({
    action: 'listItems',
    courseId,
    page,
    pageSize: PAGE_SIZE,
    sectionIndex: options.sectionIndex
  })
  return result && result.success && Array.isArray(result.items) ? result.items : []
}

async function fetchCourseItemFromFunction(courseId, itemId) {
  const result = await callCourseDataFunction({
    action: 'getItem',
    courseId,
    itemId
  })
  return result && result.success && result.item ? result.item : null
}

async function fetchCourseSearchFromFunction(courseId, keyword) {
  const result = await callCourseDataFunction({
    action: 'searchItems',
    courseId,
    keyword
  })
  return result && result.success && Array.isArray(result.items) ? result.items : []
}

async function fetchCourseSectionsFromFunction(courseId) {
  const result = await callCourseDataFunction({
    action: 'listSections',
    courseId
  })
  return result && result.success && Array.isArray(result.sections) ? result.sections : []
}

async function syncProgressToCloud(courseId, progress) {
  if (userStorage.isAnonymousUser(state.userId)) return

  try {
    const db = wx.cloud.database()
    // 查找已有记录
    const { data } = await db.collection('userCourseProgress')
      .where({
        courseId,
        itemId: progress.itemId
      })
      .limit(1)
      .get()

    if (data && data.length > 0) {
      // 更新
      await db.collection('userCourseProgress')
        .doc(data[0]._id)
        .update({
          data: {
            status: progress.status,
            lastStudiedAt: progress.lastStudiedAt
          }
        })
    } else {
      // 新增
      await db.collection('userCourseProgress')
        .add({
          data: {
            courseId,
            itemId: progress.itemId,
            status: progress.status,
            lastStudiedAt: progress.lastStudiedAt,
            extra: {}
          }
        })
    }
  } catch (err) {
    console.error('同步进度到云端失败', courseId, progress.itemId, err)
  }
}

/**
 * 从云端回填进度
 */
async function hydrateProgressFromCloud(courseId) {
  if (userStorage.isAnonymousUser(state.userId)) return

  try {
    const db = wx.cloud.database()
    const { data } = await db.collection('userCourseProgress')
      .where({ courseId })
      .limit(1000)
      .get()

    if (data && data.length > 0) {
      if (!state.progressMap.has(courseId)) {
        state.progressMap.set(courseId, new Map())
      }
      const map = state.progressMap.get(courseId)
      data.forEach(p => {
        map.set(p.itemId, {
          courseId: p.courseId,
          itemId: p.itemId,
          status: p.status,
          lastStudiedAt: p.lastStudiedAt || 0,
          extra: p.extra || {}
        })
      })
      persistProgressIndex(courseId)
    }
  } catch (err) {
    console.error('回填课程进度失败', courseId, err)
  }
}

// ============================
// 初始化
// ============================

function initForActiveUser() {
  loadStateForActiveUser()
}

// ============================
// 导出
// ============================

module.exports = {
  // 课程目录
  getAllCourses,
  getAllCoursesAsync,
  getCourse,
  getCourseStats,
  // 课程章节
  getCourseSections,
  // 课程条目
  getCourseItems,
  getCourseItem,
  searchCourseItems,
  // 用户进度
  getCourseProgress,
  getItemProgress,
  updateItemProgress,
  markAsLearning,
  markAsMastered,
  resetItemProgress,
  // 云端同步
  hydrateCoursesFromCloud,
  hydrateProgressFromCloud,
  // 类型配置
  getTypeConfig,
  COURSE_TYPE_CONFIG,
  // 初始化
  initForActiveUser,
  // 常量
  PAGE_SIZE
}
