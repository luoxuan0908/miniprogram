const cloud = require('../../utils/cloud')
const resourceStorage = require('../../utils/resource-storage')

const SUPPORTED_EXTENSIONS = ['html', 'htm', 'txt']

Page({
  data: {
    resources: [],
    searchQuery: '',
    loading: false,
    showAddModal: false,
    resourceUrl: '',
    selectedFile: null,
    isImporting: false
  },

  onLoad(options) {
    this.loadResources()
    this.hydrateResourcesIfEmpty()
    if (options && options.add === '1') {
      this.setData({ showAddModal: true })
    }
  },

  onShow() {
    this.loadResources()
    this.hydrateResourcesIfEmpty()
  },

  loadResources() {
    const resources = resourceStorage.searchResources(this.data.searchQuery)
      .sort((a, b) => b.createdAt - a.createdAt)
    this.setData({ resources })
  },

  onSearch(e) {
    this.setData({ searchQuery: e.detail.value })
    this.loadResources()
  },

  onClearSearch() {
    this.setData({ searchQuery: '' })
    this.loadResources()
  },

  onOpenAddModal() {
    this.setData({
      showAddModal: true,
      resourceUrl: '',
      selectedFile: null
    })
  },

  async hydrateResourcesIfEmpty() {
    if (this.data.resources.length > 0) return
    try {
      const result = await resourceStorage.hydrateFromCloud()
      if (result && result.success && result.resources && result.resources.length) {
        this.loadResources()
      }
    } catch (err) {
      console.error('拉取云端资源失败', err)
    }
  },

  onCloseAddModal() {
    if (this.data.isImporting) return
    this.setData({ showAddModal: false })
  },

  noop() {},

  onUrlInput(e) {
    this.setData({
      resourceUrl: e.detail.value,
      selectedFile: null
    })
  },

  onChooseFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: SUPPORTED_EXTENSIONS,
      success: res => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) return

        const fileType = this.getFileType(file.name)
        if (!fileType) {
          wx.showToast({ title: '仅支持 HTML/TXT', icon: 'none' })
          return
        }

        this.setData({
          selectedFile: {
            name: file.name,
            path: file.path,
            size: file.size || 0,
            fileType
          },
          resourceUrl: ''
        })
      }
    })
  },

  getFileType(fileName) {
    const ext = String(fileName || '').split('.').pop().toLowerCase()
    if (ext === 'html' || ext === 'htm') return 'html'
    if (ext === 'txt') return 'txt'
    return ''
  },

  readFile(file) {
    return new Promise((resolve, reject) => {
      const fs = wx.getFileSystemManager()
      fs.readFile({
        filePath: file.path,
        encoding: 'utf8',
        success: res => resolve(res.data),
        fail: err => reject(err)
      })
    })
  },

  async onConfirmAdd() {
    if (this.data.isImporting) return

    const url = this.data.resourceUrl.trim()
    const file = this.data.selectedFile
    if (!url && !file) {
      wx.showToast({ title: '请输入 URL 或选择文件', icon: 'none' })
      return
    }

    if (url && !/^https?:\/\//i.test(url)) {
      wx.showToast({ title: 'URL 需以 http 或 https 开头', icon: 'none' })
      return
    }

    if (file && file.size > 1024 * 1024) {
      wx.showToast({ title: '文件需小于 1MB', icon: 'none' })
      return
    }

    this.setData({ isImporting: true })
    wx.showLoading({ title: '导入中...', mask: true })

    try {
      let payload
      if (file) {
        const text = await this.readFile(file)
        payload = {
          sourceType: 'file',
          text,
          fileName: file.name,
          fileType: file.fileType
        }
      } else {
        payload = {
          sourceType: 'url',
          url
        }
      }

      const draft = await cloud.parseResource(payload)
      const resource = resourceStorage.addResource(draft)

      wx.hideLoading()
      this.setData({
        showAddModal: false,
        isImporting: false,
        resourceUrl: '',
        selectedFile: null
      })
      this.loadResources()
      wx.showToast({ title: '导入成功', icon: 'success' })
      setTimeout(() => {
        wx.navigateTo({ url: `/pages/resource-detail/resource-detail?id=${resource.id}` })
      }, 300)
    } catch (err) {
      wx.hideLoading()
      this.setData({ isImporting: false })
      wx.showToast({ title: err.message || '导入失败', icon: 'none', duration: 2600 })
      console.error('导入资源失败', err)
    }
  },

  onOpenResource(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/resource-detail/resource-detail?id=${id}` })
  },

  onDeleteResource(e) {
    const id = e.currentTarget.dataset.id
    const resource = resourceStorage.getResourceById(id)
    if (!resource) return

    wx.showModal({
      title: '删除资源',
      content: `确定删除 "${resource.title}"？`,
      success: res => {
        if (res.confirm) {
          resourceStorage.deleteResource(id)
          wx.showToast({ title: '已删除', icon: 'success' })
          this.loadResources()
        }
      }
    })
  }
})
