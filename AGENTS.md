# TransMate Agent 指南

TransMate 是一个原生 JavaScript 编写的 Chrome Manifest V3 划词翻译扩展。仓库根目录就是未打包的扩展目录，直接加载 `manifest.json` 所在目录即可开发。运行时代码无需构建，最低 Chrome 版本以 `manifest.json` 为准（当前为 116）。

## 按任务找代码

| 要改什么 | 从哪里读 | 对应测试 |
| --- | --- | --- |
| 扩展入口、权限声明、默认快捷键 | `manifest.json` → `background.js` | `tests/background.test.js`、`browser/e2e.mjs` |
| 网页划词、快捷键读取选区、浮层消息和请求生命周期 | `background.js` → `content-script.js` | `tests/background.test.js`、`browser/e2e.mjs` |
| 浮层失败后的侧栏选文、手动翻译、结果状态 | `sidepanel.js`、`lib/selection.js`、`sidepanel.html`、`sidepanel.css` | `tests/selection.test.js`、`tests/sidepanel-*.test.js`、`browser/e2e.mjs` |
| 服务预设、接口校验、保存设置、密钥与授权 | `lib/config.js`、`options.js`、`lib/settings-management.js`、`options.html` | `tests/config.test.js`、`tests/settings-management.test.js`、`browser/e2e.mjs` |
| 连接检测、AI 请求和错误提示 | `lib/connection-check.js`、`lib/translator.js` | `tests/connection-check.test.js`、`tests/translator.test.js`、`browser/e2e.mjs` |
| 设置页和侧栏的样式 | `options.css`、`sidepanel.css`；网页浮层样式在 `content-script.js` | `browser/e2e.mjs`、相关页面手动检查 |

- 查消息方向、存储键、异步行为和配置契约时，按任务阅读 [代码架构](docs/architecture.md) 的对应小节。
- 用户安装、配置和原生 Chrome 验收见 [README.md](README.md)。功能规划见 [ROADMAP.md](ROADMAP.md)，以当前实现和测试核对实际行为。
- 用户要求安装或更新到指定 Chrome 配置文件时，读取 [install-transmate](.agents/skills/install-transmate/SKILL.md)。Claude Code 的对应说明在 [同名 Skill](.claude/skills/install-transmate/SKILL.md)。

## 修改时保留的行为

- 共享翻译请求经 `lib/translator.js`。网页浮层只展示文字和发送操作消息，选文翻译请求由后台发起。继续限制凭据仅由受信任的扩展上下文读取，错误和日志只保留可安全展示的信息。
- 保存和测试设置时，在用户手势回调的首次 `await` 前申请当前服务的域名权限。保存、清除密钥、重置和手动撤销由 `transmate-settings` Web Lock 串行化，保存时在锁内重新读取配置并核对权限。
- 改动翻译入口或重试时，核对新选文、页面离开、设置变更和旧响应迟到的行为。浮层按标签页和请求标识匹配，侧栏只消费当前窗口的最新有效选文。
- 修改扩展页面的 HTML 时，同时检查 JavaScript 查询的 DOM ID 和浏览器测试的选择器。新增目标语言时同步检查 `options.html` 的选项和 `sidepanel.js` 的显示名。

## 验证命令

在仓库根目录运行，开发验证使用 Node.js 20 或更高版本。

| 验证内容 | 命令 |
| --- | --- |
| 全部单元测试（无需安装开发依赖） | `npm test` |
| 单个模块 | `node --test tests/background.test.js`，按改动替换文件名 |
| Manifest 直接引用的文件是否存在且非空 | `node scripts/check-install.mjs` |
| 浏览器集成测试 | 首次执行 `npm ci` 和 `npx playwright install chromium`，然后运行 `npm run test:browser` |

已有支持加载扩展的 Chromium 或 Chrome for Testing 时，可用 `TRANSMATE_CHROMIUM_EXECUTABLE="/absolute/path/to/browser" npm run test:browser`。集成测试使用临时配置文件、扩展副本及本机模拟 AI 服务，模拟授权结果并直接调用右键和快捷键处理器。涉及 Chrome 原生弹窗、菜单、物理快捷键、侧栏容器或真实服务时，参考 README 的手动验收清单。

## Context7

<!-- context7 -->
Use Context7 MCP to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer -- your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

1. Always start with `resolve-library-id` using the library name and the user's question, unless the user provides an exact library ID in `/org/project` format.
2. Pick the best match (ID format: `/org/project`) by exact name match, description relevance, code snippet count, source reputation (High/Medium preferred), and benchmark score (higher is better). If results don't look right, try alternate names or queries (e.g., "next.js" not "nextjs", or rephrase the question). Use version-specific IDs when the user mentions a version.
3. Call `query-docs` with the selected library ID and the user's full question (not single words).
4. Answer using the fetched docs.
<!-- context7 -->
