# Study Hub · Project.md

## 项目概述

面向英语学习者的微信小程序 **Study Hub**，提供双轨学习模式：

1. **词汇学习**：手动录入生词 → DeepSeek API 自动生成结构化内容 → Qwen3-TTS-Flash 生成音频 → 多模式练习（识别/听写/回忆/语境） → 艾宾浩斯复习
2. **文档学习**：导入 URL / 粘贴文本 / 本地文件（HTML/TXT） → 自动分段 + 图片提取 → 逐段按需翻译(DeepSeek) + 按需生成音频(Qwen3-TTS-Flash) → 逐段播放 + 精读任务生成

- **AppID**: `wx57a74d66c06421ad`
- **云环境**: `cloud1-d1gg8fxt120042802`
- **Git**: 已初始化，分支 `main`，初始提交 `adea6ba`

---

## 技术栈

| 层次 | 技术 | 说明 |
|------|------|------|
| 前端框架 | 微信原生 (WXML + WXSS + JavaScript + WXS) | 无额外框架依赖 |
| 后端服务 | 微信云开发 · 云函数 (Node.js) | 代理 API 调用，保护密钥 |
| 账号体系 | `wx.login()` + 云函数 login | 基于 openid 的用户标识，`user-storage.js` 做用户隔离 |
| 本地存储 | wx.Storage + 用户命名空间 `u:{openid}:*` | 三层缓存架构（L1 内存 / L2 分区 Storage / L3 云数据库） |
| 云端存储 | 云数据库 (words/resources/preferences/userProfiles) + 云存储 (音频/头像) | 双向增量同步 + 音频文件托管 |
| 内容生成 | DeepSeek API (deepseek-chat) | 词汇结构化内容 + 文档段落逐段翻译 + 精读任务生成 |
| 语音合成 | 阿里云百炼 qwen3-tts-flash | 5 种可选音色（Cherry/Serena/Ethan/Moon/Chelsie） |
| 音频播放 | `wx.createInnerAudioContext`（原生实现） | 支持 playbackRate 语速调节 0.5x–2.0x |
| 音标 | DeepSeek + 本地内置 + Dictionary API 兜底 | 三级音标补全策略 |

---

## 架构拓扑

```
┌──────────────────────────────────────────────────────────────────────────┐
│                   微信小程序前端 (WXML / WXSS / JS / WXS)                   │
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
│       │                │                                │              │
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

### API 调用流程

```
┌──────────────┐     ┌──────────────────┐     ┌───────────────┐
│ 小程序前端    │ ──→ │ 云函数            │ ──→ │ 外部服务       │
└──────────────┘     └──────────────────┘     └───────────────┘

词汇学习
  添加生词 ──→ generateContent ──→ DeepSeek API (结构化JSON + 音标)
           ──→ tts ──→ 阿里云 DashScope (单词/例句音频)
            ↓ 音标补全: AI → 本地内置 → Dictionary API 三级兜底

文档学习
  导入资源 ──→ parseResource ──→ URL 抓取 + HTML清洗 + 分段 + 图片提取
            ↓ 仅分段，无翻译，快速完成

  逐段翻译 ──→ translateSegment ──→ DeepSeek API (单击翻译/播放时自动预加载)
            ↓ 中文翻译 → 缓存到本地

  逐段音频 ──→ tts ──→ 阿里云 DashScope (按需懒加载，播放时生成)
            ↓ 预加载当前段+后2段

  精读任务 ──→ generateResourceStudyPack ──→ DeepSeek API
            ↓ 关键词/难句/听写句/段大意

每日学习
  进入首页 ──→ 读取任务列表 ──→ daily-session ──→ 多模式练习
            ↓ recognition/dictation/recall/context + 错题回顾

启动时  ──→ login ──→ 微信服务器 (code → openid)
        ──→ storage.init → hydrateFromCloud (增量拉取远程数据)

数据同步
  本地变更 ──→ dirty标记 ──→ debounce 3s ──→ syncData (push)
  手动拉取 ──→ syncData (pull) ──→ 增量合并 (按 updatedAt)
```

---

## 页面结构

```
miniprogram/pages/
├── index/                    # 🏠 Tab1 - Home 仪表盘
│   ├── 问候语 + 用户信息
│   ├── 每日学习进度 (completed/total)
│   ├── 模块入口卡片 (文档库 / 生词本)
│   ├── 最近资源列表 + 最近生词
│   └── 跳转 daily-session
│
├── review/                   # 👤 Tab2 - 我的
│   ├── 用户头像选择 + 昵称编辑 (微信原生能力)
│   ├── 统计卡片 (文档/总词汇/已掌握/学习中/今日待复习)
│   ├── TTS 语速滑块 (0.5x–2.0x)
│   ├── 数据同步 (上传/拉取，增量合并)
│   ├── 数据导出 (JSON/CSV/纯文本 → 剪贴板/分享)
│   └── 音频缓存清理
│
├── daily-session/            # 📋 每日学习任务
│   ├── 自动生成任务列表 (至多 8 项)
│   ├── 4 种练习模式轮换：识别/听写/回忆/语境
│   ├── 错题回顾 + 错因标记
│   ├── 段落听力 + 影子跟读
│   ├── 进度条 + 完成统计
│   └── 今日重置
│
├── resources/                # 📄 文档资源列表
│   ├── 搜索资源
│   ├── 导入面板 (URL / 粘贴文本 / 本地文件)
│   ├── 支持 HTML/TXT (≤1MB)
│   ├── 自动从云端拉取（列表为空时）
│   └── 删除资源
│
├── resource-detail/          # 📖 文档详情 + 逐段播放
│   ├── 段落列表 + 文内图片展示
│   ├── 逐段播放/暂停 + 底部播放面板
│   ├── 音频进度条 + 时间标签
│   ├── 中文翻译（点击展开，按需翻译）
│   ├── 音频预加载 (当前段+后2段)
│   ├── 翻译预加载 (播放时自动加载)
│   ├── 音色切换 (5 种) + 语速调节
│   ├── 精读任务生成 (关键词/难句/听写/段大意)
│   └── 一键加入生词本
│
├── vocabulary/               # 📝 生词管理
│   ├── 搜索 + 按状态筛选 (全部/新词/学习中/已掌握/待复习)
│   ├── 标签页计数显示
│   ├── 快捷标记掌握
│   ├── 云端同步
│   ├── 自动从云端拉取（列表为空时）
│   └── 浮动添加按钮
│
├── add-word/                 # ➕ 添加生词
│   ├── 输入单词 → DeepSeek 生成内容预览
│   ├── 音标自动补全（AI → 本地内置 → 字典 API）
│   ├── 保存 → 返回列表
│   └── 支持重新生成
│
└── word-detail/              # 🔍 单词详情
    ├── 单词 + 音标 + 难度星级 + 状态标签
    ├── 可折叠内容卡片（释义/例句/搭配/词根/同反义/记忆提示）
    ├── 例句翻译（点击展开，按需翻译）
    ├── 播放单词音频 + 例句音频（按需生成）
    ├── 录音跟读 + 上传云存储 + 历史录音列表
    ├── 多模式技能练习（识别/听写/回忆/语境）
    ├── 学习统计 (准确率 + 复习进度 + 分技能统计)
    ├── 切换掌握状态 / 删除
    └── 发音信息自动补全（音标 + 重音提示）
```

### TabBar 导航

| Tab | 标签 | 页面 | 图标 |
|-----|------|------|------|
| 1 | 首页 | `pages/index/index` | tab-words |
| 2 | 我的 | `pages/review/review` | tab-review |

---

## 核心交互流程

### 每日学习（daily-session）

```
                    开始
                     │
                     ▼
            ┌────────────────────┐
            │  自动生成任务列表     │
            │  ├ 到期复习词 (≤5)   │
            │  ├ 段落听力 (1)      │
            │  ├ 影子跟读 (1)      │
            │  └ 错题回顾 (1)      │
            │  最多 8 项           │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  遍历任务            │
            │                     │
            │  单词题:             │
            │  ├ recognition 看英→中│
            │  ├ dictation  听写   │
            │  ├ recall     看中→英│
            │  └ context    填空   │
            │                     │
            │  段落题:             │
            │  → 跳转文档详情      │
            │                     │
            │  跟读题:             │
            │  → 跳转单词详情      │
            │                     │
            │  每题 ✓/✗ + 错因     │
            │  → 更新复习等级      │
            │  → 记录技能统计      │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  全部完成 → 进度100% │
            │  可重置今日任务      │
            └────────────────────┘
```

### 文档学习

```
                    开始
                     │
                     ▼
            ┌────────────────────┐
            │  导入 3 种方式       │
            │  URL / 粘贴 / 文件  │
            │  (HTML/TXT ≤1MB)   │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  parseResource     │
            │  抓取/读取 → HTML清洗│
            │  → 图片提取 → 分段  │
            │  (≤80段, ≤2万字)   │
            │  (不翻译, 秒完成)   │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  文档详情页         │
            │  段落列表 + 图片     │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  点击段落 → 播放     │
            │  缺音频即时生成      │
            │  预加载后 2 段       │
            │  播放时预加载翻译    │
            └────────┬───────────┘
                     │
              ┌──────┴──────┐
              ▼             ▼
     ┌──────────────┐ ┌──────────────┐
     │ 点击翻译按钮  │ │ 精读任务生成   │
     │ 按需翻译     │ │ 关键词+难句+   │
     │ (DeepSeek)   │ │ 听写+段大意    │
     └──────────────┘ └──────┬───────┘
                             │
                             ▼
                    一键加入生词本
```

---

## 数据模型

### Word（生词）

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

### Resource（学习资源/文档）

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
  format:        string         // 同 fileType
  images:        Image[]        // 文内图片
  segments:      Segment[]      // 分段内容 (≤80)
  studyPack:     StudyPack | null  // 精读任务(AI生成)
  summary:       string         // 首段摘要
  createdAt:     number
  updatedAt:     number
  lastOpenedAt:  number
}

Segment {
  index:         number         // 1-based
  text:          string         // 英文原文
  translation:   string         // 中文翻译(按需)
  audioFileID:   string         // cloud:// 音频
  audioStatus:   'idle' | 'generating' | 'ready' | 'error'
  audioVoice:    string         // 音色标识
  imagesBefore:  Image[]        // 段落前图片
  imagesAfter:   Image[]        // 段落后图片
  duration:      number         // 音频时长(秒)
  lastPlayedAt:  number
}

Image {
  index: number
  src:   string
  alt:   string
}

StudyPack {
  keyWords:            [{ word, chineseHint, reason }]
  hardSentences:       [{ sentence, explanation }]
  dictationSentences:  [{ sentence, hint }]
  segmentSummaries:    [{ index, summary }]
  generatedAt:         number
}
```

### Preferences（用户偏好）

```javascript
Preferences {
  ttsSpeed:   number        // 50-200, 默认 100
  ttsVoice:   string        // Cherry | Serena | Ethan | Moon | Chelsie
  updatedAt:  number
}
```

### UserProfile（用户资料）

```javascript
UserProfile {
  _id:        string         // openid
  nickName:   string
  avatarUrl:  string         // cloud:// 头像
  updatedAt:  ServerDate
}
```

---

## 艾宾浩斯复习算法

### 间隔表

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

### 算法

```
✅ 答对: reviewLevel=min(level+1, 7), nextReview=now+间隔[level]
❌ 答错: reviewLevel=0,            nextReview=now+1天
```

---

## API 集成详情

### 1. 微信登录

- **方法**: `wx.login()` → code → 云函数 `login` → `openid`
- **环境变量**: 无需额外配置（云函数内置 `WXContext`）
- **用户资料**: `userProfiles` 云数据库集合，头像存储在 `cloud://avatars/`

### 2. DeepSeek API

- **端点**: `https://api.deepseek.com/v1/chat/completions`
- **模型**: `deepseek-chat`
- **调用方**: 云函数 `generateContent`、`translateSegment`、`generateResourceStudyPack`
- **用途**:
  - 词汇结构化内容（全文 JSON）+ 音标生成（phonetic 模式）
  - 文档段落逐段翻译（单段/批量 ≤12 段）
  - 文档精读任务生成（关键词/难句/听写/段大意）
- **音标策略**: AI 生成 → 本地内置词典 → Dictionary API 免费查询 三级兜底
- **环境变量**: `DEEPSEEK_API_KEY`

### 3. 阿里云 DashScope Qwen3-TTS-Flash

- **端点**: `POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- **模型**: `qwen3-tts-flash`
- **调用方**: 云函数 `tts`
- **支持音色**: Cherry(芊悦) / Serena(苏瑶) / Ethan(晨煦) / Moon(月白) / Chelsie(千雪)
- **工作流程**: 非流式请求 → 返回音频 URL → 下载二进制 → 上传云存储 → 返回 `cloud://fileID`
- **输出格式**: mp3
- **语速控制**: 通过 `InnerAudioContext.playbackRate` 在播放端实现（0.5x–2.0x）
- **环境变量**: `DASHSCOPE_API_KEY`

### 4. 数据同步（syncData）

- **调用方**: 三层缓存自动触发（debounce 3s） + 手动触发
- **Push 模式**: 增量上传 words/resources/preferences + 删除标记
- **Pull 模式**: `{ action: 'pull', scope: 'words' | 'resources' | 'all' }` 拉取云端数据
- **隔离方式**: 所有记录通过 `_openid` 字段隔离
- **Upsert 逻辑**: 按 `id + _openid` 查询，存在则更新，不存在则新增

---

## 三层缓存架构（已实现）

### L1: 内存缓存（~0ms）
- `storage.js` 维护内存 `Map<id, word>` + `index[]` 热数据
- `resource-storage.js` 同样模式
- 页面读取全走内存，O(1) 查找

### L2: 分区 Storage（~1ms）
- 拆分为 `vocab_index` + `vocab_{id}` 独立键
- 增量写：改一个词只写 `vocab_{id}` + 更新索引
- 通过 `u:{openid}:*` 命名空间实现用户隔离

### L3: 云数据库（~100ms）
- Source of truth，启动时自动 hydrateFromCloud
- 写操作 debounce 3s 后异步同步
- 拉取后增量合并（按 updatedAt 取最新）

### 数据流向

```
读: L1(miss) → L2(miss) → L3 → 回填 L2 → 回填 L1
写: L1(立即) → L2(同步) → L3(异步debounce 3s)
删: L1(立即) → L2(同步) → L3(异步debounce 3s)
```

---

## 工具模块

### constants.js
- `WORD_STATUS`: 词汇状态枚举 (new/learning/mastered)
- `EBINGHAUS_INTERVALS`: 艾宾浩斯复习间隔 [1,2,4,7,15,30,90]
- `MAX_REVIEW_LEVEL`: 7
- `DIFFICULTY_LABELS`: ['','非常容易','容易','中等','较难','很难']
- `DEEPSEEK_PROMPT(word)`: 结构化生成 Prompt 模板
- `calcNextReview` / `handleCorrect` / `handleIncorrect`

### storage.js（生词存储 · 三层缓存）
- L1 内存 Map + L2 分区 Storage + L3 云数据库
- 核心方法：getAllWords, addWord, updateWord, deleteWord, getDueWords, searchWords, getStats
- recordReviewResult, recordSkillPractice, addPronunciationRecord, deletePronunciationRecord
- getRecentRecords, mixNewWords, initForActiveUser, hydrateFromCloud, flushPendingSync
- 自动脏标记 + debounce 3s 云端同步
- 旧数据迁移：从 `vocab_words` 全局键迁移到用户命名空间

### resource-storage.js（资源存储 · 三层缓存）
- 与 storage.js 相同三层架构
- 核心方法：getAllResources, addResource, updateResource, deleteResource, getResourceById
- markOpened, searchResources, getRecentResources, updateSegment, getStats
- clearAllAudioReferences, initForActiveUser, hydrateFromCloud, flushPendingSync
- 最多 80 段，支持图片元数据存储

### user-storage.js（用户隔离 + 偏好 + 资料）
- `u:{openid}:*` 命名空间隔离
- 偏好管理：getPreferences / savePreferences → debounce 3s 云同步
- 用户资料：getUserProfile / saveUserProfile / loadUserProfileFromCloud / uploadAvatar
- 旧数据迁移：从无命名空间的全局键迁移到用户命名空间
- 旧数据认领：首次登录可认领匿名用户数据

### cloud.js（云函数调用封装）
- login / generateContent / generatePhonetic / generatePronunciation
- synthesizeSpeech / parseResource / translateText / translateTexts
- generateResourceStudyPack / uploadPronunciationRecording
- deleteCloudFiles / syncToCloud / synthesizeAllAudio

### audio-manager.js（音频播放 · 单例）
- **iOS 兼容**: 不使用 useWebAudioImplement，原生实现
- **播放时序**: src → onCanplay → play → onPlay → resolve（避免 iOS 有进度条无声音）
- **cloud:// 转换**: 优先 downloadFile，fail 后 fallback getTempFileURL
- **缓存**: tempFileCache 缓存已下载的临时路径
- **语速**: applyPlaybackRate 读取 tts-preferences，设置 playbackRate
- **竞态处理**: playRequestId 标识最新请求，旧请求自动忽略
- **播放保护**: 800ms 兜底 play + 15s 超时 reject
- **stop 抑制**: suppressNextStopEvent 防手动 stop 触发状态错乱
- 方法: playAudio, pauseAudio, resumeAudio, stopAudio, seekAudio, preloadAudio, destroyAudio, refreshPlaybackRate

### tts-preferences.js（TTS 偏好管理）
- 语速范围 50–200（0.5x–2.0x），默认 100（1.0x）
- 5 种音色：Cherry(芊悦)/Serena(苏瑶)/Ethan(晨煦)/Moon(月白)/Chelsie(千雪)
- 方法：normalizeTtsSpeed, formatTtsSpeed, normalizeTtsVoice, getTtsPreferences, saveTtsPreferences

### phonetic.js（音标管理）
- 本地内置词典（常见词免 API 调用）
- normalizePhonetic: 处理各种音标格式
- getContentPhonetic: 从内容中提取音标
- ensureContentPhonetic: 确保词汇内容包含音标
- getLocalPhonetic: 查本地词典

### format.wxs（WXML 模板格式化）
- WXS 语法（JS 子集，不支持 ES6+）
- 方法：formatReviewTime, formatRelativeTime, accuracyPercent, statusLabel, isDue

---

## 项目目录

```
MiniProgram/
├── .gitignore
├── project.config.json          # 小程序项目配置
├── project.private.config.json  # 本地私有配置
├── project.md                   # 本文档
├── prd.md                       # 产品需求文档
├── architecture.md              # 架构设计文档
├── overview.md                  # 项目交付概述（已过期）
├── cloudfunctions/
│   ├── login/                   # 登录鉴权 → openid
│   ├── generateContent/         # DeepSeek 词汇内容 + 音标生成
│   ├── tts/                     # Qwen3-TTS-Flash 音频生成
│   ├── parseResource/           # URL抓取 + HTML清洗 + 分段 + 图片提取
│   ├── translateSegment/        # DeepSeek 逐段翻译（单段/批量≤12）
│   ├── syncData/                # words/resources/preferences 双向同步
│   └── generateResourceStudyPack/ # DeepSeek 精读任务生成
└── miniprogram/
    ├── app.js                   # App 生命周期 + 云开发初始化 + 登录
    ├── app.json                 # 全局配置 (8页面/2Tab/1组件)
    ├── app.wxss                 # 全局样式 (CSS变量/布局/按钮/卡片)
    ├── sitemap.json             # 微信搜索索引
    ├── images/                  # TabBar 图标 (tab-words tab-review)
    ├── utils/
    │   ├── constants.js         # 常量 + 艾宾浩斯算法 + Prompt
    │   ├── storage.js           # 生词三层缓存 (L1/L2/L3)
    │   ├── resource-storage.js  # 资源三层缓存
    │   ├── user-storage.js      # 用户隔离 + 偏好 + 资料管理
    │   ├── cloud.js             # 云函数统一调用
    │   ├── audio-manager.js     # 单例音频播放
    │   ├── tts-preferences.js   # TTS 语速/音色偏好
    │   ├── phonetic.js          # 音标管理 (本地+远程)
    │   └── format.wxs           # WXML 模板格式化
    ├── components/
    │   └── word-card/           # 单词卡片组件
    └── pages/
        ├── index/               # 🏠 Tab1 仪表盘
        ├── review/              # 👤 Tab2 我的
        ├── daily-session/       # 📋 每日学习任务
        ├── resources/           # 📄 文档资源列表
        ├── resource-detail/     # 📖 文档详情 + 播放
        ├── vocabulary/          # 📝 生词管理
        ├── add-word/            # ➕ 添加生词
        └── word-detail/         # 🔍 单词详情 + 录音
```

---

## 环境配置

| 配置项 | 位置 | 说明 |
|--------|------|------|
| `appid` | `project.config.json` / `constants.js` | `wx57a74d66c06421ad` |
| `env-id` | `constants.js` → `wx.cloud.init()` | `cloud1-d1gg8fxt120042802` |
| `DEEPSEEK_API_KEY` | 云函数环境变量 ×3 | generateContent / translateSegment / generateResourceStudyPack |
| `DASHSCOPE_API_KEY` | 云函数环境变量 ×1 | tts |

### 部署注意事项
- 云函数环境变量需在「云开发控制台 → 云函数 → 函数配置 → 环境变量」配置
- 云函数执行超时需设为 30 秒（默认 3 秒不够 API 调用）
- 部署云函数必须选「上传并部署：云端安装依赖」
- 云数据库需手动创建集合：words、resources、preferences、userProfiles

---

## iOS 音频兼容性

| 问题 | 根因 | 修复 |
|------|------|------|
| 有进度条无声音 | useWebAudioImplement: true | 移除，使用原生实现 |
| play 太早 | src 后立即 play | 改为 onCanplay 后 play |
| obeyMuteSwitch 无效 | 设置时序问题 | 创建时立即设置 |
| playbackRate 被重置 | src 设置后重置为 1.0 | 在 onCanplay、tryStartPlayback、onPlay、resumeAudio 四个时机修复 |

---

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-05-20 | 初始化 Git 仓库，初始提交 `adea6ba`（81 文件） |
| 2026-05-20 | iOS 音频修复：移除 useWebAudioImplement，onCanplay→play |
| 2026-05-20 | 语速 range 扩至 50-200，修复 playbackRate 不生效 |
| 2026-05-20 | 新增 user-storage.js，用户隔离 + 偏好云同步 |
| 2026-05-20 | login 云函数修复，app.js 添加 checkLogin |
| 2026-05-20 | Tab 标题中文化：首页/文档/生词/我的 |
| 2026-05-20 | 首页卡片可点击，生词本筛选，问候语动态化 |
| 2026-05-21 | syncData 云函数修复，支持 pull 模式 |
| 2026-05-21 | 新增 resource-storage.js 三层缓存 |
| 2026-05-21 | 「我的」页面改造：头像 + 昵称（6 文件） |
| 2026-05-21 | 新增 userProfiles 集合，头像云存储 |
| 2026-05-21 | 纯静默登录适配（无手机号能力） |
| 2026-05-21 | 新增 daily-session 页面，多模式练习 |
| 2026-05-21 | 新增 phonetic.js，三级音标补全 |
| 2026-05-21 | 新增 tts-preferences.js，5 种音色选择 |
| 2026-05-21 | resource-detail 播放/翻译按钮间距 → 48rpx |
| 2026-05-22 | 新增 generateResourceStudyPack 云函数 |
| 2026-05-22 | 数据导出支持 JSON/CSV/纯文本 + 剪贴板/分享 |
| 2026-05-22 | 新增录音跟读功能（word-detail） |
| 2026-05-22 | 新增例句翻译、范例音频（word-detail） |
| 2026-05-22 | storage.js / resource-storage.js 升级为三层缓存架构 |

---

## 已知限制

- TabBar 图标为占位 PNG
- 音频管理器单例，不支持多实例同时播放
- TTS 调用间需 1s 延时避免 429 限流
- 云函数环境变量通过云开发控制台 UI 配置
- 文档解析最大 20000 字符，最多 80 段，文件 ≤1MB
- 精读任务仅分析前 12 段
- 批量翻译最多 12 段
