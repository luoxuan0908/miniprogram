const cloud = require('../../utils/cloud')

function formatMicros(value) {
  return (Number(value || 0) / 1000000).toFixed(4)
}

function formatTime(timestamp) {
  if (!timestamp) return ''
  const d = new Date(timestamp)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hour = String(d.getHours()).padStart(2, '0')
  const minute = String(d.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hour}:${minute}`
}

function meterLabel(meter) {
  const labels = {
    input_tokens: '输入 token',
    output_tokens: '输出 token',
    cached_input_tokens: '缓存输入 token',
    tts_chars: 'TTS 字符',
    audio_input_seconds: '音频输入秒',
    audio_output_seconds: '音频输出秒',
    audio_input_tokens: '音频输入 token',
    audio_output_tokens: '音频输出 token',
    request_count: '请求数'
  }
  return labels[meter] || meter
}

function featureLabel(feature, operation) {
  const labels = {
    word_content: '单词内容生成',
    phonetic: '音标生成',
    segment_translate: '段落翻译',
    resource_study_pack: '精读包生成',
    tts: '语音合成'
  }
  return labels[feature] || labels[operation] || operation || '模型调用'
}

function formatMeters(meters) {
  const entries = Object.keys(meters || {})
    .filter(key => Number(meters[key]) > 0)
    .map(key => `${meterLabel(key)} ${meters[key]}`)
  return entries.join(' · ')
}

function formatLedgerItem(item) {
  const unpriced = item.pricingStatus === 'unpriced' || item.pendingPricing
  return {
    ...item,
    title: featureLabel(item.feature, item.operation),
    amountLabel: unpriced ? '暂未扣费' : `-¥${formatMicros(item.amountMicros)}`,
    statusLabel: unpriced ? '已记录用量，暂未扣费' : (item.usageSource === 'estimated' ? '估算计量' : '供应商计量'),
    meterLabel: formatMeters(item.meters) || '无用量',
    timeLabel: formatTime(item.createdAt),
    isUnpriced: unpriced
  }
}

function isFunctionNotFoundError(err) {
  const message = String((err && (err.errMsg || err.message)) || err || '')
  return message.includes('-501000') ||
    message.includes('FUNCTION_NOT_FOUND') ||
    message.includes('FunctionName parameter could not be found')
}

Page({
  data: {
    loading: false,
    loadingMore: false,
    errorMessage: '',
    setupHint: '',
    account: {
      balanceLabel: '0.0000',
      chargedLabel: '0.0000',
      currency: 'CNY'
    },
    ledger: [],
    offset: 0,
    hasMore: true
  },

  onLoad() {
    this.refresh()
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh())
  },

  async refresh() {
    if (this.data.loading) return
    this.setData({ loading: true, offset: 0, hasMore: true, errorMessage: '', setupHint: '' })
    try {
      const accountRes = await cloud.getBillingAccount()
      const ledgerRes = await cloud.getBillingLedger({ limit: 20, offset: 0 })
      this.setData({
        account: this.formatAccount(accountRes.account || {}),
        ledger: (ledgerRes.ledger || []).map(formatLedgerItem),
        offset: (ledgerRes.ledger || []).length,
        hasMore: (ledgerRes.ledger || []).length >= 20
      })
    } catch (err) {
      console.error('load billing failed:', err)
      const notFound = isFunctionNotFoundError(err)
      this.setData({
        errorMessage: notFound ? '计费云函数未部署' : '用量加载失败',
        setupHint: notFound ? '请在微信开发者工具中上传并部署 cloudfunctions/billing，然后下拉刷新。' : '请稍后重试或检查云开发环境。'
      })
      wx.showToast({ title: notFound ? '请先部署 billing' : '用量加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore) return
    this.setData({ loadingMore: true })
    try {
      const res = await cloud.getBillingLedger({ limit: 20, offset: this.data.offset })
      const next = (res.ledger || []).map(formatLedgerItem)
      this.setData({
        ledger: this.data.ledger.concat(next),
        offset: this.data.offset + next.length,
        hasMore: next.length >= 20
      })
    } catch (err) {
      console.error('load more billing failed:', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      this.setData({ loadingMore: false })
    }
  },

  formatAccount(account) {
    return {
      balanceLabel: formatMicros(account.balanceMicros),
      chargedLabel: formatMicros(account.chargedMicros),
      currency: account.currency || 'CNY',
      status: account.status || 'active',
      updatedLabel: formatTime(account.updatedAt)
    }
  }
})
