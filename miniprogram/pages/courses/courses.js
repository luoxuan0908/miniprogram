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

  async loadCourses() {
    this.setData({ loading: true })

    const courses = await courseStorage.getAllCoursesAsync()
    const statsMap = {}
    const viewCourses = courses.map(c => {
      const typeConfig = courseStorage.getTypeConfig(c.type)
      statsMap[c.id] = courseStorage.getCourseStats(c.id)
      return {
        ...c,
        _typeLabel: typeConfig.label,
        _itemUnit: typeConfig.itemUnit
      }
    })
    this.setData({ courses: viewCourses, statsMap, loading: false })
  },

  onCourseTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/course-detail/course-detail?courseId=${id}` })
  }
})
