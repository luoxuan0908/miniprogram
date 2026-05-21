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
    if (userInfo) {
      this.globalData.userInfo = userInfo
      this.globalData.isLoggedIn = true
      return
    }
    try {
      const res = await wx.cloud.callFunction({
        name: 'login'
      })
      this.globalData.openid = res.result.openid
      this.globalData.isLoggedIn = true
      wx.setStorageSync('openid', res.result.openid)
    } catch (err) {
      console.error('登录失败', err)
    }
  },

  globalData: {
    userInfo: null,
    openid: '',
    isLoggedIn: false,
    currentWordId: null
  }
})
