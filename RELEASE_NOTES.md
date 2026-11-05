# kimi-cot-translate v0.2.7

这个版本把 macOS 的签名门禁去掉，和 Windows 保持一致：**签名不再决定能不能翻译**。另外清掉了 Windows 改用 CDP 之后留下的一批死代码。

> **Unofficial community project.** Not affiliated with, endorsed, or sponsored by Moonshot AI. "Kimi" and "Kimi Code" are trademarks of their respective owners. Provided as-is, without warranty; may stop working after a host update.

## 这次改了什么

**macOS 不再要求官方签名。** 此前 macOS 端会校验 `codesign --verify --deep --strict` 以及签名主体是否为 `com.kimi.code.desktop` / `Moonshot` 团队。一旦官方轮换证书、你装的是被重签或自编译的构建，即使 inspector fuse 和思考区块结构都完好，插件也会永久停用——而这三件事里，只有后两件真正决定「能不能翻译」。这个插件是个免费的第三方显示层工具，宿主是否由官方签名与它无关。现在签名只写进状态的 `signature` 字段供诊断。

真正保护挂载的仍是**注入前的进程身份校验**：PID、启动时间、可执行文件路径逐一比对，任一项不符就不发信号。这条在 macOS 和 Windows 上都在。

**删除 Windows 侧已失效的 inspector 代码。** 0.2.5 改用 CDP 注入后，`triggerInspector`、`inspectorOperations`、`state.inspectorClosed` 以及 `blocked-inspector` 这个状态就再没有调用方了，但文档和实机测试还引用着它们，看状态时会读到对不上的字段。这次一并清掉，`blocked-inspector` 现在只在 macOS 上可能出现。

**Windows 实机测试脚本对齐 CDP 语义。** 测试此前仍以无参数方式启动 Kimi，然后断言 9229 端口关闭——那是旧注入方式的前提。现在改为带 `--remote-debugging-port=9222` 启动，断言 9222 在退出后释放。

## 跨版本为什么能一直用

这几版一直在收敛同一件事：**版本号不参与放行**。判断依据只剩三项，且都是能力的直接证据：

| 判断项 | 成立意味着 |
| --- | --- |
| 进程身份（PID、启动时间、可执行文件路径） | 信号发给了正确的那一个进程 |
| inspector fuse / CDP 可用性 | 宿主还留着能被注入的调试通道 |
| `.think` / `.think-head` / `.think-body` / `.think-body-inner` / `.think-text` 五个结构 | 译文还挂得上去 |

Kimi Code 从 Electron 43 升到 45、从 1.1.1 升到 1.3.1，这三项都没变，翻译就照常工作。官方哪天动了思考区块的 DOM，插件会停用并在 `detail` 里写明 `reasoning UI changed`——那才是真的需要适配的情况。

## Windows 用户注意

Windows 端注入走 Chromium DevTools Protocol，**需要 Kimi Code 带 `--remote-debugging-port=9222` 启动**。一次性设置：

右键桌面或开始菜单的 Kimi Code 快捷方式 → 属性 → 「目标」，在原有路径末尾加一个空格和 `--remote-debugging-port=9222`，确定。之后从该快捷方式启动即可。

这个端口只监听 `127.0.0.1`，不对局域网开放。直接在终端敲 `kimi`、或运行别的副本时不会带这个参数，`node runtime-windows.mjs --check` 会明确写出「未监听调试端口」，不会误报成插件损坏。

macOS 桌面端不需要这个参数。

## 验证

- 全量回归：主套件 140、macOS 加载器 42、Windows 加载器 26、VS Code 12，全部通过。
- macOS 真机（Kimi Code 1.3.1 / Electron 45.1.0）：`--install` 后 `--once` 返回 `status: active`、`loaded: 1`、`appVersion: 1.3.1`，去掉签名门禁后挂载链路正常。
- Windows 真机（Kimi Code 1.3.1，Windows 11，局域网内实机）：CDP 挂载返回 `status: active`、`loaded: 1`；用 DeepSeek 产生真实思考内容后，原文节点 `display: none`、译文节点 `display: block`，内容为真实中文。

仍未验证：真实官方跨版本升级过程本身、睡眠唤醒、多用户切换与长期运行。

## 升级方式

- 已安装本插件：运行时自更新会在下次 Kimi Code 启动后自动拉取 0.2.7（校验 SHA-256 后原子替换，失败自动回滚）。也可以手动执行 `node runtime.mjs --update`。
- 首次安装：下载 `kimi-cot-translate-v0.2.7.zip`，按 README 的 macOS / Windows 章节操作。
- 浏览器扩展与 VS Code 附件不会自动更新，需重新下载 `kct-browser-v0.2.7.zip` / `kct-copied-thinking-v0.2.7.vsix`。
