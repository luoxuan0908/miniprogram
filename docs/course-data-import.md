# 课程数据导入流程

当前小程序配置：

| 项 | 值 |
| --- | --- |
| AppID | `wx57a74d66c06421ad` |
| 云环境 | `cloud1-d1gg8fxt120042802` |
| 课程集合 | `courses` |
| 条目集合 | `course_items` |
| 进度集合 | `userCourseProgress` |

## 本次执行记录

2026-05-26 本次迁移使用的新配置：

- AppID: `wx57a74d66c06421ad`
- 云环境: `cloud1-d1gg8fxt120042802`
- 本地音频目录: `/Users/luoxuan/技术/Most_Common_Amrican_Idioms/audio`

已完成：

- `courses` 通过云函数 `importCourseData` 的 `importCourses` action 写入成功。
- 本地音频标准编号文件检查通过：`4065/4065` 个 MP3 存在。
- 本地音频上传脚本已跑过 `1-10`、`11-100`，并在 `101-300` 中途暂停。
- 当前 `scripts/output/upload-progress.json` 显示已上传到 `idiom-0173`，共 `519` 个 MP3。

恢复建议：

- 继续上传音频时，从 `174` 开始即可。
- 如果担心暂停前某条数据库回写未完成，可以先重跑 `101-173`；脚本会跳过已上传文件，只补数据库回写。
- AppSecret 已在聊天中暴露过，完成迁移后建议在微信公众平台重置。

## 导入前检查

在项目根目录运行：

```bash
node scripts/check-core-flows.js
```

它会检查 AppID/云环境单一来源、页面文件完整性、课程数据结构，以及课程列表 → 课程详情 → 条目详情 → 学习进度的核心链路。

## 初始化集合

在微信开发者工具中上传并部署 `cloudfunctions/initDatabase`，然后调用一次：

```js
wx.cloud.callFunction({ name: 'initDatabase', data: {} })
```

再上传并部署 `cloudfunctions/importCourseData`，调用：

```js
wx.cloud.callFunction({
  name: 'importCourseData',
  data: { action: 'ensureCollections' }
})
```

## 导入课程数据

仓库本地已有导入源：

| 文件 | 用途 |
| --- | --- |
| `scripts/output/courses.json` | 原始课程元数据 |
| `scripts/output/course_items.json` | 原始课程条目 |
| `scripts/output/cloud-import/courses_import.json` | 微信控制台导入课程元数据，内容是 JSON Lines |
| `scripts/output/cloud-import/course_items_001.json` 等 | 微信控制台分批导入课程条目，内容是 JSON Lines |

推荐优先使用云开发控制台的数据库导入：

1. 进入云开发控制台 → 数据库。
2. 选择 `courses` 集合，导入 `scripts/output/cloud-import/courses_import.json`，格式选 JSON / JSON Lines。
3. 选择 `course_items` 集合，依次导入 `scripts/output/cloud-import/course_items_001.json`、`course_items_002.json`、`course_items_003.json`，格式选 JSON / JSON Lines。
4. 导入完成后调用状态检查。

不要选择 `scripts/output/courses.json` 或 `scripts/output/cloud-import/courses.json`，这两个是 JSON 数组文件；如果控制台按 JSON Lines 解析，会报“导入数据格式不正确”。

如果控制台仍然报 JSON Lines 格式错误，直接跳过控制台导入器，用云函数写入课程元数据：

1. 右键 `cloudfunctions/importCourseData`。
2. 选择「上传并部署：云端安装依赖」。
3. 在云函数测试面板调用：

```json
{
  "action": "importCourses"
}
```

期望返回：

```json
{
  "success": true,
  "summary": {
    "total": 1,
    "created": 1,
    "updated": 0,
    "error": 0
  }
}
```

再次执行同一个 action 应返回 `updated: 1`，表示幂等更新成功。

本次实际使用的是云函数方式：

```json
{
  "action": "importCourses"
}
```

返回结果：

```json
{
  "action": "importCourses",
  "success": true,
  "summary": {
    "total": 1,
    "created": 1,
    "updated": 0,
    "error": 0,
    "errors": []
  }
}
```

## 用云函数导入课程条目

如果 `courses` 已经通过 `importCourses` 成功写入，继续用同一个云函数导入内置条目分片，不需要再使用数据库控制台导入器。

部署：

1. 右键 `cloudfunctions/importCourseData`。
2. 选择「上传并部署：云端安装依赖」。
3. 在云函数测试面板调用下方 JSON。

先确认分片清单：

```json
{
  "action": "builtInItemsManifest"
}
```

然后从 1 到 14 依次调用：

```json
{
  "action": "importBuiltInItems",
  "batch": 1,
  "concurrency": 10
}
```

把 `batch` 改成 `2`、`3` ... 一直到 `14`。每批最多 100 条，最后一批 55 条。单批期望返回：

```json
{
  "success": true,
  "summary": {
    "total": 100,
    "created": 100,
    "updated": 0,
    "error": 0
  }
}
```

重复执行时 `created` 可能变为 `0`，`updated` 变为对应条数，这是正常的幂等更新。

全部导完后调用：

```json
{
  "action": "status"
}
```

期望 `course_items` 为 `1355`。

## 导入课程音频

`course_items` 导入完成后，把本机 MP3 上传到云存储，并把 `course_items.examples[].audio` 更新成 `cloud://...`。

本次推荐使用本地上传脚本。它会读取本地 MP3，通过微信云开发 HTTP API 上传到云存储，并同步更新 `course_items.examples[].audio`：

```bash
node scripts/upload-audio-local.js --check-only --audio-dir "/Users/luoxuan/技术/Most_Common_Amrican_Idioms/audio"
WECHAT_APPSECRET="<真实AppSecret>" node scripts/upload-audio-local.js --start 1 --end 10 --audio-dir "/Users/luoxuan/技术/Most_Common_Amrican_Idioms/audio"
```

确认 1-10 没问题后分段继续：

```bash
WECHAT_APPSECRET="<真实AppSecret>" node scripts/upload-audio-local.js --start 11 --end 100 --audio-dir "/Users/luoxuan/技术/Most_Common_Amrican_Idioms/audio"
WECHAT_APPSECRET="<真实AppSecret>" node scripts/upload-audio-local.js --start 101 --end 300 --audio-dir "/Users/luoxuan/技术/Most_Common_Amrican_Idioms/audio"
```

脚本会把上传进度写到 `scripts/output/upload-progress.json`，失败后可以重跑同一段；已上传过的文件会跳过。不要把 AppSecret 写进脚本或提交到仓库。

本次已暂停在 `101-300` 中途。继续时可执行：

```bash
WECHAT_APPSECRET="<真实AppSecret>" node scripts/upload-audio-local.js --start 174 --end 300 --audio-dir "/Users/luoxuan/技术/Most_Common_Amrican_Idioms/audio"
WECHAT_APPSECRET="<真实AppSecret>" node scripts/upload-audio-local.js --start 301 --end 600 --audio-dir "/Users/luoxuan/技术/Most_Common_Amrican_Idioms/audio"
WECHAT_APPSECRET="<真实AppSecret>" node scripts/upload-audio-local.js --start 601 --end 900 --audio-dir "/Users/luoxuan/技术/Most_Common_Amrican_Idioms/audio"
WECHAT_APPSECRET="<真实AppSecret>" node scripts/upload-audio-local.js --start 901 --end 1200 --audio-dir "/Users/luoxuan/技术/Most_Common_Amrican_Idioms/audio"
WECHAT_APPSECRET="<真实AppSecret>" node scripts/upload-audio-local.js --start 1201 --end 1355 --audio-dir "/Users/luoxuan/技术/Most_Common_Amrican_Idioms/audio"
```

如果需要补确认 `101-173` 的数据库回写，可先执行：

```bash
WECHAT_APPSECRET="<真实AppSecret>" node scripts/upload-audio-local.js --start 101 --end 173 --audio-dir "/Users/luoxuan/技术/Most_Common_Amrican_Idioms/audio"
```

这不会重复上传已完成的 MP3，只会跳过文件并补写数据库。

### 云函数音频导入备选

如果不方便使用 AppSecret，本地脚本也可以不用，改走 `uploadIdiomAudio` 云函数。它会从公开 CDN 下载 `001.1.mp3` 这类音频，上传到当前云环境的云存储，并更新数据库。

先部署 `cloudfunctions/uploadIdiomAudio`，再测第 1 条：

```json
{
  "index": 1
}
```

成功后分批导入。推荐每批 10 条：

```json
{
  "action": "uploadBatch",
  "batch": 1,
  "batchSize": 10
}
```

把 `batch` 依次改成 `2`、`3` ... 直到 `136`。最后一批会自动截止到第 1355 条。单次最多 10 条，超出会返回错误，避免云函数超时。

也可以手动指定范围：

```json
{
  "action": "uploadBatch",
  "start": 1,
  "end": 10
}
```

查看音频导入进度：

```json
{
  "action": "audioStatus"
}
```

期望最终 `pendingAudio` 为 `0`，`progressPercent` 为 `100`。如果某批失败，直接重试同一个 batch；已经是 `cloud://` 的音频会自动跳过。

如果要通过云函数导入，把 JSON 或 JSONL 文件先上传到云存储，然后调用：

```js
wx.cloud.callFunction({
  name: 'importCourseData',
  data: {
    action: 'importCourses',
    fileID: 'cloud://.../courses_import.json'
  }
})

wx.cloud.callFunction({
  name: 'importCourseData',
  data: {
    action: 'importItemsBatch',
    fileID: 'cloud://.../course_items_001.json',
    concurrency: 10
  }
})
```

`importCourseData` 按 `courses.id` 和 `course_items.courseId + id` 幂等写入，重复执行会更新已有记录，不会继续新增重复条目。

## 导入后验收

调用：

```js
wx.cloud.callFunction({
  name: 'importCourseData',
  data: { action: 'status' }
})
```

期望结果：

```json
{
  "collections": {
    "courses": 1,
    "course_items": 1355,
    "course_sections": 0
  }
}
```

最后在开发者工具中走一遍：

1. 首页 → 课程。
2. 课程列表出现「美语习语 1355」。
3. 进入课程详情，第一页出现 50 条。
4. 搜索 `9-to-5` 能看到对应条目。
5. 进入条目详情，标记「学习中」再标记「已掌握」。
6. 回到课程详情，进度状态随之刷新。
