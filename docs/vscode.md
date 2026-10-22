# VS Code：已复制思考的独立翻译预览

官方聊天区自动原位翻译目前受公开 API 隔离阻挡。已实现的替代入口是本仓库的独立扩展 `vscode/`：复制 Kimi 已显示的思考，运行命令，审阅原文并选择目标语言，然后点击 `Translate with Bing`。译文和原文可在预览内切换。

这不是官方 Kimi webview 的原位挂载，也不会跟随其流式思考。不会修改官方扩展文件、签名、会话历史或模型上下文。仅在用户调用命令时读取一次系统剪贴板，不监听剪贴板、不连接 Kimi 账号。

## 可运行入口

在仓库根目录执行：

```sh
node vscode/build.cjs
node --test vscode/test.cjs
code --extensionDevelopmentPath="$PWD/vscode"
```

在打开的 Extension Development Host 中：

1. 从 Kimi 已展开的 Thinking 区复制需要翻译的文本。
2. 打开命令面板，运行 `KCT: Preview and Translate Copied Thinking`。
3. 检查预览中的 `Copied text`，必要时编辑；空剪贴板时也可以在预览内粘贴。
4. 选择目标语言并点击 `Translate with Bing`。完成后用 `Original` / `Translation` 切换。

命令 ID 为 `kct.translateCopiedThinking`。支持共享引擎的八种语言；点击翻译后记住经过校验的目标语言，下次打开预览沿用。首次使用默认 `zh`。它不会自动获取编辑器选区，来源是系统剪贴板，并在预览中显示供用户确认。不注册 Kimi 命令、模型或 ACP agent。

构建必需，会把主仓库当前的 `kct.js` 复制到 `vscode/vendor/kct.cjs`。`vendor/` 不入库，源码和 VSIX 依赖构建产物。运行时调用共享的 `translateText(source, target, onProgress, settings, valid)` 和 `prunePending()`，复用分段、语言判断、队列、缓存与请求超时。需要 Node 导出 `{ translateText, state, TARGET_LANGUAGES, prunePending }`；没有此入口时构建失败，不生成假的翻译器。更新共享引擎后重新构建。

源码使用 VS Code 官方的扩展开发入口。若已有 Microsoft 官方 `@vscode/vsce` 工具，可先执行 `node build.cjs`，再在 `vscode/` 执行 `vsce package --no-dependencies --skip-license --allow-missing-repository` 打包，生成包后会包含 `vendor/kct.cjs`，再用 VS Code 的 `Extensions: Install from VSIX...` 安装。当前未安装或激活第三方扩展、未自动安装本扩展。

## 数据与失败行为

- 打开预览、审阅和选择语言均不请求翻译；只有点击按钮后，需翻译的文本才发送到共享 Bing 端点 `https://edge.microsoft.com/translate/translatetext`。语言判断、分段和跳过规则与桌面版相同。本实现不提供其他服务、端点或密钥配置。
- 网络请求由本扩展的 Node 宿主执行，不经过官方 Kimi 消息桥；预览自身 `connect-src 'none'`，脚本和样式使用随机 nonce。原文与译文仅作为文本处理，不作为 HTML 执行。
- 不读取工作区文件、Kimi transcript、登录信息或官方扩展私有存储。不调用 Kimi SDK，也不会创建、恢复或修改 Kimi 会话。
- 预览不使用持久化 webview state、文件缓存或本地日志。`context.globalState` 只保存最近一次点击翻译时选择且通过八种语言校验的目标语言，不保存剪贴板、原文或译文。原文只在预览和本次翻译任务内使用；共享 Node 引擎的译文缓存留在扩展宿主内存，受共享引擎预算限制。不会修改共享 `state.settings`。剪贴板保留用户复制的原文。
- 每个预览同时处理一次翻译。支持取消；已发出的请求可能继续到完成或共享引擎超时，但失效结果不回填预览。失败保留原文，按钮可重试。关闭预览会使其排队任务失效；关闭已取消任务的预览不会中止其他预览。
- 原文上限 64,000 个 JavaScript 字符，超限提示重新选择内容。多个预览共享引擎的并发和缓存。
- 目标是桌面 VS Code 的本地 UI 扩展宿主；未提供 `browser` 入口，不能作为 vscode.dev 网页扩展运行。远程工作区中扩展声明 `extensionKind: ["ui"]`，由本地宿主请求翻译。

## 官方入口核实与阻挡证据

核查日期：2026-10-22。官方 TypeScript 仓库为 `MoonshotAI/kimi-code`。CLI 2.1.1 的 tag `@moonshot-ai/kimi-code@2.1.1` 解引用为完整提交 `f67e6398fb3210ad8ace970e2dfd5bcc984ed61f`；该提交里的 VS Code 扩展是 **0.8.1**，扩展 ID 为 **`moonshot-ai.kimi-code`**。没有把 CLI 版本当作扩展版本。

| 核查项 | 一手证据与结论 |
| --- | --- |
| 扩展标识、配置、命令 | [`apps/vscode/package.json`](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/apps/vscode/package.json#L2)；`configuration` 从第 51 行开始，`commands` 从第 101 行开始。配置只有权限、保存、快捷键、思考显示、编辑器上下文等；没有 ACP 可执行文件、参数、外部 agent 或思考翻译钩子。 |
| 没有公开互操作导出 | [`src/extension.ts:20`](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/apps/vscode/src/extension.ts#L20) 的 `activate(): Promise<void>` 没有返回 API 对象；provider 是模块内变量。第 91 行起注册的命令没有读取思考或注入 renderer 的入口。 |
| 私有 webview 与消息桥 | [`src/KimiWebviewProvider.ts:20`](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/apps/vscode/src/KimiWebviewProvider.ts#L20) 的 webviews map 私有；第 106 行的 `onDidReceiveMessage` 由它自己注册并处理。`webview.postMessage` 必须持有对应 webview 实例。 |
| CSP | 同文件 [`getHtml():152`](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/apps/vscode/src/KimiWebviewProvider.ts#L152)：`default-src 'none'`、`connect-src ${webview.cspSource}`、`script-src 'nonce-${nonce}' ${webview.cspSource}`。直接搬入桌面 renderer 脚本既没有公开加载入口，外部翻译请求也不在其 connect-src 范围内。CSP 并非凭空提供注入入口。 |
| 真实思考 DOM | [`webview-ui/src/components/ThinkingBlock.tsx:13`](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/apps/vscode/webview-ui/src/components/ThinkingBlock.tsx#L13)：React 状态决定展开；第 43 行起为通用 Tailwind `div` / `button`，第 56 行起展开后经 `Markdown` 渲染内容。没有桌面版 `.think`、`button.think-head` 或 `.think-body-inner > pre` 结构。这里依据真实组件源码，不声称拿到了本机 live DOM。 |
| 官方 VS Code 不启动自定义 ACP 命令 | [`src/runtime/kimi-runtime.ts:56`](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/apps/vscode/src/runtime/kimi-runtime.ts#L56) 直接 `createKimiHarness({ ..., uiMode: "vscode" })`，第 115 行起由该 harness 建立/恢复会话。其构造选项与已贡献配置均未提供自定义 ACP command/args。仓库存在 ACP server 并不使官方 VS Code 自动成为可配置的 ACP client。 |
| VS Code 的公开边界 | 官方 [Webview guide](https://code.visualstudio.com/api/extension-guides/webview#scripts-and-message-passing) 将 webview 描述为扩展控制的隔离 iframe，消息通过持有的实例传递；[Extension API](https://code.visualstudio.com/api/references/vscode-api#Extension) 的 `exports` 是扩展 `activate` 返回的公开 API，不能凭 `extensions.getExtension()` 获得另一个扩展的私有 provider/DOM。 |

本机在 `/Applications/Visual Studio Code.app`、`/Applications/Visual Studio Code - Insiders.app`、`~/Applications/Visual Studio Code.app`，以及 `~/.vscode/extensions`、`~/.vscode-insiders/extensions`、`~/.cursor/extensions`、`~/.vscode-server/extensions` 均未发现对应安装目录。没有可验收的本机官方扩展包，因此扩展版本、DOM 和 CSP 结论来自上述固定提交源码；不把它当作任意已发布 Marketplace 版本或本机运行时的动态证据。

调查用的官方 sparse checkout 位于 `/tmp/kct-official-kimi-vscode`，处于上述提交 detached HEAD。此目录是临时的一手源码参考，不是修改后的官方扩展包。

## 验证范围与后续入口

`node --test vscode/test.cjs` 覆盖消息边界、参数传递、保留原文和共享设置、重复请求、取消/关闭后的迟到结果、失败重试；扩展和测试共用同一个 `createSession` 生产消息入口。真实共享 Node 引擎测试通过模拟 `fetch` 检查仅发送非目标语言段落、Bing 目标语言参数与不带凭据。Chromium 测试执行实际预览脚本及 CSP，检查确认前不翻译、恶意原文/译文按文本显示、原文切换及编辑后译文失效。所有测试仅使用合成文本，不发送用户会话或真实翻译请求。

已用 `@vscode/vsce@3.9.2 ls` 和实际打包核对：VSIX 包含 `extension.cjs`、`adapter.cjs`、`view.js`、`vendor/kct.cjs`，临时产物为 `/tmp/kct-copied-thinking-final.vsix`。目标语言记忆改动后 vscode 自身 7 项测试通过；前一轮主仓库 `node --test test.cjs runtime-hook.test.mjs` 的 60 项回归通过，说明共享 DOM 行为未被此适配改变。

未在真实 VS Code Extension Host、Marketplace 包、Remote SSH、vscode.dev 或真实 Bing 网络中验收。Chromium 模拟消息桥不等于真实 VS Code 宿主测试。该范围内不宣称已完成官方聊天区自动原位适配。

若要自动跟随官方面板，需要上游提供显示扩展点，例如导出只读思考流和 renderer 翻译入口，或者由官方在 `ThinkingBlock` 中接受翻译渲染器。若使用支持自定义 agent 命令的其他 ACP 客户端，可复用主代理维护的 ACP 显示代理；本适配不重复实现 ACP client/proxy，也不虚构官方 VS Code 的自定义 agent 配置。
