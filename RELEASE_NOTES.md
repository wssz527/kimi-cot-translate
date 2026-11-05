# kimi-cot-translate v0.2.6

这个版本修的是 Windows 端：注入机制换成 CDP，并解决了隐藏窗口下翻译停摆的问题。

> **Unofficial community project.** Not affiliated with, endorsed, or sponsored by Moonshot AI. "Kimi" and "Kimi Code" are trademarks of their respective owners. Provided as-is, without warranty; may stop working after a host update.

## 这次改了什么

**隐藏窗口不再让翻译停摆。** 工具栏显示和翻译调度原本只由 `requestAnimationFrame` 驱动。Chromium 在窗口最小化或处于后台时会把 rAF 完全暂停（实测 `visibilityState: hidden` 时一帧都不产生），于是展开思考块后界面毫无反应——插件其实已经挂载（`window.__kct` 存在、上下文就绪），只是驱动它的帧循环停了。现在改为 rAF + 250ms 定时器兜底，原来的合并行为不变。

**Windows 注入换成 CDP，并在真机跑通。** 原实现调用 `process._debugProcess(pid)` 去触发主进程的 Node inspector，前提是宿主像普通 Node 进程那样注册 `node-debug-handler-<pid>`。在真实安装的 Kimi Code 1.3.1 上这个注册并不存在，调用直接报「系统找不到指定的文件」；同一台机器对普通 Node 子进程调用则成功，所以不是 Node 版本问题，而是这条链路对 Electron 应用不成立。

现在改为：Kimi Code 以 `--remote-debugging-port=9222` 启动后，通过 CDP 直接对渲染进程执行译文脚本，并注册 `Page.addScriptToEvaluateOnNewDocument`，页面刷新后译文会自动恢复。不修改 EXE、不重签、不改 `app.asar`。

**Windows 不再要求官方签名。** 这是免费的第三方显示层工具，宿主是否由官方签名与「能不能翻译」无关。此前把签名当作放行条件，导致官方轮换代码签名证书（`5603104F…` → `187C364D…`）时整个 Windows 端直接失效。签名现在只记录在状态里供诊断，不再拦截。

**三个会误判的缺陷一并修掉：**

- 只认 `%LOCALAPPDATA%\Programs\Kimi Code`，装在 `D:\Apps\KimiCode` 等其他位置会被拒绝；现在按实际安装目录识别。
- Kimi Code 通过同一个可执行文件启动 `./bin/kimi-datasource.mjs` 等辅助脚本，它们被误计为第二个主实例从而拒绝挂载；现已排除。
- 进程发现与路径校验此前各自写死，现在统一使用同一路径，避免互相矛盾。

## 真机验证

在 Windows 11 + Kimi Code 1.3.1（安装在 `%LOCALAPPDATA%\Programs\Kimi Code`）上，用经局域网 Magpie 接入的 DeepSeek 产生真实思考内容后确认：

- 挂载返回 `status: active`、`loaded: 1`；
- 插件自诊断：`发现 1 个思考块 / open=true / ctx=true / 状态=ok`；
- 原文节点 `PRE.think-text.kct-source-hidden` → `display: none`；
- 译文节点 `PRE.think-text.kct-translated` → `display: block`，内容为对应的中文翻译。

## 使用前提

Windows 上需要让 Kimi Code 以调试端口启动，翻译才会挂载：

```
"C:\Users\<你>\AppData\Local\Programs\Kimi Code\Kimi Code.exe" --remote-debugging-port=9222
```

安装后的计划任务 watcher 会在 Kimi 运行时维护挂载，但**不会替你修改启动参数**。如果直接用原快捷方式启动（不带该参数），状态会显示需要重启并带上该参数。

macOS 端不受影响，仍由启动器负责。

## 安装与校验 / Install & verify

```sh
shasum -a 256 -c SHA256SUMS.txt
```

| 附件 | 用途 |
| --- | --- |
| `kimi-cot-translate-v0.2.6.zip` | 完整源码 + 预构建产物（桌面端 `node runtime.mjs --install` 入口） |
| `kct-browser-v0.2.6.zip` | Chromium 浏览器扩展（解压后「加载已解压的扩展程序」） |
| `kct-copied-thinking-v0.2.6.vsix` | VS Code 复制预览（`Extensions: Install from VSIX...`） |
| `SHA256SUMS.txt` | 上述附件的 SHA-256 校验 |

需要 Node.js 24。macOS 上已安装的用户由自更新自动升级；Windows 端目前没有自更新通道，需要重新解压并执行 `node runtime-windows.mjs --install`。

## 验证状态

| 入口 | 状态 |
| --- | --- |
| 桌面端 macOS arm64 | 真实翻译已验证（Kimi Code 1.3.1 / Electron 45.1.0、1.1.2 与 1.1.1 / Electron 43.1.1） |
| 桌面端 Windows x64 | **真机已验证**：Kimi Code 1.3.1 上展开思考块后原文隐藏、中文译文显示（需 `--remote-debugging-port`） |
| CLI 翻译终端 | 真实模型与 Bing 翻译已验证 |
| 浏览器扩展（Kimi Code Web） | 官方 2.1.1 真实会话实测通过 |
| 浏览器扩展（kimi.com） | 实验实现，未在登录会话验收 |
| VS Code 预览 | 未在真实扩展宿主验收 |

## 已知限制

- Windows 需要手动以 `--remote-debugging-port=9222` 启动 Kimi Code；官方更新若改变启动参数校验或渲染入口，需重新验证。
- Windows 端没有自更新通道，升级需要手动重装。
- 思考区块结构若变化，翻译仍会停用并等待适配。
- 不支持 Kimi 桌面端（Kimi.exe）：它是与 Kimi Code 不同的产品，官方关闭了相关调试能力。
- 翻译使用公共免鉴权端点（Bing / Google），无 SLA，可能限流或变更；待翻译的思考文本会发往所选第三方端点。
- 自定义服务的 API key 明文保存在本机 localStorage。

## 变更

见 [CHANGELOG.md](CHANGELOG.md)。

## 隐私提示

思考链常含代码、路径与内部标识。请不要在含密钥或机密内容的会话中开启自动翻译。分享扩展不会共享作者的账号或权限：请求不携带 Cookie 或登录凭据（`credentials: 'omit'`），设置与缓存只保存在你自己的机器上。自更新只从本仓库的发布地址拉取运行时文件并校验 SHA-256，不上传任何本地数据。安全问题请走 [SECURITY.md](SECURITY.md) 的私密渠道。
