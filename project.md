# Study Hub · Project.md

## 项目概述

面向英语学习者的微信小程序 **Study Hub**，提供双轨学习模式：

1. **词汇学习**：手动录入生词 → DeepSeek API 自动生成结构化内容 → Qwen3-TTS-Flash 生成音频 → 听挖空例句猜词 → 艾宾浩斯复习
2. **文档学习**：导入 URL 或本地 HTML/TXT 文件 → 自动分段 → 逐段按需翻译(DeepSeek) + 按需生成音频(Qwen3-TTS-Flash) → 逐段播放 + 影子跟读

适合通勤等碎片化场景使用。

- **AppID**: `wx8e5a63421b0d4727`
- **云环境**: `cloud1-d9g82wxrn9260a87b`
- **Git**: 已初始化，分支 `main`

---

## 技术栈

| 层次 | 技术 | 说明 |
|------|------|------|
| 前端框架 | 微信原生 (WXML + WXSS + JavaScript + WXS) | 无额外框架依赖 |
| 后端服务 | 微信云开发 · 云函数 (Node.js) | 代理 API 调用，保护密钥 |
| 账号体系 | `wx.login()` + 云函数 | 基于 openid 的用户标识，`user-storage.js` 做用户隔离 |
| 本地存储 | `wx.Storage` + 用户命名空间 | `u:{openid}:*` 隔离，离线优先 |
| 云端存储 | 云数据库 (words/resources/preferences) + 云存储 (音频) | 双向同步 + 音频文件托管 |
| 内容生成 | DeepSeek API | 词汇结构化内容 + 文档段落逐段翻译 |
| 语音合成 | 阿里云 DashScope qwen3-tts-flash | 英文 voice: Cherry / 中文 voice: longxiaochun |
| 音频播放 | `wx.createInnerAudioContext` | 原生实现（不使用 WebAudio），支持 playbackRate 语速调节 |

---

## 架构拓扑

```
┌─────────────────────────────────────────────────────────────────────┐
│                  微信小程序 (WXML / WXSS / JS / WXS)                │
│                                                                     │
│  ┌──────────┐                                    ┌──────────┐      │
│  │  Home     │                                    │  Me      │      │
│  │  仪表盘   │                                    │  设置    │      │
│  └────┬─────┘                                    └────┬─────┘      │
│       │                                                │            │
│  ┌────┴────────┐ ┌──────────┐ ┌──────────┐            │            │
│  │ Documents   │ │Vocabulary│ │ Word-     │            │            │
│  │ Vocabulary  │ │  Add-word│ │ detail    │            │            │
│  │ Resource-   │ └──────────┘ └──────────┘            │            │
│  │   detail    │                                      │            │
│  └────┬────────┘                                      │            │
│       │                                               │            │
│  ┌────┴───────────────────────────────────────────────┴──────┐     │
│  │       utils: storage / resource-storage / user-storage     │     │
│  │       wx.Storage (u:{openid}:* 命名空间隔离)                │     │
│  └──────────────────────────┬────────────────────────────────┘     │
└─────────────────────────────┼──────────────────────────────────────┘
                              │ wx.cloud.callFunction()
┌─────────────────────────────▼──────────────────────────────────────┐
│                     微信云函数 (Node.js)                             │
│                                                                     │
│  ┌──────────┐  ┌──────────────────┐  ┌──────────┐  ┌────────────┐ │
│  │  login   │  │ generateContent  │  │   tts    │  │parseResource│ │
│  │ 登录鉴权  │  │  DeepSeek 内容   │  │ Qwen3-  │  │ 文档解析分段│ │
│  └──────────┘  └───────┬──────────┘  │TTS-Flash│  └─────┬──────┘ │
│                         │              └────┬────┘        │        │
│  ┌──────────────┐  ┌────┴───────────┐              ┌─────┴──────┐ │
│  │translateSeg. │  │   syncData     │              │            │ │
│  │ DeepSeek翻译 │  │ 双向数据同步    │              │            │ │
│  └──────┬───────┘  │ push/pull/删除 │              │            │ │
│         │          └───────┬────────┘              │            │ │
└─────────┼──────────────────┼───────────────────────┼────────────┘
          │                  │                       │
   ┌──────▼──────┐  ┌───────▼────────┐    ┌─────────▼──────────┐
   │ DeepSeek API│  │  云数据库        │    │  DeepSeek API      │
   │ 内容生成     │  │  words          │    │  逐段翻译           │
   └─────────────┘  │  resources      │    │  (懒加载按需调用)   │
                    │  preferences    │    └────────────────────┘
                    └─────────────────┘
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

数据同步 ──→ syncData ──→ 云数据库 (push/pull 双向，openid 隔离)
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

  audio: {                 // Qwen3-TTS-Flash 生成的音频
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

### Preferences（用户偏好）

```javascript
Preferences {
  ttsSpeed:   number        // 语速百分比 (50-200, 默认 100 = 1.0x)
  updatedAt:  number        // 更新时间戳
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

### 2. 阿里云 DashScope Qwen3-TTS-Flash（语音合成）

- **端点**: `POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- **模型**: `qwen3-tts-flash`
- **调用方**: 云函数 `tts`
- **语音选择**: 英文用 `Cherry`，中文用 `longxiaochun`（自动按文本语言判断）
- **工作流程**: 非流式请求 → 返回音频 URL → 下载二进制 → 上传云存储 → 返回 `cloud://fileID`
- **输出格式**: mp3
- **语速控制**: 不支持 API 端调语速，通过 `InnerAudioContext.playbackRate` 在播放端实现（0.5x–2.0x）
- **环境变量**: `DASHSCOPE_API_KEY`

### 3. 微信登录

- **方法**: `wx.login()` → code → 云函数 `login` → `openid`
- **环境变量**: 无需额外配置（云函数内置 `WXContext`）

### 4. 数据同步（syncData）

- **调用方**: 云函数 `syncData`
- **Push 模式**: 上传 words / resources / preferences + 删除记录
- **Pull 模式**: `{ action: 'pull', scope: 'words' | 'resources' | 'all' }` 拉取云端数据
- **隔离方式**: 所有记录通过 `_openid` 字段隔离
- **Upsert 逻辑**: 按 `id + _openid` 查询，存在则更新，不存在则新增
- **偏好同步**: `user-storage.js` 自动 debounce 3s 后调用 syncData

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
├── review/               # 👤 Tab2 - Me 设置
│   ├── 生词统计 (total/mastered/learning/new/due)
│   ├── 资源统计 (documents/segments/cachedAudio)
│   ├── TTS 语速调节 (0.5x-2.0x, 默认 1.0x)
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
├── listen/               # (空目录，待恢复或清理)
│
└── vocab-listen/         # (空目录，待恢复或清理)
```

### TabBar 导航

| Tab | 标签 | 页面 | 说明 |
|-----|------|------|------|
| 1 | 首页 | `pages/index/index` | 仪表盘，模块入口 |
| 2 | 我的 | `pages/review/review` | 个人设置，统计与偏好 |

> 注意：原设计的 Practice Tab 已移除，词汇听力训练入口从首页进入。

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
            │  🎧 播放挖空例句     │  ← Qwen3-TTS-Flash
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
├── .gitignore                   # Git 忽略规则
├── project.config.json          # 小程序项目配置
├── project.md                   # 本文档
├── cloudfunctions/              # 云函数
│   ├── login/                   # 登录鉴权
│   │   ├── index.js
│   │   └── package.json
│   ├── generateContent/         # DeepSeek 词汇内容生成
│   │   ├── index.js
│   │   └── package.json
│   ├── tts/                     # Qwen3-TTS-Flash 音频生成
│   │   ├── index.js
│   │   └── package.json
│   ├── parseResource/           # 文档解析 + 分段（不翻译）
│   │   ├── index.js
│   │   └── package.json
│   ├── translateSegment/        # DeepSeek 逐段翻译（按需懒加载）
│   │   ├── index.js
│   │   └── package.json
│   └── syncData/                # 双向数据同步（push/pull/delete）
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
    │   ├── storage.js           # 生词本地存储 CRUD (vocab_words 键)
    │   ├── resource-storage.js  # 文档资源本地存储 CRUD (learning_resources_v1 键)
    │   ├── user-storage.js      # 用户隔离存储 + 偏好管理 + 云端同步
    │   ├── cloud.js             # 云函数调用封装
    │   ├── audio-manager.js     # 音频播放管理 (单例/缓存/iOS兼容/语速)
    │   └── format.wxs           # WXML 模板格式化工具 (WXS)
    ├── components/              # 组件
    │   ├── word-card/           # 翻转卡片
    │   └── cloze-player/        # 挖空播放器
    └── pages/                   # 页面
        ├── index/               # 🏠 Home 仪表盘
        ├── review/              # 👤 Me 设置与统计
        ├── resources/           # 📄 文档资源列表
        ├── resource-detail/     # 📖 文档详情 + 逐段播放
        ├── vocabulary/          # 📝 生词管理
        ├── add-word/            # ➕ 添加生词
        ├── word-detail/         # 🔍 单词详情
        ├── listen/              # (空目录，待清理)
        └── vocab-listen/        # (空目录，待清理)
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
- ⚠️ 每次操作全量读写（getAllWords → 修改 → saveAllWords），待优化为分区存储

### resource-storage.js
- 文档资源本地 CRUD（`learning_resources_v1` 键）
- 核心方法：getAllResources, addResource, updateResource, deleteResource, getResourceById, markOpened, searchResources, getRecentResources, updateSegment, getStats, clearAllAudioReferences
- 单文档最多 80 段

### user-storage.js
- 用户隔离的本地存储封装，所有数据通过 `u:{openid}:*` 命名空间隔离
- 偏好管理：getPreferences / savePreferences
- 偏好云端同步：savePreferences 后自动 debounce 3s 调用 syncData 云函数
- 旧数据迁移：migrateLegacyPreferences 将无命名空间的 study_preferences 迁移到用户命名空间
- 核心方法：getActiveUserId, getUserStorageSync, setUserStorageSync, getPreferences, savePreferences, syncPreferences

### cloud.js
- 云函数统一调用封装
- 方法：login, generateContent, synthesizeSpeech, parseResource, translateText, translateTexts, synthesizeAllAudio, syncToCloud

### audio-manager.js
- 单例模式音频播放管理器
- **iOS 兼容性**：不使用 `useWebAudioImplement`，使用原生实现
- **播放时序**：设置 src → onCanplay → play() → onPlay → resolve Promise（避免 iOS 进度条走但无声音）
- **cloud:// 转换**：优先 `wx.cloud.downloadFile` 获取本地临时文件，失败时 fallback 到 `getTempFileURL`
- **音频缓存**：`tempFileCache` 缓存已下载的音频临时路径
- **语速控制**：`applyPlaybackRate()` 读取用户偏好 `ttsSpeed`，设置 `playbackRate`（0.5x–2.0x）
- **播放保护**：`armPlaybackGuards()` 800ms 后兜底 play，15s 超时 reject
- **请求竞态**：`playRequestId` 标识最新请求，旧请求的回调自动忽略
- **stop 事件抑制**：`suppressNextStopEvent` 防止手动 stop 触发状态错乱
- 回调：onEnded, onError, onTimeUpdate, onCanplay
- 方法：playAudio, pauseAudio, resumeAudio, stopAudio, seekAudio, preloadAudio, destroyAudio, getAudioState, getCurrentFileID, getCurrentTime, getDuration

### format.wxs
- WXML 模板专用格式化（WXS 是 JS 子集，不支持 ES6+）
- 方法：formatReviewTime, formatRelativeTime, accuracyPercent, statusLabel, isDue

---

## 环境配置

开发前需要配置以下内容：

| 配置项 | 位置 | 说明 |
|--------|------|------|
| `appid` | `project.config.json` | 微信小程序 AppID (`wx8e5a63421b0d4727`) |
| `env-id` | `miniprogram/app.js` → `wx.cloud.init()` | 微信云开发环境 ID (`cloud1-d9g82wxrn9260a87b`) |
| `DEEPSEEK_API_KEY` | 云函数环境变量 (generateContent, translateSegment) | DeepSeek API 密钥 |
| `DASHSCOPE_API_KEY` | 云函数环境变量 (tts) | 阿里云 DashScope API 密钥 |

### 部署注意事项
- 云函数环境变量需通过「云开发控制台 → 云函数 → 函数配置 → 环境变量」配置
- 云函数执行超时需设为 30 秒（默认 3 秒不够 API 调用）
- 部署云函数必须选「上传并部署：云端安装依赖」（选「所有文件」不会安装 npm 依赖）
- `project.config.json` 需配置 `miniprogramRoot: "miniprogram/"` 和 `cloudfunctionRoot: "cloudfunctions/"`

---

## iOS 音频兼容性修复记录

### 问题
iOS 真机调试时音频播放出现「有进度条无声音」现象。

### 根因
1. `useWebAudioImplement: true` 导致 iOS WebAudio 对播放时机要求严格
2. 设置 src 后立即调用 play()，iOS 要求等 canplay 后才能播放
3. `obeyMuteSwitch` 需在 src 设置前赋值才生效

### 修复方案
1. 移除 `useWebAudioImplement: true`，使用微信原生音频实现
2. 改为 onCanplay 回调中触发 play()，设置 src 后不再立即 play
3. `obeyMuteSwitch = false` 在创建 InnerAudioContext 时即设置
4. 使用 `wx.setInnerAudioOption({ obeyMuteSwitch: false, mixWithOther: true })` 全局配置
5. 添加 pendingPlayResolve/Reject 管理 Promise 状态，确保 playAudio() 在真正开始播放后才 resolve

---

## 已知限制

- TabBar 图标为占位 PNG，需替换为正式图标
- `listen/` 和 `vocab-listen/` 为空目录，页面未注册在 app.json 中，待恢复或清理
- 音频管理器使用全局单例回调（onEnded/onError），不支持多实例同时播放
- TTS 生成是串行的（单词 → 挖空 → 完整），较慢但简单可靠
- TTS 调用间需 1s 延时避免 429 限流
- 云函数环境变量通过云开发控制台 UI 配置（config.json 方式在开发者工具中不被识别）
- 文档解析最大 20000 字符，最多 80 段
- 文件导入限制 ≤1MB
- storage.js / resource-storage.js 每次操作全量读写，数据量大时有性能隐患
- syncData 云函数已支持 pull，但前端尚未实现启动时自动拉取 + 增量合并

---

## 待规划：三层缓存架构

> 当前存储层为扁平的 `wx.Storage`，没有内存缓存和分区存储。
> 计划引入三层缓存架构以提升性能和可靠性：

### L1: 内存缓存（~0ms）
- `app.globalData` 中维护 `Map<id, word>` 热数据
- O(1) 查找，不碰 Storage
- 适用于高频操作（复习答题、搜索过滤）

### L2: 分区 Storage（~1ms）
- 拆分为 `vocab_index`（索引） + `vocab_{id}`（单条数据）
- 增量写：改一个词只写 `vocab_{id}`
- 索引查询：轻量索引支持按状态/日期筛选

### L3: 云数据库（~100ms）
- source of truth，L1/L2 缺失时从云端拉取
- 拉取后回填上两层

### 核心策略
- **Write-Through**: UI 写操作 → L1 更新 → L2 持久化(同步) → L3 同步(异步 debounce 3s)
- **Read-Through**: L1 → L2 → L3 逐级穿透，命中即返回，miss 则回填上层
- **新增文件**: `utils/data-repo.js`（统一数据访问层）、`utils/sync-engine.js`（增量同步引擎）

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

---

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-05-20 | 初始化 Git 仓库，初始提交 `adea6ba` |
| 2026-05-20 | iOS 音频兼容性修复：移除 useWebAudioImplement，改用 onCanplay 后 play |
| 2026-05-20 | 移除无效的发音人选择器，修复语速设置不生效（playbackRate），语速范围扩展为 0.5x–2.0x |
| 2026-05-20 | 新增 user-storage.js 用户隔离存储 + 偏好云端同步 |
