# Study Hub · 架构设计文档

> 以 `project.md` 为准，本文档与其保持同步。

---

## 1. 系统架构概览

```
┌──────────────────────────────────────────────────────────────────────────┐
│                   微信小程序前端 (WXML / WXSS / JS / WXS)                │
│                                                                          │
│  ┌──────────┐  ┌──────────────────┐  ┌──────────┐  ┌──────────┐        │
│  │ 首页 (Tab)│  │daily-session     │  │vocabulary│  │add-word  │        │
│  │ 仪表盘    │  │每日学习任务        │  │生词管理   │  │添加生词   │        │
│  └────┬─────┘  └────────┬─────────┘  └────┬─────┘  └────┬─────┘        │
│       │                 │                  │              │              │
│  ┌────┴────────┐  ┌────┴────────┐  ┌──────┴───────┐     │              │
│  │resources    │  │resource-    │  │word-detail   │     │              │
│  │文档资源列表  │  │detail       │  │单词详情+录音  │     │              │
│  └────┬────────┘  │文档详情+播放 │  └──────────────┘     │              │
│       │           └────┬────────┘                       │              │
│  ┌────┴────────────────┴────────────────────────────────┴──────┐       │
│  │   TabBar: 首页 / 我的(review)                                 │       │
│  └──────────────────────────┬──────────────────────────────────┘       │
│                             │                                          │
│  ┌──────────────────────────┴──────────────────────────────────┐       │
│  │  utils/:                                                     │       │
│  │  storage.js (vocab L1→L2→L3)   resource-storage.js (doc L1→L2→L3)   │
│  │  user-storage.js (用户隔离+偏好+资料)  cloud.js (云函数封装)         │
│  │  audio-manager.js (单例播放+iOS兼容+语速)  tts-preferences.js        │
│  │  phonetic.js (音标管理)  constants.js (常量+算法)  format.wxs        │
│  └──────────────────────────┬──────────────────────────────────┘       │
└─────────────────────────────┼──────────────────────────────────────────┘
                              │ wx.cloud.callFunction()

┌─────────────────────────────▼──────────────────────────────────────────┐
│                      微信云函数 (Node.js)                                │
│                                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────────┐       │
│  │  login   │  │generateContent│  │   tts    │  │parseResource │       │
│  │ openid   │  │ DeepSeek词汇  │  │Qwen3-    │  │ URL抓取+分段 │       │
│  │ 鉴权      │  │ 内容+音标     │  │TTS-Flash │  │ +图片提取     │       │
│  └──────────┘  └───────┬──────┘  └────┬────┘  └──────┬───────┘       │
│                          │              │              │                │
│  ┌──────────────────┐  ┌┴──────────────┴┐  ┌──────────┴──────────┐   │
│  │translateSegment  │  │   syncData     │  │generateResource-    │   │
│  │ DeepSeek翻译      │  │ 双向数据同步    │  │StudyPack            │   │
│  │ 单段/批量(max12)  │  │ push/pull/删除  │  │ DeepSeek精读任务     │   │
│  └───────┬──────────┘  └───────┬────────┘  └─────────────────────┘   │
│          │                     │                                       │
└──────────┼─────────────────────┼───────────────────────────────────────┘
           │                     │
    ┌──────▼──────┐     ┌───────▼────────┐
    │ DeepSeek API│     │  云数据库        │
    │ 内容生成     │     │  words          │
    │ 逐段翻译     │     │  resources      │
    │ 精读任务     │     │  preferences    │
    └─────────────┘     │  userProfiles   │
                        └─────────────────┘
```

### 数据流向

```
读: L1(内存,~0ms) → L2(Storage,~1ms) → L3(云数据库,~100ms) → 回填上层
写: L1(立即) → L2(同步) → L3(异步 debounce 3s)
删: L1(立即) → L2(同步) → L3(异步 debounce 3s)
```

---

## 2. 技术选型

| 层级 | 选型 | 说明 |
|------|------|------|
| 前端框架 | 微信原生 (WXML + WXSS + JS + WXS) | 无额外框架依赖 |
| 云开发 | wx.cloud | 微信云开发基础库 2.x+ |
| 云函数运行时 | Node.js | 代理 API 调用，保护密钥 |
| HTTP 请求 | 云函数内 `https` 模块 | 调用 DeepSeek / DashScope |
| 本地存储 | wx.Storage + 用户命名空间 `u:{openid}:*` | 三层缓存 (L1内存 / L2分区Storage / L3云数据库) |
| 云端存储 | 云数据库 (4 集合) + 云存储 (音频/头像) | 双向增量同步 |
| 音频播放 | `wx.createInnerAudioContext`（原生） | 支持 playbackRate 0.5x–2.0x |
| 账号体系 | `wx.login()` + 云函数 login | 基于 openid，纯静默登录 |
| 内容生成 | DeepSeek API (deepseek-chat) | 词汇结构化 + 文档翻译 + 精读任务 |
| 语音合成 | 阿里云百炼 qwen3-tts-flash | 5 种可选音色，成本 0.8 元/万字符 |
| 音标补全 | DeepSeek → 本地内置 → Dictionary API | 三级兜底策略 |

---

## 3. 完整文件列表

### 3.1 小程序前端

```
miniprogram/
├── app.js                              # App 生命周期 + 云开发初始化 + 登录
├── app.json                            # 全局配置 (8页面/2Tab/1组件)
├── app.wxss                            # 全局样式 (CSS变量/布局/按钮/卡片)
├── sitemap.json                        # 微信搜索索引
├── images/                             # TabBar 图标
│   ├── tab-words.png
│   ├── tab-words-active.png
│   ├── tab-review.png
│   └── tab-review-active.png
├── utils/
│   ├── constants.js                    # 常量 + 艾宾浩斯算法 + Prompt
│   ├── storage.js                      # 生词三层缓存 (L1/L2/L3)
│   ├── resource-storage.js             # 资源三层缓存
│   ├── user-storage.js                 # 用户隔离 + 偏好 + 资料
│   ├── cloud.js                        # 云函数统一调用
│   ├── audio-manager.js                # 单例音频播放 + iOS 兼容
│   ├── tts-preferences.js             # TTS 语速/音色偏好
│   ├── phonetic.js                     # 音标管理 (本地+远程)
│   └── format.wxs                      # WXML 模板格式化
├── components/
│   └── word-card/
│       ├── word-card.js
│       ├── word-card.json
│       ├── word-card.wxml
│       └── word-card.wxss
└── pages/
    ├── index/                          # 🏠 Tab1 - Home 仪表盘
    ├── review/                         # 👤 Tab2 - 我的
    ├── daily-session/                  # 📋 每日学习任务
    ├── resources/                      # 📄 文档资源列表
    ├── resource-detail/                # 📖 文档详情 + 播放
    ├── vocabulary/                     # 📝 生词管理
    ├── add-word/                       # ➕ 添加生词
    └── word-detail/                    # 🔍 单词详情 + 录音
```

### 3.2 云函数

```
cloudfunctions/
├── login/                              # 登录鉴权 → openid
│   ├── index.js
│   └── package.json
├── generateContent/                     # DeepSeek 词汇内容 + 音标生成
│   ├── index.js
│   └── package.json
├── tts/                                # Qwen3-TTS-Flash 音频生成
│   ├── index.js
│   └── package.json
├── parseResource/                      # URL抓取 + HTML清洗 + 分段 + 图片提取
│   ├── index.js
│   └── package.json
├── translateSegment/                   # DeepSeek 逐段翻译 (单段/批量≤12)
│   ├── index.js
│   └── package.json
├── syncData/                           # words/resources/preferences 双向同步
│   ├── index.js
│   └── package.json
└── generateResourceStudyPack/          # DeepSeek 精读任务生成
    ├── index.js
    └── package.json
```

---

## 4. 数据模型

### 4.1 Word（生词）

```javascript
Word {
  id:       string          // 32-bit 唯一标识
  word:     string          // 单词/短语原文
  ownerId:  string          // 归属用户 openid
  status:   'new' | 'learning' | 'mastered'
  reviewLevel: number       // 艾宾浩斯复习等级 0-7

  content: {
    phonetic:        string   // IPA 音标
    stressHint:      string   // 重音提示
    shortDefinition: string   // 英文短释义 (≤15词)
    chineseHint:     string   // 中文提示 (≤10字)
    examples:        string[] // 自然例句
    clozeExample:    string   // 挖空例句
    collocations:    string[] // 常见搭配
    rootAffix:       string   // 词根词缀分析
    synonyms:        string[] // 近义词
    antonyms:        string[] // 反义词
    memoryTip:       string   // 记忆提示/联想
    difficulty:      number   // 1-5 难度评级
    exampleTranslations: string[] // 例句中文翻译(按需)
  }

  audio: {
    wordAudio:     string       // cloud:// 单词发音
    clozeAudio:    string       // cloud:// 挖空例句
    fullAudio:     string       // cloud:// 完整例句
    exampleAudios: string[]     // 逐例句音频
  }

  pronunciationRecords: [{     // 用户录音记录
    id, fileID, duration, createdAt, word, source
  }]

  skillStats: {                // 分技能统计
    recognition: { correctCount, totalAttempts, lastPracticedAt }
    dictation:    { correctCount, totalAttempts, lastPracticedAt }
    recall:       { correctCount, totalAttempts, lastPracticedAt }
    context:      { correctCount, totalAttempts, lastPracticedAt }
  }

  mistakes: [{                 // 错题记录
    mode, answer, expected, reason, createdAt
  }]

  stats: {
    correctCount:  number
    totalAttempts: number
    lastReviewed:  number
    nextReview:    number      // Infinity 表示永久掌握
  }

  createdAt: number
  updatedAt: number
}
```

### 4.2 Resource（学习资源/文档）

```javascript
Resource {
  id:            string
  type:          'document'
  ownerId:       string
  title:         string
  sourceType:    'url' | 'file' | 'text'
  sourceUrl:     string
  fileName:      string
  fileType:      'html' | 'txt'
  format:        string
  images:        Image[]
  segments:      Segment[]      // ≤80 段
  studyPack:     StudyPack | null
  summary:       string
  createdAt:     number
  updatedAt:     number
  lastOpenedAt:  number
}

Segment {
  index, text, translation, audioFileID, audioStatus,
  audioVoice, imagesBefore, imagesAfter, duration, lastPlayedAt
}

Image { index, src, alt }

StudyPack {
  keyWords, hardSentences, dictationSentences,
  segmentSummaries, generatedAt
}
```

### 4.3 Preferences（用户偏好）

```javascript
Preferences {
  ttsSpeed:   number        // 50-200, 默认 100
  ttsVoice:   string        // Cherry | Serena | Ethan | Moon | Chelsie
  updatedAt:  number
}
```

### 4.4 UserProfile（用户资料）

```javascript
UserProfile {
  _id:        string         // openid
  nickName:   string
  avatarUrl:  string         // cloud:// 头像
  updatedAt:  ServerDate
}
```

---

## 5. 工具模块接口

### 5.1 storage.js（生词存储 · 三层缓存）

```javascript
// CRUD
getAllWords()                    → Word[]
getWordById(id)                  → Word | null
addWord(wordData)                → Word
updateWord(id, updates)          → Word
deleteWord(id)                   → void

// 查询
getDueWords()                    → Word[]
searchWords(query)               → Word[]
getStats()                       → { total, mastered, learning, due }
getRecentRecords(limit)          → Array
mixNewWords(words, count)        → Word[]

// 复习
recordReviewResult(id, isCorrect)   → Word
recordSkillPractice(id, mode, isCorrect) → Word

// 录音
addPronunciationRecord(id, record)   → void
deletePronunciationRecord(id, recordId) → void

// 同步
initForActiveUser(openid)            → Promise
hydrateFromCloud()                   → Promise
flushPendingSync()                   → Promise
```

### 5.2 resource-storage.js（资源存储 · 三层缓存）

```javascript
getAllResources()                → Resource[]
getResourceById(id)              → Resource | null
addResource(resourceData)        → Resource
updateResource(id, updates)      → Resource
deleteResource(id)               → void
updateSegment(resourceId, segIndex, updates) → void
searchResources(query)           → Resource[]
getRecentResources(limit)       → Resource[]
markOpened(id)                  → void
getStats()                      → { total }
clearAllAudioReferences(id)     → void
initForActiveUser(openid)       → Promise
hydrateFromCloud()              → Promise
flushPendingSync()              → Promise
```

### 5.3 cloud.js（云函数调用封装）

```javascript
login()                              → Promise<openid>
generateContent(word)                → Promise<Content>
generatePhonetic(word)               → Promise<phonetic>
generatePronunciation(word)         → Promise<phonetic>
synthesizeSpeech(text, voice)       → Promise<cloud://fileID>
parseResource(options)               → Promise<Resource>
translateText(text, context)         → Promise<translation>
translateTexts(segments)             → Promise<translations[]>
generateResourceStudyPack(resource)  → Promise<StudyPack>
uploadPronunciationRecording(data)   → Promise<fileID>
deleteCloudFiles(fileIDs)            → Promise
syncToCloud(data)                    → Promise
synthesizeAllAudio(segments, voice)  → Promise
```

### 5.4 audio-manager.js（音频播放 · 单例）

```javascript
playAudio(fileID)                → Promise<void>   // 播放音频
pauseAudio()                     → void
resumeAudio()                    → void
stopAudio()                      → void
seekAudio(position)              → void
preloadAudio(fileIDs[])          → Promise<void>   // 预加载
destroyAudio()                   → void
refreshPlaybackRate()            → void            // 重新应用语速
```

**iOS 兼容要点**：
- 不使用 `useWebAudioImplement: true`，原生实现
- `src` → `onCanplay` → `play`（避免有进度条无声音）
- `playbackRate` 在 `onCanplay` / `tryStartPlayback` / `onPlay` / `resumeAudio` 四个时机修复
- `cloud://` 转换：优先 `downloadFile`，fail 后 fallback `getTempFileURL`
- 800ms 兜底 play + 15s 超时 reject
- `playRequestId` 竞态处理，`suppressNextStopEvent` 防状态错乱

### 5.5 user-storage.js（用户隔离 + 偏好 + 资料）

```javascript
// 用户隔离
initUserNamespace(openid)        → void
claimAnonymousData(openid)       → Promise

// 偏好
getPreferences()                 → Preferences
savePreferences(prefs)           → void

// 资料
getUserProfile()                 → UserProfile
saveUserProfile(data)            → void
loadUserProfileFromCloud()       → Promise
uploadAvatar(filePath)           → Promise<cloud://fileID>
```

---

## 6. 核心交互流程

### 6.1 每日学习（daily-session）

```
开始 → 自动生成任务列表 (到期复习≤5 + 段落听力1 + 影子跟读1 + 错题回顾1, 最多8项)
     → 遍历任务:
       单词题: recognition/dictation/recall/context 四模式轮换
       段落题: 跳转文档详情
       跟读题: 跳转单词详情
       每题 ✓/✗ + 错因 → 更新复习等级 + 记录技能统计
     → 全部完成 → 进度100% → 可重置
```

### 6.2 文档学习

```
导入 (URL/粘贴/文件, HTML/TXT ≤1MB)
  → parseResource: 抓取/读取 → HTML清洗 → 图片提取 → 分段 (≤80段, ≤2万字, 不翻译)
  → 文档详情页: 段落列表 + 图片
  → 点击段落 → 播放 (缺音频即时生成, 预加载后2段)
  → 播放时预加载翻译
  → 点击翻译按钮 → 按需翻译 (DeepSeek)
  → 精读任务生成 → 关键词/难句/听写/段大意
  → 一键加入生词本
```

### 6.3 词汇学习

```
添加生词 → DeepSeek 生成结构化内容 + 音标 (三级兜底)
         → Qwen3-TTS-Flash 生成音频
         → 多模式练习 (识别/听写/回忆/语境)
         → 艾宾浩斯复习调度
         → 录音跟读 + 上传云存储
         → 数据同步 (L1→L2→L3)
```

---

## 7. 三层缓存架构

### L1: 内存缓存（~0ms）
- `storage.js` 维护内存 `Map<id, word>` + `index[]`
- `resource-storage.js` 相同模式
- 页面读取全走内存，O(1) 查找

### L2: 分区 Storage（~1ms）
- 拆分为 `vocab_index` + `vocab_{id}` 独立键
- 增量写：改一个词只写 `vocab_{id}` + 更新索引
- 通过 `u:{openid}:*` 命名空间实现用户隔离

### L3: 云数据库（~100ms）
- Source of truth，启动时自动 `hydrateFromCloud`
- 写操作 debounce 3s 后异步同步
- 拉取后增量合并（按 `updatedAt` 取最新）

---

## 8. 艾宾浩斯复习算法

| Level | 间隔 | 状态 |
|-------|------|------|
| 0 | 1 天 | new |
| 1 | 2 天 | learning |
| 2 | 4 天 | learning |
| 3 | 7 天 | learning |
| 4 | 15 天 | learning |
| 5 | 30 天 | learning |
| 6 | 90 天 | mastered |
| 7 | ∞ | mastered（永久掌握） |

```
✅ 答对: reviewLevel=min(level+1, 7), nextReview=now+间隔[level]
❌ 答错: reviewLevel=0,            nextReview=now+1天
```

---

## 9. 共享知识约定

### 命名规范
- 文件名：kebab-case (`word-detail`, `audio-manager`)
- JS 变量/函数：camelCase (`getAllWords`, `reviewLevel`)
- 常量：UPPER_SNAKE_CASE (`WORD_STATUS`, `MAX_REVIEW_LEVEL`)
- 页面路径：`pages/xxx/xxx`
- 组件路径：`components/xxx/xxx`
- Storage 命名空间：`u:{openid}:*`

### 数据流约定
- 三层缓存架构：L1内存 → L2分区Storage → L3云数据库
- 页面 data 从 storage 读取，不直接操作 Storage
- 修改数据通过 `storage.updateWord()` / `resource-storage.updateResource()` 统一入口
- 音频 fileID 格式为 `cloud://xxx`
- 云端数据通过 `_openid` 字段隔离

### 组件通信
- 父→子：properties 传递数据
- 子→父：triggerEvent 触发事件
- 组件不直接操作 storage

---

## 10. 环境配置

| 配置项 | 位置 | 说明 |
|--------|------|------|
| `appid` | `project.config.json` | `wx8e5a63421b0d4727` |
| `env-id` | `app.js` → `wx.cloud.init()` | `cloud1-d9g82wxrn9260a87b` |
| `DEEPSEEK_API_KEY` | 云函数环境变量 ×3 | generateContent / translateSegment / generateResourceStudyPack |
| `DASHSCOPE_API_KEY` | 云函数环境变量 ×1 | tts |

### 部署注意事项
- 云函数环境变量需在「云开发控制台 → 云函数 → 函数配置 → 环境变量」配置
- 云函数执行超时需设为 30 秒（默认 3 秒不够 API 调用）
- 部署云函数必须选「上传并部署：云端安装依赖」
- 云数据库需手动创建集合：words、resources、preferences、userProfiles

---

## 11. 已知限制

- TabBar 图标为占位 PNG
- 音频管理器单例，不支持多实例同时播放
- TTS 调用间需 1s 延时避免 429 限流
- 云函数环境变量通过云开发控制台 UI 配置
- 文档解析最大 20000 字符，最多 80 段，文件 ≤1MB
- 精读任务仅分析前 12 段
- 批量翻译最多 12 段
- 个人主体小程序无法获取手机号，采用纯静默登录
