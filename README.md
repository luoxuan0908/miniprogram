# Study Hub

面向英语学习者的微信小程序，融合 AI 内容生成与科学记忆方法，提供词汇学习 + 文档精读双轨模式。

## 核心功能

### 词汇学习
手动录入生词 → DeepSeek API 自动生成结构化内容（释义/例句/搭配/词根/记忆提示） → Qwen3-TTS 生成音频 → 4 种练习模式（识别/听写/回忆/语境） → 艾宾浩斯间隔复习 → 录音跟读

### 文档精读
导入 URL / 文本 / 文件（HTML/TXT） → 自动分段 + 图片提取 → 逐段翻译 + 音频生成 → 精读任务

### 技术亮点
- **三层缓存架构**: L1 内存（~0ms） → L2 分区 Storage（~1ms） → L3 云数据库（~100ms）
- **艾宾浩斯复习引擎**: 8 级复习等级（0→7），间隔从 1 天至永久掌握
- **全链路闭环**: 导入 → 内容生成 → 多媒体练习 → 错题归因 → 数据同步
- **AI 增强**: DeepSeek 结构化内容 + Qwen3-TTS 多音色语音合成 + 三级音标兜底

## 技术栈

| 层次 | 技术 |
|------|------|
| 前端 | 微信原生（WXML + WXSS + JS + WXS） |
| 后端 | 微信云开发 · 云函数（Node.js） |
| 存储 | wx.Storage + 云数据库 + 云存储 |
| 内容生成 | DeepSeek API（deepseek-chat） |
| 语音合成 | 阿里云百炼 qwen3-tts-flash（5 种音色） |
| 账号 | wx.login() 静默登录（openid） |

## 项目结构

```
├── miniprogram/          # 小程序前端
│   ├── pages/            # 页面（首页/我的/每日学习/生词管理/文档资源等）
│   ├── components/       # 组件
│   └── utils/            # 工具模块（缓存/音频/音标/TTS偏好等）
├── cloudfunctions/       # 云函数（登录/内容生成/TTS/翻译/同步等）
├── docs/                 # 开发文档
└── scripts/              # 辅助脚本
```

## 快速开始

1. 在微信开发者工具中打开项目
2. 配置 `project.config.json` 中的 AppID
3. 配置 `miniprogram/utils/constants.js` 中的云环境 ID
4. 在云开发控制台创建集合：`words`、`resources`、`preferences`、`userProfiles`
5. 上传部署所有云函数，配置环境变量（`DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY`）
6. 编译运行

> 详见 [overview.md](./overview.md)
