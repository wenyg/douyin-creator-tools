# Changelog

## 2026-04-04

### 浏览器视口自适应

- `npm run auth`、`npm run view` 及所有打开浏览器的命令，默认视口改为自适应屏幕大小（不再固定 1440×900 / 1440×1200）
- `auth`、`view` 新增 `--viewport <WxH>` 参数，可手动指定视口（如 `--viewport 1280x720`）

### 评论导出

- `comments:export`、`comments:export-all` 新增 `--no-history` 选项，跳过导出用户历史记录
- 修复抖音平台表情包（`<img alt="[捂脸]">` 等）评论无法导出的问题
  - 新增 `fullText()` 递归遍历 DOM，通过 `img` 的 `alt` 属性捕获表情包内容
  - 新增 `collectViaContentSelectors` 主提取路径，直接定位 `comment-content-text` 元素，与旧版 block 提取互为回退

### 发布文章

- 头图上传等待时间从 15s 增加到 30s，点击确定前后硬等从 1s/2s 调整为 5s/5s
- JSON 输入增加前置校验：格式、必填字段（title / content / imagePath）、头图文件是否存在，错误以友好中文提示输出，不再抛异常堆栈

### 回复评论

- JSON 解析失败时自动尝试修复未转义的引号（AI 生成 `replyMessage` 常见问题），修复成功给出 `[warn]` 提示继续执行
- 修复失败时输出详细错误：解析位置、附近内容、常见原因提示
- 条目校验错误信息改为中文
- 入口不再打印异常堆栈，只输出错误消息
