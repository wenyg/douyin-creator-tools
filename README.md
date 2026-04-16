# 抖音创作者中心工具

基于 Playwright 的抖音创作者中心 CLI 自动化工具集。复用同一份本地登录态，在终端完成评论导出、批量回复、作品管理、文章发布等操作。

## 功能

| 命令                          | 说明                        |
| ----------------------------- | --------------------------- |
| `npm run auth`                | 扫码登录，保存鉴权状态      |
| `npm run works`               | 获取作品列表                |
| `npm run comments:export`     | 导出未回复评论              |
| `npm run comments:reply`      | 批量回复评论                |
| `npm run article:publish`     | 发布文章                    |
| `npm run imagetext:publish`   | 发布图文（多图）            |
| `npm run view`                | 手动打开创作者中心页面        |

## 环境要求

- **Node.js** >= 20（推荐 22 LTS）

## 安装

```bash
npm install
npx playwright install chromium
```

## 登录

首次使用先执行：

```bash
npm run auth
```

默认会把登录态保存在 `.playwright/douyin-profile`，后续命令会复用这份鉴权；一般不必重复执行 `auth`（登录失效时再跑即可）。

## 获取作品列表

```bash
npm run works --out works.json
```
works.json 输出示例：

```json
{
  "count": 2,
  "works": [
    {
      "title": "作品标题"
    }
  ]
}
```
## 导出未回复评论

```bash
npm run comments:export -- "作品标题" --out comments.json
```
comments.json 输出示例：

```json
{
  "selectedWork": {
    "title": "作品标题"
  },
  "count": 1,
  "comments": [
    {
      "username": "用户A",
      "commentText": "评论内容",
      "imagePaths": ["/absolute/path/to/comments-output/comment-images/用户A_0_ab12cd34.jpeg"],
      "replyMessage": ""
    }
  ]
}
```

- `imagePaths`（可选）：评论附带的图片会自动下载到输出目录下的 `comment-images/`，此字段存储绝对路径数组；无图片时不出现该字段

## 回复评论

只编辑 `comments.json`，为需要回复的评论填上 `replyMessage`，其余的字段不要动, 然后执行：

```bash
npm run comments:reply -- comments.json
```

- `replyMessage` 最多 **400 个字符**, 汉字、标点、英文、空格均按 1 个字符计

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
- `imagePath` 支持相对路径，相对路径按 JSON 文件所在目录解析

执行：

```bash
npm run article:publish -- article.json
```

## 发布图文（多图）

准备一个 JSON 文件，例如 `imagetext.json`：

```json
{
  "imagePaths": ["./photo1.jpg", "./photo2.jpg"],
  "title": "作品标题",
  "description": "作品描述",
  "music": "星际穿越"
}
```
- `imagePaths`（必填）：图片路径数组，最多 35 张，支持 jpg/jpeg/png/webp 格式
- `title`（可选）：作品标题，最多 20 字
- `description`（可选）：作品描述，最多 800 字
- `music`（可选）：配乐名称
- 相对路径按 JSON 文件所在目录解析

执行：

```bash
npm run imagetext:publish -- imagetext.json
```

## 说明

- 不绕过登录、验证码或平台限制。
- 所有自动化都复用 `.playwright/douyin-profile`。
- 如果页面结构变化，优先用 `npm run view` 先人工确认页面状态。

## 更新日志

详见 [CHANGELOG.md](CHANGELOG.md)。
