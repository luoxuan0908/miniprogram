const vocabStorage = require('./utils/storage')
const resourceStorage = require('./utils/resource-storage')

App({
  onLaunch() {
    wx.cloud.init({
      env: 'cloud1-d9g82wxrn9260a87b',
      traceUser: true
    })
    this.checkLogin()
  },

  async checkLogin() {
    const userInfo = wx.getStorageSync('userInfo')
    const cachedOpenid = wx.getStorageSync('openid')
    if (userInfo && cachedOpenid) {
      this.globalData.userInfo = userInfo
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
    } catch (err) {
      console.error('登录失败', err)
    }
  },

  initUserCaches() {
    vocabStorage.initForActiveUser()
    resourceStorage.initForActiveUser()
  },

  globalData: {
    userInfo: null,
    openid: '',
    isLoggedIn: false,
    currentWordId: null
  }
})
