# kimi-cot-translate v0.2.3

这个版本的主题是「只按能力判断，不按版本号判断」。

> **Unofficial community project.** Not affiliated with, endorsed by, or sponsored by Moonshot AI. "Kimi" and "Kimi Code" are trademarks of their respective owners. Provided as-is, without warranty; may stop working after a host update.

## 这次改了什么

**跨 Electron 大版本不再停用。** v0.2.2 在「结构没变」之外还多设了一道 Electron 主版本白名单，结果 Kimi Code 从 Electron 43 升到 45（1.3.1）时，思考区块结构一字未动，翻译却被直接判为永久不兼容、连重试都不做。这道判断已经移除：

放行条件只剩三项，恰好对应「能不能注入」与「能不能渲染」——

- 官方签名
- inspector fuse（能否注入）
- 思考区块结构 `.think` / `.think-head` / `.think-body` / `.think-body-inner` / `.think-text`

Electron 版本号仍然会读，但只用于状态展示，不再参与放行。宿主升级后只要这三项成立，翻译照常工作，与小版本还是大版本无关。

**Windows 同步改掉了同样的问题，而且它原本更严格。** Windows 端以前要求二进制哈希必须在允许列表内，未知构建直接拒绝，根本没有「按结构放行」这条路；白名单条目还被写死成 `Electron/43.1.1`。现在 Windows 也按签名、PE x64、fuse、结构四项判定，未知构建记为 `verified: "contract"`。

**更新清单与版本号已同步。** `runtime-manifest.json` 按 0.2.3 重新生成并校验，自更新可以正确比对新版本。

## 安装与校验 / Install & verify

```sh
shasum -a 256 -c SHA256SUMS.txt
```

| 附件 | 用途 |
| --- | --- |
| `kimi-cot-translate-v0.2.3.zip` | 完整源码 + 预构建产物（桌面端 `node runtime.mjs --install` 入口） |
| `kct-browser-v0.2.3.zip` | Chromium 浏览器扩展（解压后「加载已解压的扩展程序」） |
| `kct-copied-thinking-v0.2.3.vsix` | VS Code 复制预览（`Extensions: Install from VSIX...`） |
| `SHA256SUMS.txt` | 上述附件的 SHA-256 校验 |

需要 Node.js 24。从旧版升级：解压新包后重新执行 `node runtime.mjs --install` 即可，设置与缓存保留。已安装的用户通常无需手动操作——每次 Kimi Code 启动后会检查一次更新清单并自动替换运行时文件。

## 验证状态

| 入口 | 状态 |
| --- | --- |
| 桌面端 macOS arm64 | 真实翻译已验证（Kimi Code 1.3.1 / Electron 45.1.0、1.1.2 与 1.1.1 / Electron 43.1.1）；启动恢复、刷新恢复在前两个版本上验证 |
| 桌面端 Windows x64 | 预览：CI runner 已验证挂载、安装不重启、安全停用、冷启动恢复；本次改动为逻辑对齐 macOS，**未在 Windows 真机上验收** |
| CLI 翻译终端 | 真实模型与 Bing 翻译已验证 |
| 浏览器扩展（Kimi Code Web） | 官方 2.1.1 真实会话实测通过 |
| 浏览器扩展（kimi.com） | 实验实现，未在登录会话验收 |
| VS Code 预览 | 未在真实扩展宿主验收 |

本次在真实 Kimi Code 1.3.1 上确认：正常路径记 `verified: "exact"`，清空允许列表模拟「从未登记过的构建」时仍能通过并记 `verified: "contract"`，即未登记不等于不可用。

## 已知限制

- macOS 上已验证 Electron 43 与 45；Windows 侧的 Electron 45 未在真机验收。
- Electron 主版本号不再参与判断，但思考区块结构若真的变化，翻译仍会停用并等待适配——这是「上游确实改了」的情况。
- 浏览器扩展与 CLI / VS Code 入口不依赖 Electron 注入，不存在本次问题；它们各自的上游兼容边界见表格。
- 不支持 Kimi 桌面端（Kimi.app）：官方二进制关闭了 Node inspector fuse，运行时注入机制无法挂载；Kimi 网页版用户请使用浏览器扩展。
- 翻译使用公共免鉴权端点（Bing / Google），无 SLA，可能限流或变更；待翻译的思考文本会发往所选第三方端点。
- 自定义服务的 API key 明文保存在本机 localStorage。

## 变更

见 [CHANGELOG.md](CHANGELOG.md)。

## 隐私提示

思考链常含代码、路径与内部标识。请不要在含密钥或机密内容的会话中开启自动翻译。分享扩展不会共享作者的账号或权限：请求不携带 Cookie 或登录凭据（`credentials: 'omit'`），设置与缓存只保存在你自己的机器上。自更新只从本仓库的发布地址拉取运行时文件并校验 SHA-256，不上传任何本地数据。安全问题请走 [SECURITY.md](SECURITY.md) 的私密渠道。
