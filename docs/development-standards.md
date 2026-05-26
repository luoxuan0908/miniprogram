# 开发规范

## 配置

- AppID 只写在 `project.config.json` 和 `miniprogram/utils/constants.js`。
- 云环境 ID 只写在 `miniprogram/utils/constants.js`，业务代码通过 `CLOUD_ENV_ID` 引用。
- 切换 AppID 或云环境后，先运行 `node scripts/check-core-flows.js`。

## 页面与调试代码

- `miniprogram/app.json` 只能登记用户可访问的正式页面。
- 本地上传、批量导入、临时排查能力放在 `scripts/` 或云函数中，不放进小程序页面路由。
- 发布前搜索临时日志、断点、待办标记和测试数据关键词，确认没有临时入口进入主包。

## 数据与云函数

- 用户数据必须走 `u:{openid}:*` 本地命名空间或按 `_openid` 隔离的云集合。
- 课程公共数据写入使用自然键幂等：
  - `courses`: `id`
  - `course_items`: `courseId + id`
  - `userCourseProgress`: 当前用户 + `courseId + itemId`
- 云函数对外返回优先使用 `{ success, error, data }` 或含 `summary` 的结构，便于调试和验收。

## 课程核心流程验收

每次改课程、存储、云环境、页面路由后运行：

```bash
node scripts/check-core-flows.js
```

再在开发者工具里手动走：

1. 首页 → 课程列表。
2. 课程详情分页和搜索。
3. 条目详情播放音频或 TTS fallback。
4. 标记学习中/已掌握。
5. 加入生词本。

## 提交前检查

基础检查：

```bash
node scripts/check-core-flows.js
find miniprogram cloudfunctions scripts -name '*.js' -not -path '*/node_modules/*' -not -path 'scripts/output/*' -print0 | xargs -0 -n1 node --check
```

如果改了云函数，还要在微信开发者工具中重新上传并部署对应目录，再用云函数调用面板验证核心 action。
