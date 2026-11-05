# Windows 适配记录

2026-10-22：先在 macOS 上完成官方 Windows 安装包的离线检查，再实现 Windows 运行时加载器。[Windows runner 上的官方 App 动态测试已通过](https://github.com/wssz527/kimi-cot-translate/actions/runs/39645821455)。这是预览适配，不代表所有 Windows 桌面环境均已验收。

## 已完成的静态检查

安装包来自 [Kimi Code 官方下载入口](https://code.kimi.com/kimi-code/desktop/download/KimiCode-win-x64.exe)，在 macOS 解包，没有执行安装程序。

| 项目 | 实际结果 |
| --- | --- |
| App package 版本 | 1.1.1 |
| Electron 字符串 | 43.1.1 |
| PE 架构 | x64，machine `0x8664` |
| Electron fuse | version 1，9 flags，`101100001` |
| Node inspector 触发开关 | 启用 |
| Windows 调试映射标记 | 包含 UTF-16 的 `node-debug-handler` |
| 思考区块 CSS | `think`、`think-head`、`think-body`、`think-body-inner`、`think-text` 均存在 |
| 签名证书主体 | `NOVASCENT PRIVATE LIMITED` |
| 签名叶证书 SHA-1 thumbprint | `5603104F31C1236A07A3A2E79FA285A11C2B3997` |

离线提取到了签名证书链，随后 Windows 动态测试也通过了安装包与 App 的 Authenticode `Valid` 校验；加载器还比对了指定叶证书 thumbprint。

```text
Installer SHA-256:
6938de412fa9a8481dbeffa84556a6788ae030cc362e789376f7ec3be8893137

Kimi Code.exe SHA-256:
9c6aac3196d3fb2a62e3ff67e6add9f24238efddf661cfcc7088b120f7e478e9
```

官方入口会随版本更新而改变内容。不同哈希需要重新检查，不能把这里的记录当作对未来安装包的验证。

## 采用的运行机制

**2026-11-05 更正：早期实现依赖的 `process._debugProcess(pid)` 在真实安装上不成立。**

原实现假设 Kimi Code 会像普通 Node 进程那样注册 `node-debug-handler-<pid>`，从而接受调试触发。在真实安装的 Kimi Code 1.3.1 上，该注册并不存在，调用直接返回「系统找不到指定的文件」；同一台机器上对普通 Node 子进程调用则成功，因此不是 Node 版本问题。

现在改为通过 Chromium DevTools Protocol 直接注入渲染进程：Kimi Code 以 `--remote-debugging-port=9222` 启动后，`/json/list` 暴露 `app://renderer/sessions/...` 页面，加载器直接在该页执行译文脚本，并注册 `Page.addScriptToEvaluateOnNewDocument` 以便刷新后恢复。链路比原先的「触发主进程 inspector → hook webContents → 转发渲染层」更短，也不再依赖目标进程的 Node 调试映射。

不修改 EXE、不重签、不改 app.asar；进程身份（PID、所属 SID、可执行文件路径、启动时间）仍逐一比对后才注入。

## 验证边界

Mac 可以验证二进制结构、fuse、CSS 契约、进程数据解析、任务参数构造及模拟失败处理。CDP 挂载与页面注入需要 Windows 运行环境。

**2026-11-05 真机验收（Kimi Code 1.3.1，Windows 11，安装在 `%LOCALAPPDATA%\Programs\Kimi Code`）**：

- 以 `--remote-debugging-port=9222` 启动后，CDP 暴露真实会话页 `app://renderer/sessions/session_...`。
- 挂载返回 `status: active`、`loaded: 1`。
- 使用 DeepSeek（经局域网 Magpie）产生真实思考内容后，译文渲染正确：
  - 原文 `PRE.think-text.kct-source-hidden` → `display: none`
  - 译文 `PRE.think-text.kct-translated` → `display: block`
- 插件自诊断：`发现 1 个思考块 / open=true / ctx=true / 状态=ok`。

前提条件：该机器需以带 `--remote-debugging-port=9222` 的方式启动 Kimi Code；计划任务 watcher 会维护挂载，但不会替用户改变启动参数。

Windows 动态测试在全新 GitHub `windows-latest` runner 上使用 Node 24.21.0 x64，解压官方已验证包，未执行官方安装器，未登录真实账户，覆盖：

- 两个先后启动的独立 Kimi 主进程均完成真实内存 hook 挂载，挂载后 9229 关闭。
- 同一进程重复执行加载命令不会产生第二个 Kimi 实例。
- 注册并启动当前用户计划任务，watcher 实际更新状态，Kimi PID 保持不变。
- 停用计划任务后 watcher 安全释放锁，Kimi 保持运行；随后重新启动 Kimi 能再次挂载。
- 测试前后官方 EXE 哈希相同。

另外，三平台共享 UI、缓存和 hook 测试，以及 Windows 加载器模拟测试全部通过，见[回归记录](https://github.com/wssz527/kimi-cot-translate/actions/runs/39645819220)。

目前没有验证真实用户会话里的 Bing 翻译、普通 Windows 10/11 桌面人工操作、真实官方跨版本升级、其他安装位置、管理员权限组合或长期运行。未唤醒或连接局域网用户电脑。
