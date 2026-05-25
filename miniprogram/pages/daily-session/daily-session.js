const vocabStorage = require('../../utils/storage')
const resourceStorage = require('../../utils/resource-storage')
const studyDuration = require('../../utils/study-duration')
const cloud = require('../../utils/cloud')
const audioManager = require('../../utils/audio-manager')

const SESSION_KEY = 'daily_learning_session'
const RESULTS_KEY = 'daily_learning_results'
const PRACTICE_MODES = ['recognition', 'dictation', 'recall', 'context']

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getModeLabel(mode) {
  const labels = {
    recognition: '识别',
    dictation: '听写',
    recall: '回忆',
    context: '语境'
  }
  return labels[mode] || labels.recognition
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 模糊匹配：支持大小写、词尾变体(-s/-es/-ed/-ing/-er/-est)、
 * 英美拼写(-ise/-ize, -our/-or, -re/-er, -ence/-ense, -l/-ll)
 */
function fuzzyMatch(answer, expected) {
  const a = (answer || '').trim().toLowerCase()
  const e = (expected || '').trim().toLowerCase()
  if (a === e) return true
  if (!a || !e) return false

  // 去除词尾常见变体后比较
  const suffixes = ['ation', 'tion', 'sion', 'ment', 'ness', 'ance', 'ence', 'ing', 'ble', 'ies', 'ied', 'ful', 'ous', 'ive', 'ing', 'ted', 'sed', 'ed', 'es', 'er', 'ly', 'st', 's']
  const stripSuffix = (word) => {
    for (const suf of suffixes) {
      if (word.endsWith(suf) && word.length > suf.length + 1) {
        return word.slice(0, -suf.length)
      }
    }
    return word
  }

  // 英美拼写归一化
  const normalize = (word) => word
    .replace(/our$/g, 'or').replace(/re$/g, 'er')
    .replace(/ise/g, 'ize').replace(/ence$/g, 'ense')
    .replace(/l{2}ed$/g, 'led').replace(/l{2}ing$/g, 'ling')

  const baseA = normalize(stripSuffix(a))
  const baseE = normalize(stripSuffix(e))
  return baseA === baseE
}

function buildWordTask(word, index, mode) {
  const content = word.content || {}
  const examples = Array.isArray(content.examples) ? content.examples : []
  const wordText = String(word.word || '')
  const lowerWord = wordText.toLowerCase()
  const example = examples.find(text => text && text.toLowerCase().includes(lowerWord)) || examples[0] || ''
  const blank = example && wordText
    ? example.replace(new RegExp(escapeRegExp(wordText), 'ig'), '____')
    : ''

  // context 模式必须有可用的挖空例句，否则降级为 recall
  let safeMode = mode || PRACTICE_MODES[index % PRACTICE_MODES.length]
  if (safeMode === 'context' && !blank) {
    safeMode = 'recall'
  }

  const titleMap = {
    recognition: '你能想起这个词吗？',
    dictation: '听写练习',
    recall: content.chineseHint || content.shortDefinition || word.word,
    context: '根据语境补全单词'
  }
  const descMap = {
    recognition: '想好后点击「显示答案」查看',
    dictation: '播放原音后拼写单词',
    recall: '看中文提示，回忆英文',
    context: blank
  }

  return {
    id: `word-${safeMode}-${word.id}`,
    type: 'word-review',
    practiceMode: safeMode,
    modeLabel: getModeLabel(safeMode),
    title: titleMap[safeMode] || word.word,
    desc: descMap[safeMode] || '到期复习',
    prompt: blank,
    expected: word.word,
    targetId: word.id
  }
}

function buildTasks() {
  const tasks = []
  const allWords = vocabStorage.getAllWords()
  const usedIds = new Set()

  // 1. 到期复习词（最高优先级）
  const dueWords = vocabStorage.getDueWords()
    .slice()
    .sort((a, b) => ((b.mistakes || []).length - (a.mistakes || []).length))
    .slice(0, 5)
  dueWords.forEach((word, index) => {
    usedIds.add(word.id)
    tasks.push(buildWordTask(word, index))
  })

  // 2. 文档片段跟读
  const shadowSegment = resourceStorage.pickShadowSegment()
  if (shadowSegment) {
    tasks.push({
      id: `segment-shadow-${shadowSegment.resourceId}-${shadowSegment.segmentIndex}`,
      type: 'segment-shadow',
      modeLabel: '跟读',
      title: `跟读片段 #${shadowSegment.segmentIndex}`,
      desc: shadowSegment.resourceTitle || '文档片段',
      prompt: shadowSegment.text,
      targetResourceId: shadowSegment.resourceId,
      targetSegmentIndex: shadowSegment.segmentIndex,
      resourceTitle: shadowSegment.resourceTitle,
      initialShadowCount: shadowSegment.shadowCount || 0,
      createdAt: Date.now()
    })
  }

  // 3. 错题回顾（排除已在到期复习中的）
  const mistakeWord = allWords
    .slice()
    .sort((a, b) => ((b.mistakes || []).length - (a.mistakes || []).length))
    .find(word => {
      if ((word.mistakes || []).length === 0) return false
      return !usedIds.has(word.id)
    })
  if (mistakeWord) {
    usedIds.add(mistakeWord.id)
    const lastMistake = (mistakeWord.mistakes || [])[mistakeWord.mistakes.length - 1] || {}
    tasks.push({
      ...buildWordTask(mistakeWord, 0, lastMistake.mode || 'recognition'),
      id: `mistake-${mistakeWord.id}`,
      type: 'mistake-review',
      desc: `回顾错因：${lastMistake.reason || '未作答'}`
    })
  }

  // 4. 补充新词（未开始复习的，即 reviewLevel 为 0 或不存在）
  const newWords = allWords
    .filter(word => !usedIds.has(word.id))
    .filter(word => !word.reviewLevel || word.reviewLevel === 0)
    .slice(0, Math.max(0, 5 - tasks.length))
  newWords.forEach((word, index) => {
    usedIds.add(word.id)
    tasks.push(buildWordTask(word, tasks.length + index))
  })

  // 5. 保底：随机已学词（reviewLevel > 0 但未到期）
  const remaining = allWords
    .filter(word => !usedIds.has(word.id))
    .filter(word => word.reviewLevel && word.reviewLevel > 0)
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.max(0, 5 - tasks.length))
  remaining.forEach((word, index) => {
    tasks.push(buildWordTask(word, tasks.length + index))
  })

  return tasks.slice(0, 8)
}

function getSession() {
  const date = todayKey()
  const existing = wx.getStorageSync(SESSION_KEY)
  if (existing && existing.date === date) return existing

  const session = {
    date,
    tasks: buildTasks(),
    completedTaskIds: [],
    durationSeconds: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  wx.setStorageSync(SESSION_KEY, session)
  return session
}

function completeTask(taskId, correct) {
  const session = getSession()
  const completedTaskIds = Array.from(new Set([...(session.completedTaskIds || []), taskId]))
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - (session.createdAt || Date.now())) / 1000))
  const nextSession = {
    ...session,
    completedTaskIds,
    durationSeconds: Math.max(session.durationSeconds || 0, elapsedSeconds),
    updatedAt: Date.now()
  }
  wx.setStorageSync(SESSION_KEY, nextSession)

  // 记录答题结果
  const results = wx.getStorageSync(RESULTS_KEY) || {}
  results[taskId] = correct
  wx.setStorageSync(RESULTS_KEY, results)

  return nextSession
}

function getSessionResults() {
  const session = getSession()
  const results = wx.getStorageSync(RESULTS_KEY) || {}
  const tasks = session.tasks || []
  let correct = 0, incorrect = 0, skipped = 0
  tasks.forEach(task => {
    if (results[task.id] === true) correct++
    else if (results[task.id] === false) incorrect++
    else skipped++
  })
  return { total: tasks.length, correct, incorrect, skipped }
}

function resetToday() {
  wx.removeStorageSync(SESSION_KEY)
  wx.removeStorageSync(RESULTS_KEY)
  return getSession()
}

Page({
  data: {
    session: null,
    currentTask: null,
    completedCount: 0,
    totalCount: 0,
    progress: 0,
    answer: '',
    mistakeReason: '未作答',
    mistakeReasons: ['拼写错误', '听音混淆', '词义误判', '未作答'],
    checkedResult: null,   // null | 'correct' | 'incorrect'
    showAnswer: false,     // recognition 模式显示答案
    isFinishing: false,    // 防止答对后重复操作
    loadedTaskId: null,    // 当前已加载的任务ID，避免 onShow 重复重置
    resultStats: null,     // 完成后的统计 { total, correct, incorrect, skipped }
    sessionDurationLabel: '<1分钟'
  },

  onLoad() {
    this.loadSession()
  },

  onShow() {
    studyDuration.startSession('daily-session')
    // 从子页面返回时：如果任务已被完成（loadedTaskId 不在未完成列表），刷新
    // 否则保持当前作答状态
    const session = getSession()
    const completed = new Set(session.completedTaskIds || [])
    if (this.data.loadedTaskId && !completed.has(this.data.loadedTaskId)) {
      if (this.completeShadowTaskIfReady(session)) return
      // 当前任务仍为未完成，不重置
      return
    }
    this.loadSession()
  },

  onHide() {
    studyDuration.stopSession('daily-session')
  },

  onUnload() {
    studyDuration.stopSession('daily-session')
  },

  loadSession() {
    const session = getSession()
    const completed = new Set(session.completedTaskIds || [])
    const currentTask = (session.tasks || []).find(task => !completed.has(task.id)) || null
    const totalCount = (session.tasks || []).length
    const completedCount = completed.size
    this.setData({
      session,
      currentTask,
      totalCount,
      completedCount,
      progress: totalCount ? Math.round((completedCount / totalCount) * 100) : 100,
      answer: '',
      mistakeReason: '未作答',
      checkedResult: null,
      showAnswer: false,
      isFinishing: false,
      loadedTaskId: currentTask ? currentTask.id : null,
      resultStats: !currentTask ? getSessionResults() : null,
      sessionDurationLabel: studyDuration.formatDuration(session.durationSeconds || 0)
    })
  },

  onAnswerInput(e) {
    this.setData({ answer: e.detail.value || '' })
  },

  getTaskSegment(task) {
    if (!task || task.type !== 'segment-shadow') return null
    const resource = resourceStorage.getResourceById(task.targetResourceId)
    if (!resource) return null
    return (resource.segments || []).find(segment => segment.index === task.targetSegmentIndex) || null
  },

  completeShadowTaskIfReady(session) {
    const task = (session.tasks || []).find(item => item.id === this.data.loadedTaskId)
    const segment = this.getTaskSegment(task)
    if (!task || !segment) return false

    const shadowCount = Number.isFinite(segment.shadowCount)
      ? segment.shadowCount
      : (segment.shadowRecords || []).length
    const completedByNewRecord = shadowCount > (task.initialShadowCount || 0)
    const completedByTimestamp = (segment.lastShadowedAt || 0) > (task.createdAt || session.createdAt || 0)
    if (!completedByNewRecord && !completedByTimestamp) return false

    completeTask(task.id, true)
    this.loadSession()
    return true
  },

  onOpenShadowTask() {
    const task = this.data.currentTask
    if (!task || task.type !== 'segment-shadow') return
    wx.navigateTo({
      url: `/pages/resource-detail/resource-detail?id=${task.targetResourceId}&shadow=${task.targetSegmentIndex}`
    })
  },

  async onPlayWordAudio() {
    const task = this.data.currentTask
    if (!task || !task.expected) return
    try {
      wx.showLoading({ title: '加载音频...', mask: true })
      const fileID = await cloud.synthesizeSpeech(task.expected, 'word')
      wx.hideLoading()
      await audioManager.playAudio(fileID)
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: '播放失败', icon: 'none' })
    }
  },

  onAnswerConfirm() {
    this.checkAnswer()
  },

  checkAnswer() {
    const task = this.data.currentTask
    if (!task) return
    const answer = (this.data.answer || '').trim()
    const expected = (task.expected || task.title || '').trim()

    // recognition 模式：不需要输入，直接显示答案让用户自评
    if (task.practiceMode === 'recognition') {
      this.setData({ showAnswer: true })
      return
    }

    // dictation / recall / context：自动比对
    if (!answer) {
      wx.showToast({ title: '请输入答案', icon: 'none' })
      return
    }

    const isCorrect = fuzzyMatch(answer, expected)
    if (isCorrect) {
      // 答对：标记状态，防重复操作
      this.setData({ checkedResult: 'correct', isFinishing: true })
      setTimeout(() => this.finishTask(task, true), 600)
    } else {
      // 答错：显示错因选择
      this.setData({ checkedResult: 'incorrect', mistakeReason: '拼写错误' })
    }
  },

  onReasonTap(e) {
    this.setData({ mistakeReason: e.currentTarget.dataset.reason || '未作答' })
  },

  onConfirmIncorrect() {
    const task = this.data.currentTask
    if (!task) return
    this.finishTask(task, false)
  },

  onMarkCorrect() {
    const task = this.data.currentTask
    if (!task) return
    this.finishTask(task, true)
  },

  finishTask(task, correct) {
    if (task.type === 'word-review' || task.type === 'mistake-review') {
      vocabStorage.recordReviewResult(task.targetId, correct)
      vocabStorage.recordSkillPractice(task.targetId, task.practiceMode || 'recognition', correct, {
        answer: this.data.answer,
        expected: task.expected || task.title,
        reason: this.data.mistakeReason
      })
    }
    completeTask(task.id, correct)
    this.loadSession()
  },

  onMarkTask(e) {
    const task = this.data.currentTask
    if (!task) return
    const correct = e.currentTarget.dataset.correct === '1'
    this.finishTask(task, correct)
  },

  onReset() {
    resetToday()
    this.loadSession()
  }
})
