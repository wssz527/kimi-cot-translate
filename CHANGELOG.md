# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。0.x 阶段 minor 版本可能包含影响兼容性的变更。

宿主（Kimi Code / Electron）兼容性变化不跟随本项目版本号：`supported-runtimes.json` 哈希的新增与失效单独记录在 `docs/compat.md`。

## [Unreleased]

## [0.2.8] - 2026-11-05

### 修复

- **Windows 补上自动更新**：此前只有 macOS 的 `--once` 会检查更新清单，`runtime-windows.mjs` 完全没有更新代码，`runtime-manifest.json` 也只列了 5 个 macOS 核心文件、不含 Windows 加载器本身。Windows 安装因此永远不会跟版。现新增 `runtime-manifest-windows.json`（8 个文件，含 `runtime-windows.mjs` 与 `windows-bridge.ps1`），Windows 在每次 Kimi 启动后检查一次，下载后逐文件校验 SHA-256，暂存到数据目录，再由独立进程 `--apply-update` 完成安装并重新注册计划任务。新增手动入口 `node runtime-windows.mjs --update`。为支撑两端差异，`runtime-update.mjs` 的清单校验与下载改为接受文件列表参数。
- 计划任务 watcher 不自行安装更新：它整场持有 bundle 锁，因此只暂存，随后退出循环释放锁，再由独立进程接手，避免与自身文件死锁。安装成功后清除 `.update-stage-*` 暂存目录，避免每次更新留下整份运行时副本。

## [0.2.7] - 2026-11-05

### 修复

- **macOS 不再要求官方签名**：与 Windows 对齐，`codesign` 结果只记入 `signature` 字段供诊断，不再作为放行条件。此前官方轮换证书、或宿主被重签后，即使 inspector fuse 与思考区块结构都完好，插件也会永久停用。真正保护挂载的仍是注入前的进程身份校验（PID、启动时间、可执行文件路径）。
- **删除 Windows 侧已失效的 inspector 代码**：`triggerInspector`、`inspectorOperations` 以及 `--once` 里对 `blocked-inspector` 的退出码判断，在改用 CDP 后已无调用方，一并移除。`blocked-inspector` 现在只由 macOS 的 Node inspector 收尾路径产生。
- **Windows 生命周期锁不再因并发竞争而抛错**：两个加载器同时抢锁时，Windows 对「正在创建或删除」的目录返回 `EPERM` / `EACCES` / `ENOTEMPTY`，而代码只把 `EEXIST` 当作「已被占用」，其余直接上抛——CI 上表现为 `EPERM: operation not permitted, mkdir '.runtime-lock.reclaim'`，实机上会让计划任务在一次失败后写出 error 状态。现按同类竞争处理，直接让出锁。
- **Windows 实机测试脚本对齐 CDP 语义**：此前仍断言 `inspectorClosed` 与 9229 端口，改为以 `--remote-debugging-port=9222` 启动并断言 9222 的释放，同时避免测试进程被误当成用户实例。

### 文档

- 中英 README、`SECURITY.md`、`docs/windows.md` 同步：校验流程改为「进程身份 → inspector fuse → 渲染结构」，说明签名与版本号只记录、不参与放行；Windows 补上 `--remote-debugging-port=9222` 的一次性设置方式（快捷方式「目标」追加参数），并说明终端直接启动时不会带该参数。

## [0.2.6] - 2026-11-05

0.2.3–0.2.6 的改动此前未单独归档，一并记在此版本下。

### 新增

- 后台任务改为事件驱动：LaunchAgent 不再每 10 秒轮询，改为 `WatchPaths` 监听 Kimi Code 的用户数据目录，Kimi 关闭期间完全不被唤醒。
- 运行时自更新：每次 Kimi Code 启动后检查一次仓库发布的更新清单（`runtime-manifest.json`），发现新版本时下载运行时文件、逐个校验 SHA-256，再通过既有的原子部署路径替换（失败自动回滚）。同一 Kimi 进程只检查一次，Kimi 未运行时不发起任何网络请求。新增 `node runtime.mjs --update` 手动入口；`--check` 输出新增 `updateStatus` / `updateVersion` / `updateCheckedFor` 字段。
- 未知内核哈希不再直接熔断：改为在 inspector fuse 与思考区块结构同时成立时放行，并记 `verified: "contract"`（0.2.6 及以前还要求官方签名，0.2.7 起不再要求）。官方升级只要不改思考区块结构即可继续工作，无需等待新版或重装。

### 修复

- **隐藏窗口不再导致翻译停滞**：工具栏显示与翻译调度原本只由 `requestAnimationFrame` 驱动，而 Chromium 在窗口最小化或处于后台时完全暂停 rAF（实测 `visibilityState: hidden` 时一帧都不产生）。因此展开思考块后界面毫无反应，看起来像没有挂载。改为 rAF + 250ms 定时器兜底，并保留原有合并行为。
- **Windows 注入改为 CDP**：早期实现依赖 `process._debugProcess(pid)`，它要求目标进程注册 `node-debug-handler`，而真实安装的 Kimi Code 并不注册，调用直接失败（`系统找不到指定的文件`）。改为通过 `--remote-debugging-port` 直接注入渲染进程，并在真机（Kimi Code 1.3.1）验证译文正确显示。
- **Windows 不再要求官方签名**：本插件是免费的第三方显示层工具，宿主是否由官方签名与翻译能力无关。证书轮换曾导致整个 Windows 端失效，现改为记为 `signature` 字段仅供参考。
- **Windows 允许非标准安装路径**：安装器可指向其他盘符，加载器按实际目录识别，进程发现使用同一路径。
- **Windows 不再误判自身子进程**：Kimi Code 通过同一可执行文件启动 `./bin/kimi-datasource.mjs` 等辅助脚本，它们此前被计为第二个主实例，导致拒绝挂载。
- 移除 Electron 主版本白名单：此前即使结构与注入能力都成立，只要宿主的 Electron 主版本不在硬编码列表（如 43 → 45）就永久停用。版本号现在只用于状态展示，不再参与放行判断。
- Windows 二进制校验同样改为按能力放行：不再要求哈希必须在允许列表内，也不再限定 `Electron/43.1.1`；未知构建按 PE、fuse 与结构判定，记 `verified: "contract"`。
- macOS 进程发现改用进程表精确匹配：`pgrep -x "Kimi Code"` 无法匹配含空格的进程名，会导致「Kimi Code is not running」的误判，后台任务因此不再挂载。
- 版本号内置于 `runtime-update.mjs`：部署目录没有 `package.json`，原实现每次运行都会因读取失败在日志里留下错误。

- 翻译失败治理：429 按 `Retry-After` 冷却并暂停对应服务队列；5xx/网络错误指数退避（上限 2 次、带抖动）；失败按片段做 30 秒负缓存，流式期间不再重复轰炸已失败段落；浏览器扩展透传错误状态码与冷却时间。
- 自定义端点切换 origin 时清除旧 API key，防止旧凭据被带往新服务；远程自定义端点要求 HTTPS（本机地址除外）；自定义请求禁止重定向。
- 运行时加载器的一次瞬时失败不再永久停用翻译：区分永久不兼容、触发前瞬时失败（退避后自动重试）与触发后不确定状态；Windows watcher 增加异常边界。
- 分段策略：代码块、行内代码与纯 URL 保留原文不再送翻；相邻需翻译句子合并到长度预算后再请求；自定义服务改为批量请求；修复 `Dr.`、`e.g.` 等缩写误切。
- 译文缓存改为防抖合并写盘，不再每批次全量序列化同步写 localStorage。
- 流式渲染按帧合并，长思维链不再每片段重写全文。
- Bing 批量翻译支持部分成功：失败条目单独降级重试，不再整批作废。
- CLI 多个并发工具授权请求不再使交互悬挂。

## [0.1.0] - 2026-10-22

首个公开发布。

### 入口与状态

| 入口 | 状态 |
| --- | --- |
| Kimi Code 桌面端（macOS Apple Silicon） | 已验证真实翻译、正常启动恢复及页面刷新恢复 |
| Kimi Code 桌面端（Windows x64） | 预览适配；CI runner 已验证挂载、安装不重启、安全停用及冷启动恢复 |
| Kimi Code CLI（ACP 翻译终端） | 已验证真实模型与 Bing 翻译 |
| Kimi Code Web（浏览器扩展） | 官方 2.1.1 真实会话实测通过 |
| kimi.com 普通聊天页 | 实验实现；未在登录会话验收 |
| VS Code 复制预览 | 共享引擎测试通过；未在真实扩展宿主验收 |

### 已知限制

- 仅验证 Kimi Code 1.1.1 / Electron 43.1.1；宿主更新后可能停用，等待适配（见 `docs/compat.md`）。
- 真实跨版本升级、睡眠唤醒、长期运行尚未验收。
- 翻译使用公共免鉴权端点（Bing / Google），无 SLA，可能限流或变更。
- 自定义服务的 API key 明文保存在本机 localStorage。
