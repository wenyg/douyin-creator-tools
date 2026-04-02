# 抖音创作者中心工具

基于 Playwright，复用同一份本地登录态处理抖音创作者中心里的几类操作：

- `npm run auth`
- `npm run view`
- `npm run works`
- `npm run comments:export`
- `npm run comments:export-all`
- `npm run comments:reply`
- `npm run article:publish`

## 安装

```bash
npm install
npx playwright install chromium
```

## 公共参数

- `--profile <path>`：指定 Playwright profile 目录
- `--timeout <ms>`：整次运行或关键步骤的最大等待时间
- `--headless`：无头模式，在后台运行浏览器但不显示窗口
- `--debug`：打印调试日志

## 登录

首次使用先执行：

```bash
npm run auth
```

默认会把登录态保存在 `.playwright/douyin-profile`。后续所有命令都会复用这份鉴权。

## 手动打开页面

```bash
npm run view
```

## 获取作品列表

```bash
npm run works
```

默认输出到 `comments-output/list-works.json` 可通过 `--out <path>` 指定路径


输出示例：

```json
{
  "count": 2,
  "works": [
    {
      "title": "作品标题短键",
      "publishText": "发布于 2026-03-18"
    }
  ]
}
```

`title` 会先去掉空白字符，再截取前 `15` 个字符。后续导出评论、回复评论都用这个短标题匹配作品。

## 导出全部评论

```bash
npm run comments:export-all -- "作品标题短键"
```

默认输出到 `comments-output/all-comments.json`，可通过 `--out <path>` 指定路径

输出示例：

```json
{
  "selectedWork": {
    "title": "作品标题短键",
    "publishText": "发布于 2026-03-18"
  },
  "count": 5,
  "comments": [
    {
      "username": "用户A",
      "commentText": "评论内容"
    }
  ]
}
```

只导出 `username`（网友id）和 `commentText`（评论内容），不包含回复状态。

## 导出未回复评论

```bash
npm run comments:export -- "作品标题短键"
```

默认输出到 `comments-output/unreplied-comments.json`, 可通过 `--out <path>` 指定路径

输出示例：

```json
{
  "selectedWork": {
    "title": "作品标题短键",
    "publishText": "发布于 2026-03-18"
  },
  "count": 1,
  "comments": [
    {
      "username": "用户A",
      "commentText": "评论内容",
      "replyMessage": ""
    }
  ]
}
```

脚本会强制切到页面原生“未回复”过滤，然后向下滚动，直到出现：

- `没有更多评论`
- `暂无符合条件的评论`

## 回复评论

先编辑 `comments-output/unreplied-comments.json`，为需要回复的评论填上 `replyMessage`，然后执行：

```bash
npm run comments:reply -- comments-output/unreplied-comments.json
```

默认输出到 `comments-output/reply-comments-result.json`。

专属参数：

- `--limit <n>`
- `--dry-run`
- `--keep-open`
- `--out <path>`

说明：

- `--dry-run`：只输入回复内容，不点发送
- `--keep-open`：流程结束后保留浏览器，按 Enter 再关闭
- 默认按 `username` 匹配；只有同一用户名在当前待处理或当前可见评论里出现多条时，才额外校验 `commentText`

## 发布文章

准备一个 JSON 文件，例如 `article.json`：

```json
{
  "title": "文章标题",
  "subtitle": "文章摘要",
  "content": "正文内容",
  "imagePath": "./cover.png",
  "music": "星际穿越",
  "tags": ["标签1", "标签2"]
}
```

执行：

```bash
npm run article:publish -- article.json
```

说明：

- 默认会真实点击发布
- 只想填写内容、不点发布时，加 `--dry-run`
- `imagePath` 支持相对路径，相对路径按 JSON 文件所在目录解析

专属参数：

- `--dry-run`
- `--keep-open`

示例：

```bash
npm run article:publish -- --dry-run article.json
```

## 说明

- 不绕过登录、验证码或平台限制。
- 所有自动化都复用 `.playwright/douyin-profile`。
- 首次登录不要用 `--headless`。
- 如果页面结构变化，优先用 `npm run view` 先人工确认页面状态。
