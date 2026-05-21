const { WORD_STATUS } = require('../../utils/constants')

Component({
  properties: {
    word: {
      type: Object,
      value: null
    },
    showReviewInfo: {
      type: Boolean,
      value: true
    }
  },

  data: {
    statusLabel: '',
    stars: [1, 2, 3, 4, 5],
    reviewText: ''
  },

  observers: {
    'word.status': function(status) {
      const labels = {
        [WORD_STATUS.NEW]: '新词',
        [WORD_STATUS.LEARNING]: '学习中',
        [WORD_STATUS.MASTERED]: '已掌握'
      }
      this.setData({ statusLabel: labels[status] || '未知' })
    },
    'word.stats.nextReview': function(nextReview) {
      if (nextReview && nextReview < 9999999999999) {
        const now = Date.now()
        if (nextReview <= now) {
          this.setData({ reviewText: '待复习' })
        } else {
          const diff = nextReview - now
          const hours = Math.ceil(diff / (1000 * 60 * 60))
          if (hours < 24) {
            this.setData({ reviewText: `${hours}小时后` })
          } else {
            const days = Math.ceil(hours / 24)
            this.setData({ reviewText: `${days}天后` })
          }
        }
      } else {
        this.setData({ reviewText: '已掌握' })
      }
    }
  },

  methods: {
    onTap() {
      this.triggerEvent('tap', { word: this.properties.word })
    }
  }
})
