# TransMate 代码架构

项目入口和验证命令见 [Agent 指南](../AGENTS.md)。`manifest.json` 注册后台 Service Worker、扩展设置页和侧边栏。`content-script.js` 在用户触发选文翻译时按需注入。翻译、总结和连接检测共用 `lib/translator.js` 的请求逻辑。

| 入口 | 流程 |
| --- | --- |
| 网页选文 | `background.js` 读取选文 → 注入 `content-script.js` 并确认浮层显示 → 后台调用 `translate` → 将增量和最终结果发回卡片 |
| 网页双语 | `lib/page-actions.js` 注入 `page-content.js` → 按视口读取待翻译段落 → `lib/page-ai.js` 流式接收并校验译文 → 逐段写回原文附近 |
| 网页总结 | `lib/page-actions.js` 打开侧栏 → 侧栏按文档读取正文 → `lib/page-ai.js` 分批总结 → 显示结果 |
| 侧栏 | `sidepanel.js` 读取手动输入或当前窗口的待处理选文 → 短文本流式翻译，长文本逐段处理 → 渲染结果 |
| 测试连接 | `options.js` 校验当前表单并申请授权 → `checkConnection` 用示例文字调用 `translate` → 显示用时和示例译文 |

## 网页选文与浮层

`registerBackground` 注册同名的 `translate-selection` 右键和命令入口。右键直接使用 `info.selectionText` 和 `info.frameId`，快捷键用 `chrome.scripting.executeScript` 检查有焦点的 frame，读取普通页面选区或输入框选区，并排除密码框。普通网页没有有效选文时显示提示。快捷键在受限页面或无法读取选区时打开侧栏供手动输入。右键已有选文时，可以将文字交给侧栏继续处理。

后台优先把浮层注入选区所在 frame，子 frame 注入失败时尝试顶层。卡片在 Shadow DOM 内渲染，根据选区和视口定位，并处理主题、键盘焦点、原文展开、复制和重试。请求正常启动前，后台会等待浮层返回 `{ ok: true }`。

| 方向 | 消息类型（共同前缀 `TRANSMATE_INLINE_`） |
| --- | --- |
| 后台 → 卡片 | `SHOW` 显示，`PROGRESS` 返回流式增量，`RESULT` 确认译文或错误，`INVALIDATE` 清除过期结果，`HIDE` 关闭 |
| 卡片 → 后台 | `CANCEL` 关闭并取消，`RETRY` 重试，`SWITCH_LANGUAGE` 临时换目标语言，`OPEN_PANEL` 与 `EXPORT_RESULT` 将当前内容交给侧栏，`OPEN_OPTIONS` 打开设置页 |

- 后台按 tab 管理活跃请求，发消息时优先用 `documentId` 定位，并核对发件 tab、frame、document（可用时）和请求 ID。重试生成新 ID，关闭重试中的浮层还可匹配上一请求 ID。
- 每次操作的顺序值用于阻止较慢的选区读取或旧消息覆盖新操作。替换选文、关闭浮层、导航或关闭标签页会取消或清理关联请求。更换服务配置或启用中的术语会使关联译文失效。临时目标语言绑定当前请求，重试沿用该目标语言。
- 后台请求超时为 25 秒。浮层还有 30 秒的等待保护，超时时显示错误并向后台发送 `CANCEL`。

## 存储与侧栏选文

| 存储 | 键 | 用途 |
| --- | --- | --- |
| `chrome.storage.local` | `serviceProfiles` | 已命名的本机 AI 配置与当前配置 ID，含各自的 API Key，仅可信扩展上下文可读 |
| `chrome.storage.local` | `settings` | 当前服务配置，含 API Key。与 `serviceProfiles` 同次写入，供现有翻译入口读取 |
| `chrome.storage.local` | `translationGlossary` | 独立保存本机固定译法与启用状态。使用同一设置锁写入，仅把目标语言和当前请求正文匹配的词对加入翻译提示 |
| `chrome.storage.local` | `pageTranslationSites` | 已授权的自动翻译站点偏好，保存协议、主机和端口 |
| `chrome.storage.local` | `translationHistory` | 用户启用后保存最多 100 条已完成的选文及手动翻译，独立加锁写入 |
| `chrome.storage.session` | `inlineSelection:<tabId>:<requestId>` | 暂存浮层原文与来源信息，使 Worker 休眠后仍能重试。新浮层、关闭和页面离开时清理相关记录 |
| `chrome.storage.session` | `pageTranslation:<tabId>:<requestId>` | 保存双语翻译的请求与文档标识，使 Worker 休眠后可在下一次滚动时继续 |
| `chrome.storage.session` | `pendingSelection:<windowId>:<id>` | 后台交给侧栏的独立选文事件。卡片交接可附已有译文与目标语言。`lib/selection.js` 校验同窗口、非空和 30 秒有效期，侧栏按事件顺序消费并清理 |

侧栏监听存储事件，同时读取启动快照。如果窗口 ID 还未返回，先缓存收到的事件，之后合并并选择最新有效选文。配置有效时，先删除该选文自己的存储键，再开始翻译，避免重开侧栏重复请求或旧操作误删新选文。首次配置期间失去自动消费资格的选文可保留在输入框中，用户可在配置完成后主动开始。

停止、手动编辑原文、新选文、临时换语言或相关配置变更都会中止旧请求。侧栏递增 `requestNumber`，只接受当前请求的回调。配置比较覆盖 `provider`、`endpoint`、`apiKey`、`authType`、`workspaceId`、`model`、`targetLanguage`、`prompt`。超过 5,000 字符时先展示分段方案，长文本保留已完成分段以供继续。已有译文通过一次性会话记录交接，侧栏直接显示。

仅有旧版 `settings` 时，将其作为默认配置读取。首次保存、切换或清理时在 `transmate-settings` 锁内重新读取配置和检查关联域名权限。修改、删除或重置配置时保留其他有效服务配置或站点偏好仍使用的授权。关闭站点偏好时也保留有效服务配置及共享主机授权的其他站点。显式撤销授权会影响该域名下的相关配置和站点。

## 网页双语与重点总结

`page-content.js` 在网页中保留正文和段落位置。双语翻译开始时，`TRANSMATE_PAGE_READ` 只返回计数。后台通过 `TRANSMATE_PAGE_NEXT` 读取初始视口和预读范围内的待翻译段落，范围翻完后等待页面滚动触发 `TRANSMATE_PAGE_MORE`。后台按标签页和文档标识确认归属，逐段发送 `TRANSMATE_PAGE_APPEND`。离开页面、取消或变更设置时，正在处理的请求会中止。

双语翻译开启后，页面合并处理正文区域的 DOM 变动，继续发现后来出现的段落。新增内容与原有正文共享单次会话的 300 段和 30,000 字符上限。已读取段落保留原编号，已译内容可在当前会话内按相同原文复用。远处新增文字仍等滚动到附近才发送，原正文节点移除后不会插入迟到译文。

服务请求失败时，网页保留已插入的译文，并停止随滚动继续请求。当前文档的「重试未完成段落」通过 `TRANSMATE_PAGE_RETRY` 恢复上次请求中尚未插入译文的段落。会话仅保存文档请求标识和可重试状态，确保后台休眠后仍需显式重试。正文已变更时应重新启动翻译。若无法显示页内状态，扩展工具栏图标会提示在普通网页上重试。

「仅译文」在网页内切换已完成段落的显示，未完成的原文和网页链接、控件标签仍可用。模式切换不发出请求，也不影响网页总结读取原文。换回双语、移除译文或离开当前页时，恢复原文节点和作者布局。

站点自动翻译默认关闭。设置页保存用户明确授权的网页 origin（协议、主机和端口），仅在新文档加载后校验偏好和 Chrome 主机权限，再注入并核对实际文档的 origin。Chrome 主机权限按协议和主机授予，适用于该主机的端口。会话存储只记录已尝试的文档标识，用于后台唤醒后跳过重复启动。关闭偏好或撤销权限会取消相应的自动任务，手动翻译仍可主动发起。

网页总结使用 `TRANSMATE_PAGE_READ` 的 `summary` 模式按原标签页和文档 ID 读取正文。每个窗口的侧栏保留最近一次总结，显示网页标题、域名和分批进度。切换标签页会隐藏总结，返回来源页时恢复。重试仍读取同一文档。来源页导航、标签页离开原窗口或翻译配置变更会清除该总结。

## 配置、权限与 AI 请求

- `lib/config.js` 定义服务预设、认证与接口规则。OpenAI、DeepSeek 和 OpenRouter 使用 Chat Completions，Azure 资源统一为 `/openai/v1/chat/completions`，Claude 使用 Messages，Gemini 使用 `/v1beta` 或 `/v1` 基础地址。自定义兼容服务可使用其他请求路径，支持 Bearer、`x-api-key` 和 `api-key`。仅 `localhost` 和 `127.0.0.1` 可使用 HTTP 或启用无需密钥模式。URL 禁止内嵌凭据、查询参数和片段。
- `originPatternForEndpoint` 按服务接口生成 `scheme://hostname/*` 主机授权模式，省略端口。密钥复用要求服务 ID、规范化后的完整接口地址和认证方式一致。表单始终把已保存的密钥留空。
- `options.js` 在保存、测试或用户切换配置的手势回调中先发起授权，再等待结果。`lib/settings-management.js` 在 `transmate-settings` 锁内重新读取、校验草稿和授权、写入或清除设置，再处理闲置域名权限。`cleanupFailed` 表示写入或删除已生效时仍有权限清理失败。
- `lib/translator.js` 校验配置与授权，通过 `lib/providers/` 构建请求并规范化结果。Chat Completions 适配器也用于 Azure，Azure 使用资源 `api-key` 和模型部署名。Claude Messages 和 Gemini 各自构建认证头并解析结束原因。请求省略浏览器凭据、禁止重定向，扩展只展示经过归纳的错误与 HTTP 状态。
- `lib/completion-stream.js` 负责 SSE 拆帧。划词、侧栏短文本和网页双语优先流式处理，也可读取普通 JSON。网页双语逐行校验带段落编号的结果。总结和连接检测使用普通响应。正常翻译会拒绝报告为长度限制的结果。
- `lib/connection-check.js` 发送 `Hello, world.`，返回 `{ translation, durationMs }`。45 秒超时，也可手动取消，检测本身不保存草稿。授权弹窗可能在检测取消后留下新授权。

## 调整页面时检查的接口

设置页和侧栏分别加载 `options.css` 和 `sidepanel.css`。网页浮层的 DOM 和样式由 `content-script.js` 自行创建。改动 HTML 时检查页面脚本使用的 DOM ID，以及 `browser/e2e.mjs` 的 ID 或可访问名称选择器。侧栏脚本的单元测试使用模拟 DOM，新增依赖的元素属性时核对对应测试替身。扩展页面通过 `lib/i18n.js` 读取 `_locales/`，注入脚本也通过浏览器消息目录读取界面文案。

## 本地 PDF

侧栏每次仅读取用户选中的本机文件。打包的 PDF.js 模块在本地 Worker 中提取文字，通过封闭的资源加载接口读取扩展内的字码映射。PDF 字节、页码及提取结果只保留在内存中。扩展最低支持 Chrome 116，内置 PDF.js 的文本提取要求 Chrome 125。文件大小、页数、字数和读取时限由 `lib/local-pdf.js` 限制。

用户把选中的 PDF 文字填入普通翻译工作区后，仍需主动开始翻译。发送路径、目标语言和服务授权沿用侧栏翻译。

## 视频字幕

`lib/video-actions.js` 根据用户的右键操作注入 `video-content.js`。视频脚本读取标准 `TextTrack` 的当前字幕，通过后台转送翻译请求。后台校验标签页、文档和字幕任务，切换字幕轨、跳播或退出时忽略旧结果。字幕翻译使用服务配置及当前目标语言，只发送当前请求需要的字幕文字。
