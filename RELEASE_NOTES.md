# kimi-cot-translate v0.2.8

这个版本把 Windows 缺失的自动更新补上了——在此之前，Windows 用户装完就一直停在旧版本，只有 macOS 会自己跟版。

> **Unofficial community project.** Not affiliated with, endorsed, or sponsored by Moonshot AI. "Kimi" and "Kimi Code" are trademarks of their respective owners. Provided as-is, without warranty; may stop working after a host update.

## 这次改了什么

**Windows 终于会自己更新了。** 自动更新此前只实现了一半：`runtime.mjs`（macOS）的 `--once` 会检查 `runtime-manifest.json` 并原子替换运行时文件，而 `runtime-windows.mjs` 里一行更新代码都没有；那份清单也只列了 5 个 macOS 核心文件，根本不含 `runtime-windows.mjs`。结果就是 Windows 用户装完之后永远停在安装时的版本——真机上至今只有 0.2.5 和 0.2.6 两个目录，最能说明问题。

现在 Windows 有了自己的更新链路：

- 新增 `runtime-manifest-windows.json`，列出 Windows 实际部署的 8 个文件（含 `runtime-windows.mjs` 与 `windows-bridge.ps1`）。
- 每次 Kimi 启动后检查一次，且只在发现 Kimi 进程之后才发请求——Kimi 关着就不联网。
- 发现新版本时把文件下载到数据目录下的暂存目录，逐文件校验 SHA-256，再由一个独立进程执行 `--apply-update` 完成安装并重新注册计划任务。不在当前进程里原地替换，因为 Windows 下正在运行的脚本文件换不掉。
- 计划任务持有的 watcher 不能自己安装（它整场持有 bundle 锁），所以它只负责暂存，然后退出循环、释放锁，再交给独立进程接手。
- 也可以手动执行 `node runtime-windows.mjs --update`。

**顺带修复了 Windows 生命周期锁的并发竞争。** 两个加载器同时抢锁时，Windows 对「正在创建或正在删除」的目录返回 `EPERM` / `EACCES` / `ENOTEMPTY`，而代码此前只认 `EEXIST`，其余直接上抛。CI 上的表现是 `EPERM: operation not permitted, mkdir .runtime-lock.reclaim`；实机则可能让计划任务在输掉一次竞争后写出 error 状态。现在这几种都按「别人拿着锁」处理。

**macOS 不再要求官方签名。** 此前会校验 `codesign --verify --deep --strict` 以及签名主体；一旦官方轮换证书、或你装的是被重签的构建，即使 inspector fuse 和思考区块结构都完好，插件也会永久停用。而这三件事里只有后两件真正决定能不能翻译。签名现在只写进 `signature` 字段供诊断。

真正保护挂载的仍是**注入前的进程身份校验**：PID、启动时间、可执行文件路径逐一比对。

## 跨版本为什么能一直用

判断依据只剩三项，且都是能力的直接证据：

| 判断项 | 成立意味着 |
| --- | --- |
| 进程身份（PID、启动时间、可执行文件路径） | 信号发给了正确的那一个进程 |
| inspector fuse / CDP 可用性 | 宿主还留着能被注入的调试通道 |
| `.think` / `.think-head` / `.think-body` / `.think-body-inner` / `.think-text` 五个结构 | 译文还挂得上去 |

版本号只用于状态展示。Kimi Code 从 Electron 43 升到 45、从 1.1.1 升到 1.3.1，这三项都没变，翻译就照常工作。官方哪天动了思考区块的 DOM，插件会停用并在 `detail` 里写明 `reasoning UI changed`——那才是真的需要适配的情况。

## Windows 用户注意

Windows 端注入走 Chromium DevTools Protocol，**需要 Kimi Code 带 `--remote-debugging-port=9222` 启动**。一次性设置：

右键桌面或开始菜单的 Kimi Code 快捷方式 → 属性 → 「目标」，在原有路径末尾加一个空格和 `--remote-debugging-port=9222`，确定。

这个端口只监听 `127.0.0.1`，不对局域网开放。直接在终端敲 `kimi`、或运行别的副本时不会带这个参数，`node runtime-windows.mjs --check` 会明确写出「未监听调试端口」。

macOS 桌面端不需要这个参数。

## 验证

- 全量回归：主套件 140、macOS 加载器 42、Windows 加载器 32、VS Code 12，全部通过。
- macOS 真机（Kimi Code 1.3.1 / Electron 45.1.0）：`--install` 后 `--once` 返回 `status: active`、`loaded: 1`、`appVersion: 1.3.1`；自动更新把 `updateVersion` 从 0.2.2 提升到 0.2.7 并成功替换运行时文件。
- Windows 真机（Kimi Code 1.3.1，Windows 11，局域网内实机）：CDP 挂载返回 `status: active`、`loaded: 1`；用 DeepSeek 产生真实思考内容后，原文节点 `display: none`、译文节点 `display: block`，内容为真实中文。

仍未验证：真实官方跨版本升级过程本身、睡眠唤醒、多用户切换与长期运行。

## 升级方式

- 已安装本插件（macOS）：运行时自更新会自动拉到 0.2.8，也可以 `node runtime.mjs --update`。
- 已安装本插件（Windows）：从 0.2.8 起才会自动跟版，**这次仍需手动装一次**——执行 `node runtime-windows.mjs --install` 覆盖安装，此后就会自动更新。
- 首次安装：下载 `kimi-cot-translate-v0.2.8.zip`，按 README 的 macOS / Windows 章节操作。
- 浏览器扩展与 VS Code 附件不会自动更新，需重新下载 `kct-browser-v0.2.8.zip` / `kct-copied-thinking-v0.2.8.vsix`。
