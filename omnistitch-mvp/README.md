# OmniStitch MVP (Chrome Extension)

## 功能
- 在任意博客页面点击扩展图标。
- 自动打开已配置目标站点（ChatGPT / Kimi / DeepSeek / Gemini，可多选）。
- 自动填入“当前 Prompt + 当前页面 URL”。
- 自动点击发送。
- 支持 Prompt 管理（新增/编辑/删除/设为当前）。
- 支持将 AI 回复自动同步到“同步目标”系统（可切换 provider：关闭 / Webhook / Notion / Obsidian）。

## 安装
1. 打开 `chrome://extensions/`。
2. 打开右上角 `Developer mode`。
3. 点击 `Load unpacked`。
4. 选择目录：`omnistitch-mvp`。

## 使用
1. 在扩展详情页点击 `Extension options`，先配置 Prompt（可选）。
   默认内置一个“博客总结” Prompt。
2. 在 `Extension options` 的“同步目标”区域选择 provider：
   - `关闭同步`：只发送，不外部同步。
   - `Webhook`：将结果 POST 到你的 webhook URL。
   - `Notion`：写入 Notion 数据库。
   - `Obsidian`：通过 Obsidian Local REST API 写入周期笔记。
3. 打开任意 `http/https` 博客页面。
4. 点击扩展图标 `OmniStitch MVP`。
5. 等待自动跳转所选目标站点并发送。

## Sync 字段说明
- 扩展内部统一采集字段：
  - `taskid`
  - `target`
  - `time`
  - `aiResponse`
  - `sourceUrl`
- Notion provider 要求数据库存在字段：`AI回复`、`target`、`时间`、`taskid`。
- Obsidian provider 为每条 AI 回复创建一个新 note（`PUT /vault/{filename}`），默认写入 `Daily/OmniStitch/YYYY-MM-DD/{article-title}/{target}/`。

## Prompt 管理
1. 打开 `chrome://extensions/`。
2. 找到 `OmniStitch MVP` 并点击 `Details`。
3. 点击 `Extension options` 进入管理页。
4. 可进行新增、编辑内容、删除、设为当前操作。

## 已知限制
- 需保证你已登录所选目标站点（ChatGPT/Kimi/DeepSeek/Gemini）。
- 目标站点页面结构变更时，`content.js` 的选择器可能需要更新。

## 快捷键一键触发
- 默认快捷键：
  - macOS: `Command+Shift+Y`
  - Windows/Linux: `Ctrl+Shift+Y`
- 修改快捷键：
  1. 打开浏览器扩展快捷键页面（Chrome/Arc 都支持）。
  2. 找到 `OmniStitch MVP` 的 `Send active page URL to configured AI target`。
  3. 自定义为你习惯的组合键。

## 故障排查
- 点击扩展只跳转不发送：
  1. 在扩展页点击 `Reload` 扩展。
  2. 确认目标站点已登录并且页面可正常手动发送。
  3. 打开扩展的 `service worker` 控制台和目标站点页控制台查看错误日志。
- 同步未生效：
  1. 先确认“同步目标”配置已保存。
  2. Webhook 模式下检查 URL 可达与服务端返回状态码。
  3. Notion 模式下确认 token/database 权限和字段名。
  4. Obsidian 模式下确认 Local REST API 插件已开启，Base URL/API Key 正确。
