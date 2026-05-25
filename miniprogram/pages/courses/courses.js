const courseStorage = require('../../utils/course-storage')

Page({
  data: {
    courses: [],
    statsMap: {},
    loading: true
  },

  onShow() {
    this.loadCourses()
  },

  loadCourses() {
    const courses = courseStorage.getAllCourses()
    const statsMap = {}
    courses.forEach(c => {
      statsMap[c.id] = courseStorage.getCourseStats(c.id)
      // 动态附加类型配置，避免硬编码
      c._typeLabel = courseStorage.getTypeConfig(c.type).label
      c._itemUnit = courseStorage.getTypeConfig(c.type).itemUnit
    })
    this.setData({ courses, statsMap, loading: false })
  },

  onCourseTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/course-detail/course-detail?courseId=${id}` })
  }
})
