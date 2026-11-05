# kimi-cot-translate v0.2.8

这个版本把 Windows 缺失的自动更新补上了——在此之前，Windows 用户装完就一直停在旧版本，只有 macOS 会自己跟版。

> **Unofficial community project.** Not affiliated with, endorsed, or sponsored by Moonshot AI. "Kimi" and "Kimi Code" are trademarks of their respective owners. Provided as-is, without warranty; may stop working after a host update.

## 这次改了什么

**Windows 终于会自己更新了。** 自动更新此前只实现了一半：`runtime.mjs`（macOS）的 `--once` 会检查 `runtime-manifest.json` 并原子替换运行时文件，而 `runtime-windows.mjs` 里一行更新代码都没有；那份清单也只列了 5 个 macOS 核心文件，根本不含 `runtime-windows.mjs`。结果就是 Windows 用户装完之后永远停在安装时的版本——真机上当时只有 0.2.5 和 0.2.6 两个目录，最能说明问题。

现在 Windows 有了自己的更新链路：

- 新增 `runtime-manifest-windows.json`，列出 Windows 实际部署的 8 个文件（含 `runtime-windows.mjs` 与 `windows-bridge.ps1`）。
- 每次 Kimi 启动后检查一次，且只在发现 Kimi 进程之后才发请求——Kimi 关着就不联网。
- 发现新版本时把文件下载到数据目录下的暂存目录，逐文件校验 SHA-256；释放锁后由同一进程从暂存副本执行安装并重新注册计划任务。不在运行中的 bundle 里原地替换，因为 Windows 下正在执行的脚本文件换不掉。
- 计划任务持有的 watcher 不能在自己还持锁时安装：它先暂存，退出循环释放锁，再由同一进程接着安装，并让延迟助手在自己退出后拉起新任务。
- 也可以手动执行 `node runtime-windows.mjs --update`。

**更新源增加国内可直连的镜像。** 在你的 Windows 真机上，`raw.githubusercontent.com` 的 443 端口能连上但 HTTPS 请求超时——典型的大陆网络情况。这意味着即使自动更新接好了，用户也拉不到东西。现在清单和每个运行时文件都先试官方域名，失败后自动改用 jsDelivr 镜像，下载内容仍逐个校验 SHA-256，镜像被篡改也装不进去。

**计划任务模式下的自动更新原本根本不会安装。** `--watch` 发现新版本后只把文件暂存下来就退出了，而入口只打印返回值——也就是说每次 Kimi 启动都会下载一遍新版本，然后什么都不做。这条路径已接通：暂存后由同一进程继续安装。

**装完还要有人接替。** 计划任务设置了 `-MultipleInstances IgnoreNew`，而 watcher 自己调用安装时正处在运行中：`Install` 会等自己退出（必然超时），`Start` 会被直接丢弃。现在 watcher 跳过这个自等待，并交给新增的 `Restart` 动作——由延迟助手在本进程退出后拉起新任务。

**安装原本会卡 24 秒然后失败。** `Install` 会等旧 watcher 退出，但 watcher 是常驻进程（`-ExecutionTimeLimit 0`），永远等不到——实测 24.4 秒后抛错，超过 bridge 的 20 秒超时。这段等待已移除。

**装完任务还指着旧 bundle。** 之前的 `Restart` 只是启动了旧任务，执行体没有更新，于是新版本装了但跑的还是老版本。现在由延迟助手读取 `enabled.json`，用其中的路径重新注册任务并启动。

**顺带修复了两个会让更新"看起来装好了、其实没启动"的缺陷。** 一是 `install` 从暂存目录运行时，bridge 脚本路径也落在那里，而该目录安装后即被删除，紧接着的 `Start` 必然失败；二是 Task Scheduler 接受启动请求是异步的，刚注册的任务会拒绝第一次请求。前者改为从已部署的 bundle 取路径，后者改为短暂重试。

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

- 全量回归：主套件 140、macOS 加载器 43、Windows 加载器 39、VS Code 12，全部通过。
- macOS 真机（Kimi Code 1.3.1 / Electron 45.1.0）：`--install` 后 `--once` 返回 `status: active`、`loaded: 1`、`appVersion: 1.3.1`；自动更新把 `updateVersion` 从 0.2.2 提升到 0.2.7 并成功替换运行时文件。
- Windows 真机（Kimi Code 1.3.1，Windows 11，局域网内实机）：CDP 挂载返回 `status: active`、`loaded: 1`；用 DeepSeek 产生真实思考内容后，原文节点 `display: none`、译文节点 `display: block`，内容为真实中文。自动更新也在该机器上端到端跑通：从 0.2.6 出发执行更新，返回 `{"updated":true,"from":"0.2.6","to":"0.2.8","installed":"installed"}`，计划任务重新指向新 bundle 并处于 Running，暂存目录已清理。watcher 自更新路径另行验证：安装后延迟助手把任务重新拉起（`State=Running`），新 watcher 以新 revision 重新挂载（`status: active`、`loaded: 1`），展开思考块后 `view=translated`、`translated:1`、`hidden:1`，译文为真实中文。

仍未验证：真实官方跨版本升级过程本身、睡眠唤醒、多用户切换与长期运行。

## 升级方式

- 已安装本插件（macOS）：运行时自更新会自动拉到 0.2.8，也可以 `node runtime.mjs --update`。
- 已安装本插件（Windows）：从 0.2.8 起才会自动跟版，**这次仍需手动装一次**——执行 `node runtime-windows.mjs --install` 覆盖安装，此后就会自动更新。旧版本没有更新代码，也只能手动装。
- 首次安装：下载 `kimi-cot-translate-v0.2.8.zip`，按 README 的 macOS / Windows 章节操作。
- 浏览器扩展与 VS Code 附件不会自动更新，需重新下载 `kct-browser-v0.2.8.zip` / `kct-copied-thinking-v0.2.8.vsix`。
