# Chrome 发布准备

## 版本和打包

1. 在准备发布的提交中同步更新 `manifest.json`、`package.json` 和 `package-lock.json` 的版本。核对版本高于商店已有版本。
2. 在干净检出上运行 `npm ci`、`npm test`、`node scripts/check-install.mjs` 和 `npm run test:browser`。浏览器用例使用本机模拟 AI 服务。
3. 运行 `python3 scripts/package-extension.py`。在 `dist` 中得到 ZIP。检查 ZIP 根目录有 `manifest.json`，把 ZIP 解压到临时目录后通过 Chrome 的「加载已解压的扩展程序」再验收一次。
4. 以下验收可在目标 Chrome 版本的独立配置里完成。版本提交、商店填写与真实服务测试均在待发布构建上核对。

## 验收清单

- [ ] 在 Chrome 116 与当前稳定版验收安装和启动。另在 Chrome 125 与当前稳定版验收本地 PDF 文本功能。
- [ ] 原生右键、物理快捷键、主题切换、键盘焦点与输入选区均正常。
- [ ] 由工具栏打开侧栏，核对中英文界面、手动翻译、停止、切换语言及翻译历史开关。
- [ ] 核对 Chrome 原生服务域名授权弹窗的允许、拒绝和撤销。
- [ ] 核对整页模式切换、重试和网页总结来源。另核对站点自动翻译的授权及撤销、标准字幕轨切换和本地 PDF 选文流程。
- [ ] 用专门的真实 AI 服务配置验证连接及翻译，核对授权、计费和错误反馈。
- [ ] 核对最终构建的数据处理与 [隐私说明](PRIVACY.md) 一致，再更新商店表单和隐私声明链接。
- [ ] 核对 [介绍及视觉素材](LISTING.md) 对应实际构建，确认截图和宣传图尺寸。
- [ ] 明确发布可见范围和支持渠道，提交商店审核后记录版本和结果。

## 权限用途

| 权限 | 使用场景 |
| --- | --- |
| `activeTab`、`scripting` | 根据用户操作读取选区、处理网页正文或显示译文。用户授权的自动翻译站点按偏好注入脚本。 |
| `contextMenus` | 添加翻译及网页总结的右键入口。 |
| `sidePanel` | 提供侧栏文字翻译、接收网页操作结果。 |
| `storage` | 保存服务配置、凭据、站点偏好、术语库、临时会话状态及用户开启的本机历史。 |
| 可选网站权限 | 保存、检测或切换配置时申请具体的 AI 服务域名。用户单独授权想开启自动翻译的站点。 |

商店后台填写可参考 [发布步骤](https://developer.chrome.com/docs/webstore/publish)、[隐私表单](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) 和 [图片规格](https://developer.chrome.com/docs/webstore/images)。
