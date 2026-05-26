# Study Hub · 项目交付概述

## 项目简介

面向英语学习者的微信小程序 **Study Hub**，提供双轨学习模式：

1. **词汇学习**：手动录入生词 → DeepSeek API 自动生成结构化内容 → Qwen3-TTS-Flash 生成音频 → 多模式练习（识别/听写/回忆/语境） → 艾宾浩斯复习 → 录音跟读
2. **文档学习**：导入 URL / 粘贴文本 / 本地文件（HTML/TXT） → 自动分段 + 图片提取 → 逐段按需翻译 + 按需生成音频 → 逐段播放 + 精读任务生成

## 技术栈

| 层次 | 技术 | 说明 |
|------|------|------|
| 前端框架 | 微信原生 (WXML + WXSS + JavaScript + WXS) | 无额外框架依赖 |
| 后端服务 | 微信云开发 · 云函数 (Node.js) | 代理 API 调用，保护密钥 |
| 账号体系 | `wx.login()` + 云函数 login | 基于 openid 的纯静默登录 |
| 本地存储 | wx.Storage + 用户命名空间 `u:{openid}:*` | 三层缓存架构（L1内存 / L2分区Storage / L3云数据库） |
| 云端存储 | 云数据库 (words/resources/preferences/userProfiles) + 云存储 (音频/头像) | 双向增量同步 |
| 内容生成 | DeepSeek API (deepseek-chat) | 词汇结构化内容 + 文档段落逐段翻译 + 精读任务生成 |
| 语音合成 | 阿里云百炼 qwen3-tts-flash | 5 种可选音色，成本 0.8 元/万字符 |
| 音频播放 | `wx.createInnerAudioContext`（原生实现） | 支持 playbackRate 语速调节 0.5x–2.0x |
| 音标补全 | DeepSeek → 本地内置 → Dictionary API | 三级兜底策略 |

## 文件清单

### 工具模块 (miniprogram/utils/)
| 文件 | 说明 |
|------|------|
| `constants.js` | 常量定义 (状态/间隔/Prompt) + 艾宾浩斯复习算法 |
| `storage.js` | 生词三层缓存 CRUD (L1内存/L2分区Storage/L3云数据库) |
| `resource-storage.js` | 资源三层缓存 CRUD |
| `user-storage.js` | 用户隔离 + 偏好 + 资料管理 (命名空间 `u:{openid}:*`) |
| `cloud.js` | 云函数统一调用封装 (7 个云函数) |
| `audio-manager.js` | 单例音频播放 + iOS 兼容 + 语速控制 |
| `tts-preferences.js` | TTS 语速/音色偏好管理 |
| `phonetic.js` | 音标管理 (本地词典 + AI + 字典 API 三级兜底) |
| `format.wxs` | WXML 模板格式化工具 |

### 云函数 (cloudfunctions/)
| 目录 | 说明 |
|------|------|
| `login/` | 微信登录鉴权 → openid |
| `generateContent/` | DeepSeek 词汇结构化内容 + 音标生成 |
| `tts/` | Qwen3-TTS-Flash 语音合成 (5 种音色) |
| `parseResource/` | URL 抓取 + HTML 清洗 + 分段 + 图片提取 |
| `translateSegment/` | DeepSeek 逐段翻译 (单段/批量 ≤12 段) |
| `syncData/` | words/resources/preferences 双向增量同步 |
| `generateResourceStudyPack/` | DeepSeek 精读任务生成 |

### 组件 (miniprogram/components/)
| 组件 | 说明 |
|------|------|
| `word-card/` | 生词卡片展示 |

### 页面 (miniprogram/pages/)
| 页面 | 说明 |
|------|------|
| `index/` | 🏠 首页仪表盘 (问候语/进度/模块入口/最近列表) |
| `review/` | 👤 我的 (头像+昵称/统计/语速/同步/导出/缓存清理) |
| `daily-session/` | 📋 每日学习任务 (4 种练习模式轮换 + 错题回顾) |
| `resources/` | 📄 文档资源列表 (搜索/导入/删除) |
| `resource-detail/` | 📖 文档详情 + 逐段播放 + 翻译 + 精读 |
| `vocabulary/` | 📝 生词管理 (搜索/筛选/快捷掌握/同步) |
| `add-word/` | ➕ 添加生词 (AI 生成 + 音标补全 + 预览) |
| `word-detail/` | 🔍 单词详情 (可折叠卡片/录音跟读/多模式练习/技能统计) |

### TabBar 导航
| Tab | 标签 | 页面 |
|-----|------|------|
| 1 | 首页 | `pages/index/index` |
| 2 | 我的 | `pages/review/review` |

## 核心功能亮点

### 双轨学习
- **词汇**: AI 结构化内容 → 4 种练习模式 → 艾宾浩斯间隔复习 → 录音跟读
- **文档**: URL/文本/文件导入 → 自动分段 → 逐段翻译/音频 → 精读任务

### 三层缓存架构
- L1 内存缓存（~0ms）→ L2 分区 Storage（~1ms）→ L3 云数据库（~100ms）
- 读写分离：读走内存，写立即同步到 L2，异步 debounce 3s 同步到 L3

### 用户隔离
- 所有数据通过 `u:{openid}:*` 命名空间隔离
- 支持匿名数据认领（首次登录合并）

### 数据导出
- 支持 JSON / CSV / 纯文本 三种格式
- 支持复制剪贴板 / 微信分享 两种输出方式

## 部署前需要配置

| 配置项 | 位置 | 说明 |
|--------|------|------|
| `appid` | `project.config.json` / `constants.js` | `wx57a74d66c06421ad` |
| `env-id` | `constants.js` → `wx.cloud.init()` | `cloud1-d1gg8fxt120042802` |
| `DEEPSEEK_API_KEY` | 云函数环境变量 ×3 | generateContent / translateSegment / generateResourceStudyPack |
| `DASHSCOPE_API_KEY` | 云函数环境变量 ×1 | tts |

## 部署步骤

1. 在微信开发者工具中打开项目
2. 确认 AppID 和云开发环境 ID 已正确配置
3. 在云开发控制台创建数据库集合：`words`、`resources`、`preferences`、`userProfiles`
4. 上传并部署所有 7 个云函数（选择「上传并部署：云端安装依赖」）
5. 在云函数配置中设置环境变量（`DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY`）
6. 将云函数执行超时设为 30 秒
7. 编译运行

## 已知限制

- TabBar 图标为占位 PNG
- 个人主体小程序无法获取手机号，采用纯静默登录
- 音频管理器单例，不支持多实例同时播放
- TTS 调用间需 1s 延时避免 429 限流
- 文档解析最大 20000 字符，最多 80 段，文件 ≤1MB
- 精读任务仅分析前 12 段
- 批量翻译最多 12 段
