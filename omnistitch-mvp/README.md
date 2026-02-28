# OmniStitch MVP (Chrome Extension)

## 功能
- 在任意博客页面点击扩展图标。
- 自动打开已配置目标站点（ChatGPT / Kimi / DeepSeek / Gemini，可多选）。
- 自动填入“当前 Prompt + 当前页面 URL”。
- 自动点击发送。
- 支持 Prompt 管理（新增/编辑/删除/设为当前）。

## 安装
1. 打开 `chrome://extensions/`。
2. 打开右上角 `Developer mode`。
3. 点击 `Load unpacked`。
4. 选择目录：`omnistitch-mvp`。

## 使用
1. 在扩展详情页点击 `Extension options`，先配置 Prompt（可选）。  
   默认内置一个“博客总结” Prompt。
2. 打开任意 `http/https` 博客页面。
3. 点击扩展图标 `OmniStitch MVP`。
4. 等待自动跳转所选目标站点并发送。

## Prompt 管理
1. 打开 `chrome://extensions/`。
2. 找到 `OmniStitch MVP` 并点击 `Details`。
3. 点击 `Extension options` 进入管理页。
4. 可进行新增、编辑内容、删除、设为当前操作。

## 旧版使用（兼容）
1. 打开任意 `http/https` 博客页面。
2. 点击扩展图标 `OmniStitch MVP`。
3. 等待自动跳转所选目标站点并发送。

## 已知限制
- 需保证你已登录所选目标站点（ChatGPT/Kimi/DeepSeek/Gemini）。
- 目标站点页面结构变更时，`content.js` 的选择器可能需要更新。

## 快捷键一键触发
- 默认快捷键：
  - macOS: `Command+Shift+Y`
  - Windows/Linux: `Ctrl+Shift+Y`
- 修改快捷键：
  1. 打开浏览器扩展快捷键页面（Chrome/Arc 都支持）。
  2. 找到 `OmniStitch MVP` 的 `Send active page URL to ChatGPT with the active prompt`。
  3. 自定义为你习惯的组合键。

## 故障排查
- 点击扩展只跳转不发送：
  1. 先在 `arc://extensions` 点 `Reload` 扩展。
  2. 确认目标站点已登录并且页面可正常手动发送。
  3. 打开扩展的 `service worker` 控制台和目标站点页控制台查看错误日志。
- 快捷键无效（Arc 常见）：
  1. 打开 `arc://extensions/shortcuts`。
  2. 给 `OmniStitch MVP` 的命令手动绑定一个快捷键（避免和系统快捷键冲突）。
  3. 将快捷键作用域设为 `In Arc` 或 `Global`（按你的使用习惯）。
