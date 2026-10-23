# kimi-cot-translate v0.2.1

这个版本的主题是「不用再跟着升级了」。

> **Unofficial community project.** Not affiliated with, endorsed by, or sponsored by Moonshot AI. "Kimi" and "Kimi Code" are trademarks of their respective owners. Provided as-is, without warranty; may stop working after a host update.

## 这次改了什么

**官方小版本升级不再需要重装或等新版。** 以前判断能不能用的依据是 Electron 内核的精确哈希——官方每发一个版本，哈希就变，翻译随即停用，必须这边跟着更新。现在判断依据换成了思考区块的界面结构：

签名、inspector fuse、Electron 主版本、思考区块结构（`.think` / `.think-head` / `.think-body` / `.think-body-inner` / `.think-text`）四项同时成立就放行。只要官方没动这套 DOM，升级后翻译照常工作。

**组件会自己跟版，但只在你用 Kimi Code 的时候。** 每次 Kimi 启动后检查一次更新清单，有新版本就下载运行时文件、逐个校验 SHA-256、原子替换（失败回滚）。同一个 Kimi 进程只查一次；Kimi 关闭期间不发任何网络请求。也可以手动触发：

```sh
node runtime.mjs --update
```

**修了两个会导致异常的问题。** macOS 的 `pgrep -x` 匹配不到含空格的进程名（`Kimi Code`），后台任务因此误判「Kimi 未运行」，改为扫描进程表并按完整可执行路径精确匹配；另外版本号改为内置于运行时脚本，部署目录缺少 `package.json` 时不再每次运行都写一条错误日志。

## 安装与校验 / Install & verify

```sh
shasum -a 256 -c SHA256SUMS.txt
```

| 附件 | 用途 |
| --- | --- |
| `kimi-cot-translate-v0.2.1.zip` | 完整源码 + 预构建产物（桌面端 `node runtime.mjs --install` 入口） |
| `kct-browser-v0.2.1.zip` | Chromium 浏览器扩展（解压后「加载已解压的扩展程序」） |
| `kct-copied-thinking-v0.2.1.vsix` | VS Code 复制预览（`Extensions: Install from VSIX...`） |
| `SHA256SUMS.txt` | 上述附件的 SHA-256 校验 |

需要 Node.js 24。从 0.1.0 升级：解压新包后重新执行 `node runtime.mjs --install` 即可，设置与缓存保留。详细步骤见 [README](README.md) / [README.en](README.en.md)。

## 验证状态

| 入口 | 状态 |
| --- | --- |
| 桌面端 macOS arm64 | 真实翻译、启动恢复、刷新恢复已验证（Kimi Code 1.1.1 / 1.1.2 / Electron 43.1.1） |
| 桌面端 Windows x64 | 预览：CI runner 已验证挂载、安装不重启、安全停用、冷启动恢复 |
| CLI 翻译终端 | 真实模型与 Bing 翻译已验证 |
| 浏览器扩展（Kimi Code Web） | 官方 2.1.1 真实会话实测通过 |
| 浏览器扩展（kimi.com） | 实验实现，未在登录会话验收 |
| VS Code 预览 | 未在真实扩展宿主验收 |

自更新链路在本次发布前只做过单元测试与本地手动验证；第一个真正由它拉取的版本会是下一次发布。

## 已知限制

- 已验证 Kimi Code 1.1.1 与 1.1.2 / Electron 43.1.1；跨版本升级、睡眠唤醒、长期运行尚未验收。
- Electron 跨大版本（当前锁定 43.x）或思考区块结构变化时仍会停用，需要适配。
- 不支持 Kimi 桌面端（Kimi.app）：官方二进制关闭了 Node inspector fuse，运行时注入机制无法挂载；Kimi 网页版用户请使用浏览器扩展。
- 翻译使用公共免鉴权端点（Bing / Google），无 SLA，可能限流或变更；待翻译的思考文本会发往所选第三方端点。
- 自定义服务的 API key 明文保存在本机 localStorage。

## 变更

见 [CHANGELOG.md](CHANGELOG.md)。

## 隐私提示

思考链常含代码、路径与内部标识。请不要在含密钥或机密内容的会话中开启自动翻译。分享扩展不会共享作者的账号或权限：请求不携带 Cookie 或登录凭据（`credentials: 'omit'`），设置与缓存只保存在你自己的机器上。自更新只从本仓库的发布地址拉取运行时文件并校验 SHA-256，不上传任何本地数据。安全问题请走 [SECURITY.md](SECURITY.md) 的私密渠道。
