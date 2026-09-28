# TransMate

一个自带 AI 服务配置的 Chrome 划词翻译扩展。当前版本使用 Manifest V3，面向 Chrome 116 及以上版本。

## 安装与使用

1. 打开 Chrome 的 `chrome://extensions`，开启右上角的「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本目录 `TransMate`。
3. 打开扩展的「选项」，填写服务地址、API Key、模型与目标语言，然后保存并测试连接。
4. 在网页中选中文字，右键选择「用 TransMate 翻译」。译文会显示在侧边栏。也可以点击扩展图标打开侧边栏，手动粘贴文字翻译。

### 让 Codex 或 Claude Code 安装

在本目录启动新的 Codex 或 Claude Code 会话，直接说「使用 install-transmate Skill，把 TransMate 安装到我当前的 Chrome，并验证」。项目已提供两者各自可发现的 Skill 和 Chrome DevTools MCP 配置。Agent 会先检查扩展目录，再尝试安装并核对扩展是否启用。

使用项目提供的 MCP 连接现有 Chrome 前，须在 `chrome://inspect/#remote-debugging` 开启远程调试，并在连接弹窗中点击「允许」。Claude Code 还会询问是否批准项目 MCP 配置；Codex 须将 **TransMate 目录本身** 标记为受信任后才会加载 `.codex/config.toml`，仅信任其父目录不够。这些确认完成后，Agent 可以执行安装。若当前 Agent 没有可用的浏览器连接，它会尝试操作 Chrome 的扩展管理界面，或准确说明剩余步骤。若同时开了多个 Chrome 配置文件，请指定要安装的配置文件；Agent 应核对配置文件后再操作。Chrome 149 之前版本可走扩展管理界面安装。

## AI 服务配置

首版支持 OpenAI 兼容的 `chat/completions` 接口。地址需填写完整接口 URL，例如 `https://api.openai.com/v1/chat/completions`。内置的服务预设只填入常用接口地址；模型和 API Key 仍由用户提供。自定义地址须使用 HTTPS，唯本机 `localhost` 或 `127.0.0.1` 可使用 HTTP。

保存或测试配置时，Chrome 会就所填写的服务域名申请网络访问权限。扩展只请求当前配置的具体域名。不同服务商若采用其他请求或响应协议，需要单独适配。

## 数据与权限

- 扩展只在用户选择「用 TransMate 翻译」、手动点击翻译或测试连接时，向配置的 AI 服务发送文字。
- API Key 保存在本机扩展存储中，不通过 Chrome 同步；扩展会限制网页内容脚本读取该存储。客户端保存密钥仍不能提供服务器级保密，请只在可信设备上使用。
- 扩展自身没有后端、账户系统或使用统计，也不保存翻译历史。
- `contextMenus` 提供划词右键入口；`sidePanel` 展示译文；`storage` 保存配置和临时选中文字；AI 服务域名访问权限在配置时单独申请。

## 当前范围

支持选中文本和手动输入文本的翻译、复制译文、目标语言与提示词配置。单次翻译上限为 5000 字符，请求等待上限为 45 秒。整页双语翻译、PDF、字幕与术语库尚未实现。受 Chrome 限制的页面（例如 `chrome://` 页面）不提供网页划词入口。

## 开发验证

无需安装前端依赖。使用 Node.js 20 或以上版本运行：

```bash
npm test
```

测试覆盖配置校验、AI 响应处理和右键入口。真实 AI 请求需用自己的配置在 Chrome 中进行连接测试；自动化测试不会发起付费请求。
