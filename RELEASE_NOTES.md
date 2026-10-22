# kimi-cot-translate v0.1.0

首个公开发布。为 Kimi Code 已公开的思考内容添加显示层翻译：桌面端内嵌显示，另提供 ACP 翻译终端、浏览器扩展与 VS Code 复制预览。

> **Unofficial community project.** Not affiliated with, endorsed by, or sponsored by Moonshot AI. "Kimi" and "Kimi Code" are trademarks of their respective owners. Provided as-is, without warranty; may stop working after a host update.

## 安装与校验 / Install & verify

```sh
shasum -a 256 -c SHA256SUMS.txt
```

| 附件 | 用途 |
| --- | --- |
| `kimi-cot-translate-v0.1.0.zip` | 完整源码 + 预构建产物（桌面端 `node runtime.mjs --install` 入口） |
| `kct-browser-v0.1.0.zip` | Chromium 浏览器扩展（解压后「加载已解压的扩展程序」） |
| `kct-copied-thinking-v0.1.0.vsix` | VS Code 复制预览（`Extensions: Install from VSIX...`） |
| `SHA256SUMS.txt` | 上述附件的 SHA-256 校验 |

需要 Node.js 24。详细安装步骤见 [README](README.md) / [README.en](README.en.md)。

## 验证状态

| 入口 | 状态 |
| --- | --- |
| 桌面端 macOS arm64 | 真实翻译、启动恢复、刷新恢复已验证（Kimi Code 1.1.1 / Electron 43.1.1） |
| 桌面端 Windows x64 | 预览：CI runner 已验证挂载、安装不重启、安全停用、冷启动恢复 |
| CLI 翻译终端 | 真实模型与 Bing 翻译已验证 |
| 浏览器扩展（Kimi Code Web） | 官方 2.1.1 真实会话实测通过 |
| 浏览器扩展（kimi.com） | 实验实现，未在登录会话验收 |
| VS Code 预览 | 未在真实扩展宿主验收 |

## 已知限制

- 仅验证 Kimi Code 1.1.1 / Electron 43.1.1；宿主更新后可能停用并等待适配（见 `docs/compat.md`），**请勿手工添加未知哈希**。
- 翻译使用公共免鉴权端点（Bing / Google），无 SLA，可能限流或变更；待翻译的思考文本会发往所选第三方端点。
- 自定义服务的 API key 明文保存在本机 localStorage。
- 跨版本升级、睡眠唤醒、长期运行尚未验收。

## 变更

见 [CHANGELOG.md](CHANGELOG.md)。

## 隐私提示

思考链常含代码、路径与内部标识。请不要在含密钥或机密内容的会话中开启自动翻译。分享扩展不会共享作者的账号或权限：请求不携带 Cookie 或登录凭据（`credentials: 'omit'`），设置与缓存只保存在你自己的机器上。安全问题请走 [SECURITY.md](SECURITY.md) 的私密渠道。
