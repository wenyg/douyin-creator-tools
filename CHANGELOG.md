# Changelog

## 2026-04-09

### 发布图文

- 新增 `npm run imagetext:publish`（`src/publish-douyin-imagetext.mjs`），多图图文发布；默认页 `content/upload?default-tab=3`；JSON 示例 `example/publish_imagetext.json`
- 填写描述：在「添加作品标题」输入后按 Tab 切到描述再输入，避免占位符非标准 input 导致定位失败
- 选择配乐：页面上有两处「选择音乐」文案，点击 `getByText("选择音乐").last()` 打开侧栏，再按与发布文章一致的搜索与「使用」流程

### 评论导出

- 兼容旧作品评论页没有"全部评论/未回复/已回复"下拉框的情况
  - 用 5 秒快速探测下拉框是否存在，不存在则跳过筛选，直接采集当前评论列表
  - 旧作品仅采集前 10 条评论（避免无限滚动耗时），采集后仍经数据库去重过滤已回复的评论

## 2026-04-08

### 发布文章

- 修复最终发布误点「高清发布」：`getByRole` 的 `name` 默认子串匹配，`发布` 会命中「高清发布」；改为 `exact: true` 仅匹配主「发布」按钮，并先 `scrollIntoViewIfNeeded` 再点击

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
