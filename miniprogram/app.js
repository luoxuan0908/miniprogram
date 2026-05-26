const vocabStorage = require('./utils/storage')
const resourceStorage = require('./utils/resource-storage')
const courseStorage = require('./utils/course-storage')
const userStorage = require('./utils/user-storage')
const { CLOUD_ENV_ID } = require('./utils/constants')

App({
  onLaunch() {
    wx.cloud.init({
      env: CLOUD_ENV_ID,
      traceUser: true
    })
    this.checkLogin()
  },

  async checkLogin() {
    const userInfo = wx.getStorageSync('userInfo')
    const cachedOpenid = wx.getStorageSync('openid')
    if (userInfo && cachedOpenid) {
      // 优先使用 user-storage 中的最新本地缓存
      const localProfile = userStorage.getUserProfile()
      if (localProfile && (localProfile.nickName || localProfile.avatarUrl)) {
        this.globalData.userInfo = localProfile
      } else {
        this.globalData.userInfo = userInfo
      }
      this.globalData.openid = cachedOpenid
      this.globalData.isLoggedIn = true
      this.initUserCaches()
      return
    }
    try {
      const res = await wx.cloud.callFunction({
        name: 'login'
      })
      this.globalData.openid = res.result.openid
      this.globalData.isLoggedIn = true
      wx.setStorageSync('openid', res.result.openid)
      this.initUserCaches()

      // 从云数据库加载用户资料（头像、昵称）
      const profile = await userStorage.loadUserProfileFromCloud()
      if (profile && (profile.nickName || profile.avatarUrl)) {
        this.globalData.userInfo = profile
        wx.setStorageSync('userInfo', profile)
      }
    } catch (err) {
      console.error('登录失败', err)
    }
  },

  initUserCaches() {
    vocabStorage.initForActiveUser()
    resourceStorage.initForActiveUser()
    courseStorage.initForActiveUser()
  },

  globalData: {
    userInfo: null,
    openid: '',
    isLoggedIn: false,
    currentWordId: null
  }
})
