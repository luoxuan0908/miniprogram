# 听力优先生词系统 · 架构设计文档

## 1. 系统架构概览

```
┌──────────────────────────────────────────────────────────────────┐
│                     展示层 (View Layer)                           │
│  5 页面 + 2 组件 =                                              │
│  index / add-word / word-detail / listen / review               │
│  word-card 组件 / cloze-player 组件                              │
│  WXML + WXSS + JS (Page/Component)                              │
├──────────────────────────────────────────────────────────────────┤
│                     业务逻辑层 (Logic Layer)                      │
│  utils/                                                         │
│  ├── constants.js    常量 + 艾宾浩斯算法 + DeepSeek Prompt       │
│  ├── storage.js      本地存储 CRUD 封装                          │
│  ├── cloud.js        云函数调用封装                              │
│  └── audio-manager.js  音频播放/缓存管理                         │
├──────────────────────────────────────────────────────────────────┤
│                     数据层 (Data Layer)                           │
│  wx.Storage (本地)  +  云数据库 (云端)  +  云存储 (音频文件)     │
├──────────────────────────────────────────────────────────────────┤
│                     服务层 (Service Layer)                        │
│  云函数: login / generateContent / tts / syncData                │
│  外部 API: DeepSeek / 阿里云 DashScope (CosyVoice)               │
└──────────────────────────────────────────────────────────────────┘
```

### 数据流向

```
用户输入 → Page JS → cloud.js → 云函数 → 外部API
                                      ↓
                              wx.Storage ← JSON响应
                                      ↓
                              页面渲染 ← 数据绑定
```

---

## 2. 技术选型确认

| 层级 | 选型 | 版本/说明 |
|------|------|----------|
| 前端框架 | 微信原生 | WXML + WXSS + JavaScript (ES6+) |
| 云开发 | wx.cloud | 微信云开发基础库 2.x+ |
| 云函数运行时 | Node.js | 云函数默认环境 |
| HTTP 请求 | 云函数内 `https` 模块 | 调用 DeepSeek / DashScope |
| 本地存储 | `wx.Storage` | 同步 API (getStorageSync/setStorageSync) |
| 音频播放 | `wx.createInnerAudioContext` | 小程序原生接口 |
| DeepSeek | `deepseek-chat` 模型 | `api.deepseek.com/v1` |
| CosyVoice | `cosyvoice-v3.5-plus` | `dashscope.aliyuncs.com` |

---

## 3. 完整文件列表

### 3.1 小程序前端文件

```
miniprogram/
├── app.js                              ✅ 已有
├── app.json                            ✅ 已有
├── app.wxss                            🆕 全局样式
├── sitemap.json                        🆕
├── images/                             🆕 TabBar 图标(占位)
│   ├── tab-words.png
│   ├── tab-words-active.png
│   ├── tab-listen.png
│   ├── tab-listen-active.png
│   ├── tab-review.png
│   └── tab-review-active.png
├── utils/
│   ├── constants.js                    ✅ 已有
│   ├── storage.js                      🆕 本地存储CRUD
│   ├── cloud.js                        🆕 云函数调用封装
│   └── audio-manager.js                🆕 音频管理
├── components/
│   ├── word-card/
│   │   ├── word-card.js                🆕
│   │   ├── word-card.json              🆕
│   │   ├── word-card.wxml              🆕
│   │   └── word-card.wxss              🆕
│   └── cloze-player/
│       ├── cloze-player.js             🆕
│       ├── cloze-player.json           🆕
│       ├── cloze-player.wxml           🆕
│       └── cloze-player.wxss           🆕
└── pages/
    ├── index/
    │   ├── index.js                    🆕
    │   ├── index.json                  🆕
    │   ├── index.wxml                  🆕
    │   └── index.wxss                  🆕
    ├── add-word/
    │   ├── add-word.js                 🆕
    │   ├── add-word.json               🆕
    │   ├── add-word.wxml               🆕
    │   └── add-word.wxss               🆕
    ├── word-detail/
    │   ├── word-detail.js              🆕
    │   ├── word-detail.json            🆕
    │   ├── word-detail.wxml            🆕
    │   └── word-detail.wxss            🆕
    ├── listen/
    │   ├── listen.js                   🆕
    │   ├── listen.json                 🆕
    │   ├── listen.wxml                 🆕
    │   └── listen.wxss                 🆕
    └── review/
        ├── review.js                   🆕
        ├── review.json                 🆕
        ├── review.wxml                 🆕
        └── review.wxss                 🆕
```

### 3.2 云函数文件

```
cloudfunctions/
├── login/
│   ├── index.js                        🆕
│   └── package.json                    🆕
├── generateContent/
│   ├── index.js                        🆕
│   └── package.json                    🆕
├── tts/
│   ├── index.js                        🆕
│   └── package.json                    🆕
└── syncData/
    ├── index.js                        🆕
    └── package.json                    🆕
```

**总计**：约 42 个文件需创建，3 个已有。

---

## 4. 各模块数据结构与接口

### 4.1 数据模型 (Word)

```javascript
Word = {
  id: String,              // Date.now().toString(36) + random
  word: String,
  status: 'new' | 'learning' | 'mastered',
  reviewLevel: Number,     // 0-7
  content: {
    shortDefinition: String,
    chineseHint: String,
    examples: String[],
    clozeExample: String,
    collocations: String[],
    rootAffix: String,
    synonyms: String[],
    antonyms: String[],
    memoryTip: String,
    difficulty: Number     // 1-5
  },
  audio: {
    wordAudio: String,     // cloud:// fileID
    clozeAudio: String,
    fullAudio: String
  },
  stats: {
    correctCount: Number,
    totalAttempts: Number,
    lastReviewed: Number,  // timestamp
    nextReview: Number     // timestamp
  },
  createdAt: Number,
  updatedAt: Number
}
```

### 4.2 storage.js 接口

```javascript
// CRUD 操作
getAllWords()           → Word[]
getWordById(id)         → Word | null
addWord(wordData)       → Word
updateWord(id, updates) → Word
deleteWord(id)          → void

// 查询
getDueWords()           → Word[]   // 到期待复习
getWordsByStatus(s)     → Word[]
searchWords(query)      → Word[]
getStats()              → { total, mastered, learning, due }

// 复习
recordReviewResult(id, isCorrect) → Word
```

### 4.3 cloud.js 接口

```javascript
generateContent(word)   → Promise<Content>  // 调用 generateContent 云函数
synthesizeSpeech(text)  → Promise<String>   // 调用 tts 云函数，返回 cloud://fileID
syncToCloud(words)      → Promise<void>     // 调用 syncData 云函数
login()                 → Promise<String>   // 调用 login 云函数，返回 openid
```

### 4.4 audio-manager.js 接口

```javascript
playAudio(fileID)       → Promise<void>   // 播放音频
stopAudio()             → void
pauseAudio()            → void
resumeAudio()           → void
preloadAudio(fileIDs[]) → Promise<void>   // 预加载
getAudioState()         → 'playing'|'paused'|'stopped'
```

---

## 5. 页面数据结构

### 5.1 index (生词列表)

```javascript
data: {
  words: Word[],           // 当前显示的生词列表
  allWords: Word[],        // 全部生词（用于筛选）
  activeTab: 'all',        // 'all'|'new'|'learning'|'mastered'
  searchQuery: '',
  showFAB: true
}
```

### 5.2 add-word (添加生词)

```javascript
data: {
  inputWord: '',
  isGenerating: false,
  generatedContent: null,   // Content 对象
  errorMsg: ''
}
```

### 5.3 word-detail (单词详情)

```javascript
data: {
  word: Word,
  expandedSections: {
    // 控制各卡片折叠状态
    definition: true,
    examples: false,
    collocations: false,
    rootAffix: false,
    synonyms: false,
    memoryTip: false
  }
}
```

### 5.4 listen (听力训练)

```javascript
data: {
  queue: Word[],            // 本轮待复习队列
  currentIndex: Number,     // 当前索引
  currentWord: Word,        // 当前单词
  phase: 'playing'|'guessing'|'revealed'|'result',
  // playing: 播放挖空句
  // guessing: 等待用户输入
  // revealed: 已揭晓答案
  // result: 已判断对错
  userInput: '',
  showChineseHint: false,
  sessionStats: {
    correct: Number,
    incorrect: Number,
    total: Number
  },
  isSessionComplete: false
}
```

### 5.5 review (复习管理)

```javascript
data: {
  stats: {
    total: Number,
    mastered: Number,
    learning: Number,
    due: Number
  },
  dueWords: Word[],
  recentRecords: [{ word, result, time }]
}
```

---

## 6. 核心流程

### 6.1 添加生词流程

```
用户输入单词 → 点击"生成内容"
  → cloud.generateContent(word)
  → 云函数 POST DeepSeek API
  → 返回结构化 JSON
  → 页面展示预览
  → 用户确认 → storage.addWord()
  → 可选：调用 tts 生成音频
  → storage.updateWord(id, { audio })
  → 跳转回列表
```

### 6.2 听力训练流程

```
进入页面 → storage.getDueWords() → 构建队列
  → 遍历队列:
    1. 显示进度
    2. 播放 clozeAudio (挖空句)
    3. 显示中文提示(可选)
    4. 用户输入猜测
    5. 揭晓: 显示单词 + 播放 fullAudio
    6. 用户判断对错:
       ✓ → handleCorrect → reviewLevel+1
       ✗ → handleIncorrect → reviewLevel=0
    7. storage.updateWord() 更新复习状态
    8. 下一个
  → 队列空 → 显示本轮统计
```

---

## 7. 有序任务列表

按依赖关系排列，数字越小越先实现：

| # | 任务 | 文件 | 依赖 |
|---|------|------|------|
| T1 | 全局样式 + sitemap | `app.wxss`, `sitemap.json` | 无 |
| T2 | 本地存储模块 | `utils/storage.js` | 无 |
| T3 | 云函数调用模块 | `utils/cloud.js` | 无 |
| T4 | 音频管理模块 | `utils/audio-manager.js` | T3 |
| T5 | login 云函数 | `cloudfunctions/login/` | 无 |
| T6 | generateContent 云函数 | `cloudfunctions/generateContent/` | 无 |
| T7 | tts 云函数 | `cloudfunctions/tts/` | 无 |
| T8 | syncData 云函数 | `cloudfunctions/syncData/` | 无 |
| T9 | word-card 组件 | `components/word-card/` | T1, T2 |
| T10 | cloze-player 组件 | `components/cloze-player/` | T4 |
| T11 | 生词列表页 | `pages/index/` | T2, T9 |
| T12 | 添加生词页 | `pages/add-word/` | T2, T3, T6 |
| T13 | 单词详情页 | `pages/word-detail/` | T2, T4 |
| T14 | 听力训练页 | `pages/listen/` | T2, T4, T10 |
| T15 | 复习管理页 | `pages/review/` | T2 |
| T16 | TabBar 图标占位 | `images/*.png` | T11, T14, T15 |

---

## 8. 云函数依赖包

### login/package.json
```json
{ "dependencies": { "wx-server-sdk": "latest" } }
```

### generateContent/package.json
```json
{ "dependencies": { "wx-server-sdk": "latest" } }
```

### tts/package.json
```json
{ "dependencies": { "wx-server-sdk": "latest" } }
```

### syncData/package.json
```json
{ "dependencies": { "wx-server-sdk": "latest" } }
```

---

## 9. 共享知识约定

### 命名规范
- 文件名：kebab-case (`word-detail`, `audio-manager`)
- JS 变量/函数：camelCase (`getAllWords`, `reviewLevel`)
- 常量：UPPER_SNAKE_CASE (`WORD_STATUS`, `MAX_REVIEW_LEVEL`)
- 页面路径：`pages/xxx/xxx`
- 组件路径：`components/xxx/xxx`

### 常量引用
- 所有常量从 `utils/constants.js` 统一引入
- 状态值必须使用 `WORD_STATUS.NEW/LEARNING/MASTERED`
- 复习间隔使用 `EBINGHAUS_INTERVALS[index]`
- 复习算法使用 `calcNextReview`/`handleCorrect`/`handleIncorrect`

### 数据流约定
- 所有生词数据以 `wx.Storage` 为单一数据源
- 页面 data 从 storage 读取，不直接操作 Storage
- 修改数据通过 `storage.updateWord()` 统一入口
- 音频 fileID 格式为 `cloud://xxx`

### 组件通信
- 父→子：properties 传递数据
- 子→父：triggerEvent 触发事件
- 组件不直接操作 storage

---

## 10. 待明确事项

1. **音频生成时机**：建议在添加生词时立即生成单词+例句音频（异步），听力模式中如缺失则按需生成
2. **每日复习上限**：建议默认每次最多 20 个词，可在设置中调整
3. **云函数 API Key**：`DEEPSEEK_API_KEY` 和 `DASHSCOPE_API_KEY` 需在云函数环境变量中配置
