# 听力优先生词系统 - 项目交付概述

## 项目简介
面向英语学习者的微信小程序，核心学习模式为"听挖空例句 → 主动猜词 → 听完整句 → 判断对错"的交互式听力测试，配合艾宾浩斯遗忘曲线进行间隔复习。

## 技术栈
- **前端**: 微信原生开发 (WXML + WXSS + JavaScript)
- **后端**: 微信云开发 (Node.js 云函数)
- **内容生成**: DeepSeek API
- **语音合成**: 阿里云百炼 CosyVoice v3.5-plus
- **本地存储**: wx.Storage (离线优先)
- **格式化工具**: WXS 模块 (WXML 模板中可用的脚本)

## 文件清单

### 工具模块 (miniprogram/utils/)
| 文件 | 说明 |
|------|------|
| `constants.js` | 常量定义 (状态/间隔/Prompt) + 复习算法 |
| `storage.js` | 本地存储 CRUD 封装 |
| `cloud.js` | 云函数调用封装 |
| `audio-manager.js` | 单例音频播放管理 |
| `format.wxs` | WXML 模板格式化工具 |

### 云函数 (cloudfunctions/)
| 目录 | 说明 |
|------|------|
| `login/` | 微信登录鉴权 |
| `generateContent/` | DeepSeek 内容生成 |
| `tts/` | CosyVoice 语音合成 |
| `syncData/` | 数据云端同步 |

### 组件 (miniprogram/components/)
| 组件 | 说明 |
|------|------|
| `word-card/` | 生词卡片展示 |
| `cloze-player/` | 挖空播放器（核心交互组件） |

### 页面 (miniprogram/pages/)
| 页面 | 说明 |
|------|------|
| `index/` | 生词列表 (搜索/筛选/左滑操作) |
| `add-word/` | 添加生词 (AI 生成+预览+保存) |
| `word-detail/` | 单词详情 (可折叠卡片+统计) |
| `listen/` | 听力训练 (核心学习循环) |
| `review/` | 复习管理 (统计+导出) |

## QA 修复记录
1. **WXML 模板不支持 JS 方法调用**: 创建 `format.wxs` WXS 模块，替代 `getReviewText`/`formatTime`/`formatReviewTime` 等页面方法
2. **WXML 模板不支持 `Math` 对象**: 使用 WXS 的 `accuracyPercent()` 替代 `Math.round()`
3. **cloze-player 播放完成时机错误**: `playAudio` promise 在播放**开始**时 resolve，原代码误将其当作播放完成。改用 `audioManager.onEnded` 回调正确处理播放结束
4. **cloze-player 切换词时属性更新时序问题**: 添加 `observers` 监听 `word` 属性变化，自动重置组件，移除脆弱的 `selectComponent + setTimeout reset` 方案

## 部署前需要配置
| 配置项 | 位置 | 说明 |
|--------|------|------|
| `appid` | `project.config.json` | 微信小程序 AppID |
| `env-id` | `miniprogram/app.js` → `wx.cloud.init()` | 云开发环境 ID |
| `DEEPSEEK_API_KEY` | 云函数环境变量 | DeepSeek API 密钥 |
| `DASHSCOPE_API_KEY` | 云函数环境变量 | 阿里云百炼 API 密钥 |

## 使用方式
1. 在微信开发者工具中打开项目
2. 配置 AppID 和云开发环境
3. 上传并部署云函数
4. 在云函数配置中设置环境变量
5. 编译运行
