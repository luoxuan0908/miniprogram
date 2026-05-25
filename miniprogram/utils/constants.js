/** 单词学习状态 */
const WORD_STATUS = {
  NEW: 'new',
  LEARNING: 'learning',
  MASTERED: 'mastered'
}

/**
 * 艾宾浩斯遗忘曲线复习间隔（天）
 * Level 0: 1天  (首次学习后)
 * Level 1: 2天  (第一次复习)
 * Level 2: 4天  (第二次复习)
 * Level 3: 7天  (第三次复习)
 * Level 4: 15天 (第四次复习)
 * Level 5: 30天 (第五次复习)
 * Level 6: 90天 (第六次复习)
 * Level 7: ∞   (永久掌握)
 */
const EBINGHAUS_INTERVALS = [1, 2, 4, 7, 15, 30, 90]

/** 最大复习等级（达成后永久掌握） */
const MAX_REVIEW_LEVEL = 7

/** 难度文字标签 */
const DIFFICULTY_LABELS = ['', '非常容易', '容易', '中等', '较难', '很难']

/**
 * 根据复习等级计算下次复习时间戳
 * @param {number} reviewLevel 当前复习等级 0-7
 * @returns {number} 毫秒时间戳
 */
function calcNextReview(reviewLevel) {
  if (reviewLevel >= MAX_REVIEW_LEVEL) return Infinity
  const days = EBINGHAUS_INTERVALS[reviewLevel]
  return Date.now() + days * 24 * 60 * 60 * 1000
}

/**
 * 答对：前进一级
 * @returns {{ reviewLevel: number, nextReview: number, status: string }}
 */
function handleCorrect(reviewLevel) {
  const newLevel = Math.min(reviewLevel + 1, MAX_REVIEW_LEVEL)
  return {
    reviewLevel: newLevel,
    nextReview: calcNextReview(newLevel),
    status: newLevel >= 6 ? WORD_STATUS.MASTERED : WORD_STATUS.LEARNING
  }
}

/**
 * 答错：回归原点
 * @returns {{ reviewLevel: number, nextReview: number, status: string }}
 */
function handleIncorrect() {
  return {
    reviewLevel: 0,
    nextReview: calcNextReview(0),
    status: WORD_STATUS.LEARNING
  }
}

/** DeepSeek 生成内容的 Prompt 模板 */
const DEEPSEEK_PROMPT = (word) => `你是一位专业的英语教学专家。请为英语单词/短语"${word}"生成结构化的学习内容。

请严格按以下JSON格式返回，不要添加任何额外说明：

{
  "phonetic": "IPA音标，例如 /juːˈbɪkwɪtəs/；短语或无法确定时填空字符串",
  "shortDefinition": "简洁英文释义（不超过15词）",
  "chineseHint": "中文提示（10字以内）",
  "examples": ["自然例句1（包含目标单词）", "自然例句2（包含目标单词）"],
  "collocations": ["常见搭配1", "常见搭配2"],
  "rootAffix": "词根词缀分析，如无则填'无'",
  "synonyms": ["近义词1", "近义词2"],
  "antonyms": ["反义词1（如无则留空数组）"],
  "memoryTip": "一条有趣的记忆提示或联想方法",
  "difficulty": 3
}`

module.exports = {
  WORD_STATUS,
  EBINGHAUS_INTERVALS,
  MAX_REVIEW_LEVEL,
  DIFFICULTY_LABELS,
  DEEPSEEK_PROMPT,
  calcNextReview,
  handleCorrect,
  handleIncorrect
}
