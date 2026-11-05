# kimi-cot-translate v0.2.4

这个版本修的是 Windows 端的识别问题：签名、路径、版本号都曾被写死，导致真实安装被误判为「不兼容」。

> **Unofficial community project.** Not affiliated with, endorsed, or sponsored by Moonshot AI. "Kimi" and "Kimi Code" are trademarks of their respective owners. Provided as-is, without warranty; may stop working after a host update.

## 这次改了什么

**签名指纹换成真实值。** 代码里记录的叶证书 SHA-1 是 `F754CEE9121450C6CD50EE89D1CD9E692FE1CA40`，而真实 Kimi Code 由 `NOVASCENT PRIVATE LIMITED` 签发的证书签名，指纹为 `5603104F31C1236A07A3A2E79FA285A11C2B3997`。两者从未匹配过，因此 Windows 端在签名这一步就会被拒。现已改为真实值，并保留严格比对：只有状态为 `Valid` 且指纹命中才放行，不按证书主体放宽。

**不再要求装在固定目录。** 以前只认 `%LOCALAPPDATA%\Programs\Kimi Code`，其他位置直接报 `Only LOCALAPPDATA\Programs\Kimi Code is supported`。安装器允许改盘符或目录，因此现在以实际安装位置为准；进程发现使用同一路径，不会把别的安装认成本程序的目标。

**版本号不再参与判断。** Windows 端原先要求二进制哈希必须在允许列表内，且条目被写死为 `Electron/43.1.1`。现在与 macOS 一致：按签名、PE x64、fuse 与思考区块结构判定，未知构建记 `verified: "contract"`，允许列表只作为已知构建的记录。

## 真机验证范围

在 Windows 10/11 实机上，用真实安装（Kimi Code 1.2.1，装在 `D:\Apps\KimiCode`）验证了：

- 真实签名通过，错误指纹与未信任签名被拒；
- fuse 检查通过，Node inspector 信号已启用；
- 完整 `verifyApp` 通过：签名桥接、PE x64、fuse、思考区块 CSS 结构全部成立；
- 非标准安装路径 `D:\Apps\KimiCode` 可正常识别。

**未验证**：真实注入与翻译渲染。SSH 落在 Windows 的 session 0（服务会话），桌面在 session 1，GUI 进程在 session 0 无法稳定运行。这一段需要在已登录的桌面里手动打开 Kimi Code 后测试。

## 安装与校验 / Install & verify

```sh
shasum -a 256 -c SHA256SUMS.txt
```

| 附件 | 用途 |
| --- | --- |
| `kimi-cot-translate-v0.2.4.zip` | 完整源码 + 预构建产物（桌面端 `node runtime.mjs --install` 入口） |
| `kct-browser-v0.2.4.zip` | Chromium 浏览器扩展（解压后「加载已解压的扩展程序」） |
| `kct-copied-thinking-v0.2.4.vsix` | VS Code 复制预览（`Extensions: Install from VSIX...`） |
| `SHA256SUMS.txt` | 上述附件的 SHA-256 校验 |

需要 Node.js 24。macOS 上已安装的用户由自更新自动升级；Windows 端目前没有自更新通道，需要重新解压并执行 `node runtime-windows.mjs --install`。

## 验证状态

| 入口 | 状态 |
| --- | --- |
| 桌面端 macOS arm64 | 真实翻译已验证（Kimi Code 1.3.1 / Electron 45.1.0、1.1.2 与 1.1.1 / Electron 43.1.1） |
| 桌面端 Windows x64 | 签名、fuse、PE 与结构校验已在真机通过；**注入与翻译未在真机验证**（会话隔离限制） |
| CLI 翻译终端 | 真实模型与 Bing 翻译已验证 |
| 浏览器扩展（Kimi Code Web） | 官方 2.1.1 真实会话实测通过 |
| 浏览器扩展（kimi.com） | 实验实现，未在登录会话验收 |
| VS Code 预览 | 未在真实扩展宿主验收 |

## 已知限制

- Windows 端的证书指纹会随官方证书轮换而失效；届时需要把新指纹加入 `SIGNERS`。当前证书有效期至 2026-11-01。
- 思考区块结构若变化，翻译仍会停用并等待适配。
- 不支持 Kimi 桌面端（Kimi.app / Kimi.exe）：官方二进制关闭了 Node inspector fuse，运行时注入机制无法挂载；Kimi 网页版用户请使用浏览器扩展。
- 翻译使用公共免鉴权端点（Bing / Google），无 SLA，可能限流或变更；待翻译的思考文本会发往所选第三方端点。
- 自定义服务的 API key 明文保存在本机 localStorage。

## 变更

见 [CHANGELOG.md](CHANGELOG.md)。

## 隐私提示

思考链常含代码、路径与内部标识。请不要在含密钥或机密内容的会话中开启自动翻译。分享扩展不会共享作者的账号或权限：请求不携带 Cookie 或登录凭据（`credentials: 'omit'`），设置与缓存只保存在你自己的机器上。自更新只从本仓库的发布地址拉取运行时文件并校验 SHA-256，不上传任何本地数据。安全问题请走 [SECURITY.md](SECURITY.md) 的私密渠道。
