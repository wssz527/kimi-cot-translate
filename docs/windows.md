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
| 签名叶证书 SHA-1 thumbprint | `F754CEE9121450C6CD50EE89D1CD9E692FE1CA40` |

离线提取到了签名证书链，随后 Windows 动态测试也通过了安装包与 App 的 Authenticode `Valid` 校验；加载器还比对了指定叶证书 thumbprint。

```text
Installer SHA-256:
6938de412fa9a8481dbeffa84556a6788ae030cc362e789376f7ec3be8893137

Kimi Code.exe SHA-256:
9c6aac3196d3fb2a62e3ff67e6add9f24238efddf661cfcc7088b120f7e478e9
```

官方入口会随版本更新而改变内容。不同哈希需要重新检查，不能把这里的记录当作对未来安装包的验证。

## 采用的运行机制

Windows Node 的内部接口 `process._debugProcess(pid)` 会读取目标进程注册的 `node-debug-handler-<pid>` 映射，并通过目标提供的入口触发 inspector。这与 POSIX 的 `SIGUSR1` 实现不同，不能在 Mac 上直接执行 Windows 分支。

实现依据：

- [Node 24.18.0 的进程调试实现](https://github.com/nodejs/node/blob/v24.18.0/src/node_process_methods.cc)
- [Electron 43.1.1 的 Node 环境初始化](https://github.com/electron/electron/blob/v43.1.1/shell/common/node_bindings.cc)
- [Electron fuse 说明](https://www.electronjs.org/docs/latest/tutorial/fuses)

该接口属于 Node 内部能力，必须固定运行环境并验证实际行为。加载器先验证官方签名、Windows 独立哈希、fuse、进程身份和监听端口，再短时挂载内存 hook；不修改 EXE、不重签、不替用户启动第二个 Kimi 实例。

## 验证边界

Mac 可以验证二进制结构、fuse、CSS 契约、进程数据解析、任务参数构造及模拟失败处理。Windows 调试触发、实际签名校验、监听归属和页面挂载需要 Windows 环境。

Windows 动态测试在全新 GitHub `windows-latest` runner 上使用 Node 24.21.0 x64，解压官方已验证包，未执行官方安装器，未登录真实账户，覆盖：

- 两个先后启动的独立 Kimi 主进程均完成真实内存 hook 挂载，挂载后 9229 关闭。
- 同一进程重复执行加载命令不会产生第二个 Kimi 实例。
- 注册并启动当前用户计划任务，watcher 实际更新状态，Kimi PID 保持不变。
- 停用计划任务后 watcher 安全释放锁，Kimi 保持运行；随后重新启动 Kimi 能再次挂载。
- 测试前后官方 EXE 哈希相同。

另外，三平台共享 UI、缓存和 hook 测试，以及 Windows 加载器模拟测试全部通过，见[回归记录](https://github.com/wssz527/kimi-cot-translate/actions/runs/39645819220)。

目前没有验证真实用户会话里的 Bing 翻译、普通 Windows 10/11 桌面人工操作、真实官方跨版本升级、其他安装位置、管理员权限组合或长期运行。未唤醒或连接局域网用户电脑。
