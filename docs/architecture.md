# TransMate 代码架构

项目入口和验证命令见 [Agent 指南](../AGENTS.md)。`manifest.json` 注册后台 Service Worker、扩展设置页和侧边栏。`content-script.js` 在用户触发选文翻译时按需注入。三条网络入口共用 `lib/translator.js`。

| 入口 | 流程 |
| --- | --- |
| 网页选文 | `background.js` 读取选文 → 注入 `content-script.js` 并确认浮层显示 → 后台调用 `translate` → 将结果发回浮层 |
| 侧栏 | `sidepanel.js` 读取手动输入或当前窗口的待处理选文 → 在侧栏调用 `translate` → 渲染结果 |
| 测试连接 | `options.js` 校验当前表单并申请授权 → `checkConnection` 用示例文字调用 `translate` → 显示用时和示例译文 |

## 网页选文与浮层

`registerBackground` 注册同名的 `translate-selection` 右键和命令入口。右键直接使用 `info.selectionText` 和 `info.frameId`，快捷键用 `chrome.scripting.executeScript` 检查有焦点的 frame，读取普通页面选区或输入框选区，并排除密码框。普通网页没有有效选文时显示提示。快捷键在受限页面或无法读取选区时打开侧栏供手动输入。右键已有选文时，可以将文字交给侧栏继续处理。

后台优先把浮层注入选区所在 frame，子 frame 注入失败时尝试顶层。浮层在 Shadow DOM 内渲染，负责定位、复制和用户操作。请求正常启动前，后台会等待浮层返回 `{ ok: true }`。

| 方向 | 消息类型（共同前缀 `TRANSMATE_INLINE_`） |
| --- | --- |
| 后台 → 浮层 | `SHOW` 显示，`RESULT` 返回译文或错误，`INVALIDATE` 清除因配置变化而过期的结果，`HIDE` 关闭 |
| 浮层 → 后台 | `CANCEL` 关闭并取消，`RETRY` 重试，`OPEN_OPTIONS` 打开设置页 |

- 后台按 tab 管理活跃请求，发消息时优先用 `documentId` 定位，并核对发件 tab、frame、document（可用时）和请求 ID。重试生成新 ID，关闭重试中的浮层还可匹配上一请求 ID。
- 每次操作的顺序值用于阻止较慢的选区读取或旧消息覆盖新操作。替换选文、关闭浮层、导航或关闭标签页会取消或清理关联请求。任意本机 `settings` 变更会让正在处理或从会话恢复的浮层译文失效。
- 后台请求超时为 25 秒。浮层还有 30 秒的等待保护，超时时显示错误并向后台发送 `CANCEL`。

## 存储与侧栏选文

| 存储 | 键 | 用途 |
| --- | --- | --- |
| `chrome.storage.local` | `settings` | 本机服务配置，含 API Key。后台、设置页和侧栏限制为 `TRUSTED_CONTEXTS` |
| `chrome.storage.session` | `inlineSelection:<tabId>:<requestId>` | 暂存浮层原文与来源信息，使 Worker 休眠后仍能重试。新浮层、关闭和页面离开时清理相关记录 |
| `chrome.storage.session` | `pendingSelection:<windowId>:<id>` | 后台交给侧栏的独立选文事件。`lib/selection.js` 校验同窗口、非空和 30 秒有效期，并按事件顺序比较 |

侧栏监听存储事件，同时读取启动快照。如果窗口 ID 还未返回，先缓存收到的事件，之后合并并选择最新有效选文。配置有效时，先删除该选文自己的存储键，再开始翻译，避免重开侧栏重复请求或旧操作误删新选文。

手动编辑原文、收到新选文或翻译字段变更会中止旧请求。侧栏递增 `requestNumber`，回调只更新对应的当前请求。涉及配置字段时查看 `TRANSLATION_SETTING_KEYS`，当前包含 `provider`、`endpoint`、`apiKey`、`model`、`targetLanguage`、`prompt`。译文仅保留在当前界面状态中。

## 配置、权限与 AI 请求

- `lib/config.js` 定义默认值和 OpenAI、DeepSeek、OpenRouter、自定义服务选项。服务地址须为以 `/chat/completions` 结尾的完整 HTTPS URL，仅 `localhost` 和 `127.0.0.1` 支持 HTTP。URL 禁止认证信息、查询参数和片段。权限模式由 `originPatternForEndpoint` 生成，形如 `scheme://hostname/*`，省略端口。密钥复用则要求服务 ID 和规范化后的完整接口地址都相同。
- `options.js` 处理表单。在用户点击保存或测试时，先同步调用 `chrome.permissions.request`，再等待授权结果。页面加载已有配置时将密钥字段留空。
- `lib/settings-management.js` 处理持久化与权限清理。保存配置在 `transmate-settings` 锁内读取现有设置、按当前状态解析草稿、重新确认授权、写入设置，最后尝试撤销不再使用的旧域名。清除密钥时保留其余字段，重置时删除设置并尝试撤销全部已授予的域名。`cleanupFailed` 表示写入或删除已生效，权限清理仍有失败项。
- `lib/translator.js` 校验选文和配置、检查域名访问权限，然后向配置的接口发送 Bearer 鉴权的非流式 `POST` 请求。原文上限为 5000（JavaScript 字符串长度），成功条件是 `choices[0].message.content` 为非空文本。模块返回带 HTTP 状态的错误提示时，不保留上游响应正文。侧栏和连接检测各有 45 秒超时。
- `lib/connection-check.js` 发送 `Hello, world.`，返回 `{ translation, durationMs }`。测试连接可取消，且不会写入设置。授权弹窗的结果独立于请求取消，可能留下可在设置页手动撤销的授权。

## 调整页面时检查的接口

设置页和侧栏分别加载 `options.css` 和 `sidepanel.css`。网页浮层的 DOM 和样式由 `content-script.js` 自行创建。改动 HTML 时检查页面脚本使用的 DOM ID，以及 `browser/e2e.mjs` 的 ID 或可访问名称选择器。侧栏脚本的单元测试使用模拟 DOM，新增依赖的元素属性时核对对应测试替身。
