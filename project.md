# Study Hub · Project.md

## 项目概述

面向英语学习者的微信小程序 **Study Hub**，提供双轨学习模式：

1. **词汇学习**：手动录入生词 → DeepSeek API 自动生成结构化内容 → Qwen-TTS 生成音频 → 听挖空例句猜词 → 艾宾浩斯复习
2. **文档学习**：导入 URL 或本地 HTML/TXT 文件 → 自动分段 → 逐段按需翻译(DeepSeek) + 按需生成音频(Qwen-TTS) → 逐段播放 + 影子跟读

适合通勤等碎片化场景使用。

---

## 技术栈

| 层次 | 技术 | 说明 |
|------|------|------|
| 前端框架 | 微信原生 (WXML + WXSS + JavaScript + WXS) | 无额外框架依赖 |
| 后端服务 | 微信云开发 · 云函数 (Node.js) | 代理 API 调用，保护密钥 |
| 账号体系 | `wx.login()` + 云函数 | 基于 openid 的用户标识 |
| 本地存储 | `wx.Storage` | 离线优先，生词/资源数据本地持久化 |
| 云端存储 | 云数据库 + 云存储 | 数据同步 + 音频文件托管 |
| 内容生成 | DeepSeek API | 词汇结构化内容 + 文档段落逐段翻译 |
| 语音合成 | 阿里云百炼 Qwen-TTS | 单词/例句/文档段落音频生成 |
| 音频播放 | `wx.createInnerAudioContext` | 单例模式，支持播放/暂停/进度/预加载 |

---

## 架构拓扑

```
┌───────────────────────────────────────────────────────────────────┐
│                  微信小程序 (WXML / WXSS / JS / WXS)                │
│                                                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐             │
│  │  Home     │ │ Practice │ │  Me      │             │             │
│  │  仪表盘   │ │  练习中心 │ │  设置    │             │             │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘             │             │
│       │             │            │                     │             │
│  ┌────┴────────┐ ┌──┴──────────┐│                     │             │
│  │ Documents   │ │ Vocab Listen││                     │             │
│  │ Vocabulary  │ │             ││                     │             │
│  │ Add-word    │ └─────────────┘│                     │             │
│  │ Word-detail │                │                     │             │
│  │ Resource-   │                │                     │             │
│  │   detail    │                │                     │             │
│  └────┬────────┘                │                     │             │
│       │                         │                     │             │
│  ┌────┴─────────────────────────┴─────────────────┐   │             │
│  │          wx.Storage (本地离线存储)                │   │             │
│  │   vocab_words / learning_resources_v1           │   │             │
│  └─────────────────────────────────────────────────┘   │             │
└────────────────────────┬────────────────────────────────────────────┘
                         │ wx.cloud.callFunction()
┌────────────────────────▼────────────────────────────────────────────┐
│                     微信云函数 (Node.js)                              │
│                                                                       │
│  ┌──────────┐  ┌──────────────────┐  ┌──────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │  login   │  │ generateContent  │  │   tts    │  │parseResource │  │translateSeg.  │ │
│  │ 登录鉴权  │  │  DeepSeek 内容   │  │ Qwen-TTS│  │ 文档解析分段  │  │ DeepSeek 翻译 │ │
│  └──────────┘  └───────┬──────────┘  └────┬─────┘  └──────────────┘  └──────┬──────┘ │
└────────────────────────┼──────────────────┼───────────────────────────┼────────┘
                         │                  │                           │
              ┌──────────▼──────┐  ┌────────▼──────────┐   ┌──────────▼──────────┐
              │  DeepSeek API   │  │  阿里云百炼         │   │   DeepSeek API      │
              │  内容生成        │  │  Qwen-TTS Flash   │   │   逐段翻译           │
              └─────────────────┘  │  语音合成           │   │   (懒加载按需调用)   │
                                   └────────────────────┘   └─────────────────────┘
```

### API 调用流程

```
┌──────────────┐     ┌────────────────┐     ┌───────────────┐
│ 小程序前端    │ ──→ │ 云函数          │ ──→ │ 外部服务       │
└──────────────┘     └────────────────┘     └───────────────┘

添加生词 ──→ generateContent ──→ DeepSeek API (HTTPS)
              ↓ 结构化 JSON

听力训练 ──→ tts ──→ 阿里云 DashScope (HTTPS)
              ↓ 音频 URL → 下载 → 上传云存储 → 返回 cloud://fileID

文档导入 ──→ parseResource ──→ URL 抓取 + 分段 (无翻译，快速完成)
              ↓ 分段文本 → 本地存储

逐段翻译 ──→ translateSegment ──→ DeepSeek API (按需懒加载)
              ↓ 中文翻译 → 缓存到本地存储

逐段音频 ──→ tts ──→ 阿里云 DashScope (按需懒加载)
              ↓ 音频 URL → 下载 → 上传云存储 → 返回 cloud://fileID

启动时  ──→ login ──→ 微信服务器 (code → openid)
```

---

## 数据模型

### Word（生词）

```javascript
Word {
  id:       string          // 唯一标识
  word:     string          // 单词/短语原文
  status:   'new' | 'learning' | 'mastered'
  reviewLevel: number       // 艾宾浩斯复习等级 0-7, 7 = 永久掌握

  content: {                // DeepSeek 生成的学习内容
    shortDefinition: string   // 英文短释义 (≤15词)
    chineseHint:     string   // 中文提示 (≤10字)
    examples:        string[] // 自然例句
    clozeExample:    string   // 挖空例句 (用 ___ 替换目标词)
    collocations:    string[] // 常见搭配
    rootAffix:       string   // 词根词缀分析
    synonyms:        string[] // 近义词
    antonyms:        string[] // 反义词
    memoryTip:       string   // 记忆提示/联想
    difficulty:      number   // 1-5 难度评级
  }

  audio: {                 // Qwen-TTS 生成的音频
    wordAudio:  string       // cloud:// 单词发音
    clozeAudio: string       // cloud:// 挖空例句
    fullAudio:  string       // cloud:// 完整例句
  }

  stats: {                 // 学习统计
    correctCount:  number    // 正确次数
    totalAttempts: number    // 总尝试次数
    lastReviewed:  number    // 上次复习时间戳
    nextReview:    number    // 下次复习时间戳
  }

  createdAt: number        // 创建时间戳
  updatedAt: number        // 更新时间戳
}
```

### Resource（学习资源/文档）

```javascript
Resource {
  id:            string     // 唯一标识
  type:          'document' // 资源类型（当前仅 document）
  title:         string     // 文档标题
  sourceType:    'url' | 'file'  // 来源类型
  sourceUrl:     string     // 原始 URL
  fileName:      string     // 文件名
  fileType:      'html' | 'txt'  // 文件格式
  format:        string     // 同 fileType
  summary:       string     // 首段摘要

  segments: Segment[]       // 分段内容（最多 80 段）

  createdAt:     number
  updatedAt:     number
  lastOpenedAt:  number     // 最近打开时间戳
}

Segment {
  index:        number      // 段落序号 (1-based)
  text:         string      // 英文原文
  translation:  string      // 中文翻译 (按需懒加载，初始为空)
  audioFileID:  string      // cloud:// 音频文件 ID (按需懒加载)
  audioStatus:  'idle' | 'generating' | 'ready' | 'error'
  duration:     number      // 音频时长(秒)
  lastPlayedAt: number      // 最近播放时间戳
}
```

### 复习策略（艾宾浩斯遗忘曲线）

每个生词维护一个 `reviewLevel`（0–7），代表当前所处的艾宾浩斯复习阶段。
每次正确回答后前进一级，错误回答后重置回 0 级。

**间隔表（天）：**

| Level | 间隔 | 说明 | 状态 |
|-------|------|------|------|
| 0 | 1 天 | 首次学习后 | new |
| 1 | 2 天 | 第一次复习 | learning |
| 2 | 4 天 | 第二次复习 | learning |
| 3 | 7 天 | 第三次复习 | learning |
| 4 | 15 天 | 第四次复习 | learning |
| 5 | 30 天 | 第五次复习 | learning |
| 6 | 90 天 | 第六次复习 | mastered |
| 7 | ∞ | 永久掌握，不再复习 | mastered |

**算法规则：**

```
✅ 答对：
  reviewLevel = min(reviewLevel + 1, 7)
  nextReview = now + EBINGHAUS_INTERVALS[reviewLevel]

❌ 答错：
  reviewLevel = 0          // 回归原点，重新开始
  nextReview = now + 1天    // 明天再来
```

**每日复习加载逻辑：**

1. 筛选 `nextReview <= now` 且 `reviewLevel < 7` 的单词
2. 按 `nextReview` 升序排列（越早到期的越先复习）
3. 混合少量新词（约 20%，最少 2 个），保证学习新鲜感

---

## API 集成详情

### 1. DeepSeek API（内容生成 + 逐段翻译）

- **端点**: `https://api.deepseek.com/v1/chat/completions`
- **模型**: `deepseek-chat`
- **调用方**: 云函数 `generateContent`、`translateSegment`
- **用途 A**: 结构化 JSON 输出（释义/例句/搭配/词根/同反义/记忆提示/难度）
- **用途 B**: 文档段落逐段中文翻译（translateSegment 云函数，支持单段/批量最多12段）
- **环境变量**: `DEEPSEEK_API_KEY`（generateContent 和 translateSegment 均需配置）

### 2. 阿里云百炼 Qwen-TTS（语音合成）

- **端点**: `POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- **模型**: `qwen3-tts-flash`
- **调用方**: 云函数 `tts`
- **语音选择**: 英文用 `Cherry`，中文用 `longxiaochun`（自动按文本语言判断）
- **工作流程**: 非流式请求 → 返回音频 URL → 下载二进制 → 上传云存储 → 返回 `cloud://fileID`
- **输出格式**: mp3
- **环境变量**: `DASHSCOPE_API_KEY`

### 3. 微信登录

- **方法**: `wx.login()` → code → 云函数 `login` → `openid`
- **环境变量**: 无需额外配置（云函数内置 `WXContext`）

---

## 页面结构

```
pages/
├── index/                # 🏠 Tab1 - Home 仪表盘
│   ├── 用户信息 + 学习统计
│   ├── 模块入口 (Documents / Vocabulary / Practice / Me)
│   ├── 最近资源列表
│   └── 最近学习生词
│
├── listen/               # 🎧 Tab2 - Practice 练习中心
│   ├── 词汇听力入口 (→ vocab-listen)
│   ├── 文档听力入口 (→ resource-detail)
│   ├── 待复习数量
│   └── 最近资源快捷入口
│
├── review/               # 👤 Tab3 - Me 设置
│   ├── 生词统计 (total/mastered/learning/new/due)
│   ├── 资源统计 (documents/segments/cachedAudio)
│   ├── TTS 语速调节 (0.5x-1.5x)
│   ├── 语音选择 (Default/English/Chinese)
│   ├── 数据导出 (JSON → 剪贴板)
│   └── 音频缓存清理
│
├── resources/            # 📄 文档资源列表
│   ├── 搜索资源
│   ├── 导入弹窗 (URL / 本地文件)
│   ├── 支持 HTML/TXT (≤1MB)
│   └── 删除资源
│
├── resource-detail/      # 📖 文档详情 + 逐段播放
│   ├── 段落列表 + 中文翻译(可展开，按需懒加载)
│   ├── 逐段播放/暂停
│   ├── 音频进度条 + 时间标签
│   ├── 影子跟读模式 (播完自动重播)
│   ├── 音频预加载 (当前段+2 段)
│   ├── 翻译预加载 (播放时自动加载当前段翻译)
│   └── 按需生成音频 (缺音频时即时生成)
│
├── vocabulary/           # 📝 生词管理
│   ├── 搜索 + 按状态筛选 (全部/新词/学习中/已掌握)
│   ├── 快捷标记掌握
│   ├── 跳转听力训练
│   ├── 云端同步
│   └── 浮动添加按钮
│
├── add-word/             # ➕ 添加生词
│   ├── 输入单词 → DeepSeek 生成 → 预览内容
│   ├── 保存 / 保存并开始听力
│   └── 音频同步生成 (独立 try/catch，部分失败也保存)
│
├── word-detail/          # 🔍 单词详情
│   ├── 可折叠卡片：释义/例句/搭配/词根/同反义/记忆提示
│   ├── 学习统计 + 准确率 + 复习进度
│   ├── 播放单词音频
│   ├── 切换掌握状态
│   └── 重新生成音频
│
└── vocab-listen/         # 🎧 词汇听力训练
    ├── 进度条 + 播放挖空句 → 输入猜测 → 揭晓答案
    ├── 播放完整句 → 对错判断 → 自动安排下次复习
    ├── 会话统计 (正确/错误/准确率/新掌握数)
    ├── 缺音频时就地生成
    └── 会话结束 → 跳转复习页
```

### TabBar 导航

| Tab | 标签 | 页面 | 说明 |
|-----|------|------|------|
| 1 | Home | `pages/index/index` | 仪表盘，模块入口 |
| 2 | Practice | `pages/listen/listen` | 练习中心，词汇/文档听力入口 |
| 3 | Me | `pages/review/review` | 个人设置，统计与偏好 |

---

## 核心交互流程

### 词汇听力训练

```
                    开始
                     │
                     ▼
            ┌────────────────────┐
            │  加载待复习生词列表   │
            │  + 混入少量新词      │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  🎧 播放挖空例句     │  ← Qwen-TTS
            │  "The ___ is..."   │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  🤔 用户思考/输入    │
            │  猜测的单词          │
            └────────┬───────────┘
                     │
          ┌──────────▼──────────┐
          │  点击"揭晓答案"       │
          └──────────┬──────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  👁 显示正确单词     │
            │  🎧 播放完整例句    │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  ✓/✗ 判断对错       │
            │                    │
            │ ✅ 答对:            │
            │  Level+1 →  更长间隔│
            │  Level 7 → 永久掌握 │
            │                    │
            │ ❌ 答错:            │
            │  Level归零 → 1天后再│
            │                    │
            │ 更新统计 + 下次复习  │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  下一个词 / 本轮结束 │
            │  → 显示会话统计     │
            └────────────────────┘
```

### 文档学习

```
                    开始
                     │
                     ▼
            ┌────────────────────┐
            │  导入 URL 或文件     │
            │  (HTML/TXT ≤1MB)   │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  parseResource     │
            │  抓取/读取文本       │
            │  → 分段 (≤80段)     │
            │  (不翻译，秒完成)    │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  文档详情页         │
            │  段落列表           │
            └────────┬───────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  点击段落 → 播放    │
            │  (缺音频即时生成)    │
            │  自动预加载后 2 段   │
            └────────┬───────────┘
                     │
              ┌──────┴──────┐
              ▼             ▼
     ┌──────────────┐ ┌──────────────┐
     │ 点击"文A"    │ │ 播放时        │
     │ 展开翻译     │ │ 自动预加载翻译 │
     │ (无翻译则    │ │ (无翻译则     │
     │  即时翻译)   │ │  后台翻译)    │
     └──────┬───────┘ └──────┬───────┘
              │               │
              ▼               ▼
     ┌──────────────────────────────┐
     │  translateSegment 云函数      │
     │  DeepSeek 逐段翻译            │
     │  翻译结果缓存到本地存储        │
     └──────────────┬───────────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  影子跟读模式(可选)  │
            │  播完自动重播        │
            └────────┬───────────┘
                     │
                     ▼
                  下一段
```

---

## 项目目录

```
MiniProgram/
├── project.config.json          # 小程序项目配置
├── project.md                   # 本文档
├── cloudfunctions/              # 云函数
│   ├── login/                   # 登录鉴权
│   │   ├── index.js
│   │   └── package.json
│   ├── generateContent/         # DeepSeek 词汇内容生成
│   │   ├── index.js
│   │   └── package.json
│   ├── tts/                     # Qwen-TTS 音频生成
│   │   ├── index.js
│   │   └── package.json
│   ├── parseResource/           # 文档解析 + 分段（不翻译）
│   │   ├── index.js
│   │   └── package.json
│   ├── translateSegment/        # DeepSeek 逐段翻译（按需懒加载）
│   │   ├── index.js
│   │   └── package.json
│   └── syncData/                # 数据同步
│       ├── index.js
│       └── package.json
└── miniprogram/                 # 小程序源码
    ├── app.js                   # App 生命周期 + 云开发初始化
    ├── app.json                 # 全局配置 (页面路由/TabBar/组件)
    ├── app.wxss                 # 全局样式
    ├── sitemap.json             # 微信搜索索引配置
    ├── images/                  # TabBar 图标
    │   ├── tab-words.png / tab-words-active.png
    │   ├── tab-listen.png / tab-listen-active.png
    │   └── tab-review.png / tab-review-active.png
    ├── utils/                   # 工具模块
    │   ├── constants.js         # 常量 (状态/复习间隔/DeepSeek Prompt)
    │   ├── storage.js           # 生词本地存储 CRUD
    │   ├── resource-storage.js  # 文档资源本地存储 CRUD
    │   ├── cloud.js             # 云函数调用封装
    │   ├── audio-manager.js     # 音频播放管理 (单例/缓存/进度)
    │   └── format.wxs           # WXML 模板格式化工具 (WXS)
    ├── components/              # 组件
    │   ├── word-card/           # 翻转卡片
    │   └── cloze-player/        # 挖空播放器
    └── pages/                   # 页面
        ├── index/               # 🏠 Home 仪表盘
        ├── listen/              # 🎧 Practice 练习中心
        ├── review/              # 👤 Me 设置与统计
        ├── resources/           # 📄 文档资源列表
        ├── resource-detail/     # 📖 文档详情 + 逐段播放
        ├── vocabulary/          # 📝 生词管理
        ├── add-word/            # ➕ 添加生词
        ├── word-detail/         # 🔍 单词详情
        └── vocab-listen/        # 🎧 词汇听力训练
```

---

## 工具模块说明

### constants.js
- `WORD_STATUS`: 词汇状态枚举 (new/learning/mastered)
- `EBINGHAUS_INTERVALS`: 艾宾浩斯复习间隔表 [1,2,4,7,15,30,90] 天
- `MAX_REVIEW_LEVEL`: 最大复习等级 7
- `DEEPSEEK_PROMPT(word)`: DeepSeek 结构化生成 Prompt 模板
- `calcNextReview(reviewLevel)`: 计算下次复习时间戳
- `handleCorrect(reviewLevel)`: 答对算法
- `handleIncorrect()`: 答错算法

### storage.js
- 生词本地 CRUD（`vocab_words` 键）
- 核心方法：getAllWords, addWord, updateWord, deleteWord, getDueWords, searchWords, getStats, recordReviewResult, getRecentRecords, mixNewWords

### resource-storage.js
- 文档资源本地 CRUD（`learning_resources_v1` 键）
- 核心方法：getAllResources, addResource, updateResource, deleteResource, getResourceById, markOpened, searchResources, getRecentResources, updateSegment, getStats, clearAllAudioReferences
- 单文档最多 80 段

### cloud.js
- 云函数统一调用封装
- 方法：login, generateContent, synthesizeSpeech, parseResource, translateText, translateTexts, synthesizeAllAudio, syncToCloud

### audio-manager.js
- 单例模式音频播放管理器
- 自动 `cloud://` → `tempFileURL` 转换
- 回调：onEnded, onError, onTimeUpdate, onCanplay
- 方法：playAudio, pauseAudio, resumeAudio, stopAudio, seekAudio, preloadAudio, destroyAudio

### format.wxs
- WXML 模板专用格式化（WXS 是 JS 子集，不支持 ES6+）
- 方法：formatReviewTime, formatRelativeTime, accuracyPercent, statusLabel, isDue

---

## 环境配置

开发前需要配置以下内容：

| 配置项 | 位置 | 说明 |
|--------|------|------|
| `appid` | `project.config.json` | 微信小程序 AppID |
| `env-id` | `miniprogram/app.js` → `wx.cloud.init()` | 微信云开发环境 ID (`cloud1-d9g82wxrn9260a87b`) |
| `DEEPSEEK_API_KEY` | 云函数环境变量 (generateContent, translateSegment) | DeepSeek API 密钥 |
| `DASHSCOPE_API_KEY` | 云函数环境变量 (tts) | 阿里云百炼 DashScope API 密钥 |

### 部署注意事项
- 云函数环境变量需通过「云开发控制台 → 云函数 → 函数配置 → 环境变量」配置
- 云函数执行超时需设为 30 秒（默认 3 秒不够 API 调用）
- 部署云函数必须选「上传并部署：云端安装依赖」（选「所有文件」不会安装 npm 依赖）
- `project.config.json` 需配置 `miniprogramRoot: "miniprogram/"` 和 `cloudfunctionRoot: "cloudfunctions/"`

---

## 已知限制

- TabBar 图标为占位 PNG，需替换为正式图标
- 音频管理器使用全局单例回调（onEnded/onError），不支持多实例同时播放
- TTS 生成是串行的（单词 → 挖空 → 完整），较慢但简单可靠
- TTS 调用间需 1s 延时避免 429 限流
- 云函数环境变量通过云开发控制台 UI 配置（config.json 方式在开发者工具中不被识别）
- 文档解析最大 20000 字符，最多 80 段
- 文件导入限制 ≤1MB

---

## 用户场景

| 场景 | 交互方式 | 涉及页面 |
|------|---------|----------|
| 通勤路上 | 戴耳机盲操作，听挖空句猜词，按按钮揭示答案 | `vocab-listen` |
| 阅读文章 | 导入英文网页/文件，逐段听读 + 看翻译 | `resources` → `resource-detail` |
| 影子跟读 | 打开跟读模式，听一段 → 自动重播 → 跟读 | `resource-detail` |
| 碎片时间 | 快速浏览生词列表，点击进入深度学习 | `vocabulary` → `word-detail` |
| 复习巩固 | 标记已掌握/未掌握，过滤复习重点词汇 | `vocab-listen` / `review` |
| 添加生词 | 输入单词 → AI 自动生成 → 一键保存 | `add-word` |
| 导入文档 | 粘贴 URL 或选择本地文件 → 自动解析翻译 | `resources` |
