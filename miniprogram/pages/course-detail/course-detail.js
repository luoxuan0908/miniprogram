const courseStorage = require('../../utils/course-storage')

Page({
  data: {
    courseId: '',
    course: {},
    stats: {},
    typeConfig: {},       // 课程类型配置
    // 三级结构
    hasSections: false,
    sections: [],
    activeSectionIndex: -1,  // -1 = 显示全部/未选章节
    // 条目
    items: [],
    displayItems: [],
    progressMap: {},
    activeTab: 'all',
    searchQuery: '',
    currentPage: 1,
    hasMore: true,
    loading: true,
    loadingMore: false
  },

  onLoad(options) {
    const courseId = options.courseId || ''
    this.setData({ courseId })
  },

  onShow() {
    this.loadCourse()
  },

  async loadCourse() {
    const { courseId } = this.data
    if (!courseId) return

    const course = courseStorage.getCourse(courseId)
    if (!course) return

    const stats = courseStorage.getCourseStats(courseId) || {}
    const progressMap = this.buildProgressMap(courseId)
    const typeConfig = courseStorage.getTypeConfig(course.type)

    this.setData({
      course,
      stats,
      typeConfig,
      hasSections: typeConfig.hasSections,
      progressMap
    })

    // 如果有章节结构，先加载章节
    if (typeConfig.hasSections) {
      const sections = await courseStorage.getCourseSections(courseId)
      this.setData({ sections })
    }

    // 加载第一页条目
    await this.loadItems(1)
    this.setData({ loading: false })
  },

  async loadItems(page, sectionIndex) {
    const { courseId } = this.data
    const options = {}
    if (sectionIndex !== undefined) {
      options.sectionIndex = sectionIndex
    }

    const items = await courseStorage.getCourseItems(courseId, page, options)
    
    if (items.length === 0) {
      this.setData({ hasMore: false })
      return
    }

    const allItems = page === 1 ? items : [...this.data.items, ...items]
    const hasMore = items.length >= courseStorage.PAGE_SIZE

    this.setData({
      items: allItems,
      currentPage: page,
      hasMore
    })

    this.applyFilter()
  },

  buildProgressMap(courseId) {
    const map = {}
    const progress = courseStorage.getCourseProgress(courseId)
    progress.forEach((val, key) => {
      map[key] = val
    })
    return map
  },

  applyFilter() {
    const { items, activeTab, searchQuery, progressMap } = this.data
    let filtered = items

    // 搜索过滤（通用，不再硬编码字段）
    if (searchQuery) {
      const kw = searchQuery.toLowerCase()
      filtered = filtered.filter(item => {
        // 使用 storage 层的通用搜索函数
        const searchStr = extractSearchText(item)
        return searchStr.includes(kw)
      })
    }

    // 状态过滤
    if (activeTab !== 'all') {
      filtered = filtered.filter(item => {
        const p = progressMap[item.id]
        const status = p ? p.status : 'new'
        return status === activeTab
      })
    }

    this.setData({ displayItems: filtered })
  },

  // 章节相关
  onSectionTap(e) {
    const index = e.currentTarget.dataset.index
    this.setData({
      activeSectionIndex: index,
      items: [],
      displayItems: [],
      currentPage: 1,
      hasMore: true
    })
    this.loadItems(1, index)
  },

  onShowAllSections() {
    this.setData({
      activeSectionIndex: -1,
      items: [],
      displayItems: [],
      currentPage: 1,
      hasMore: true
    })
    this.loadItems(1)
  },

  // 筛选相关
  onFilterTap(e) {
    const activeTab = e.currentTarget.dataset.tab
    this.setData({ activeTab })
    this.applyFilter()
  },

  onSearch(e) {
    this.setData({ searchQuery: e.detail.value })
    this.applyFilter()
  },

  onClearSearch() {
    this.setData({ searchQuery: '' })
    this.applyFilter()
  },

  onLoadMore() {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return
    const { activeSectionIndex } = this.data
    this.setData({ loadingMore: true })
    this.loadItems(
      this.data.currentPage + 1,
      activeSectionIndex >= 0 ? activeSectionIndex : undefined
    ).then(() => {
      this.setData({ loadingMore: false })
    })
  },

  onItemTap(e) {
    const id = e.currentTarget.dataset.id
    const index = e.currentTarget.dataset.index
    wx.navigateTo({
      url: `/pages/course-item-detail/course-item-detail?courseId=${this.data.courseId}&itemId=${id}&index=${index}`
    })
  }
})

/**
 * 通用搜索文本提取（页面级轻量版，与 storage 层的 matchItem 逻辑一致）
 */
function extractSearchText(obj, depth) {
  depth = depth || 0
  if (depth > 4) return ''
  if (typeof obj === 'string') return obj.toLowerCase()
  if (typeof obj === 'number') return String(obj)
  if (!obj || typeof obj !== 'object') return ''

  const skipKeys = new Set(['_id', '_openid', 'courseId', 'id'])
  const parts = []
  
  for (const key of Object.keys(obj)) {
    if (skipKeys.has(key)) continue
    const val = obj[key]
    if (typeof val === 'string') {
      parts.push(val.toLowerCase())
    } else if (typeof val === 'object' && val !== null) {
      parts.push(extractSearchText(val, depth + 1))
    }
  }

  return parts.join(' ')
}
