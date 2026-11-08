# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。0.x 阶段 minor 版本可能包含影响兼容性的变更。

宿主（Kimi Code / Electron）兼容性变化不跟随本项目版本号：`supported-runtimes.json` 哈希的新增与失效单独记录在 `docs/compat.md`。

## [0.3.0] - 2026-11-08

### 新增

- **macOS 稳定启动器与原子版本切换**：新增 `runtime-launcher.mjs`，LaunchAgent 只引用数据目录里的稳定入口；运行文件写入 `versions/<sha256>/`，逐个校验 SHA-256 后原子切换 `deployment.json`。普通模块更新不再 `bootout/bootstrap`，只有启动器或 plist 变化才执行带迁移日志的受控迁移。
- **结构化启动结果**：`runtime.mjs --once` 写入 `.last-run.json`，区分 `success` / `waiting` / `transient` / `failed` / `incompatible`，并携带本次启动 ID。启动器只接受 ID 匹配、真实注入成功的结果，不再把“退出码 0 但状态 error”当成健康。
- **`--doctor` 实时诊断**：分别报告安装/版本指针、LaunchAgent、进程发现、Hook 注入、页面挂载、翻译和最近更新；每项标注 `live` / `history` / `unknown`，不把历史 `active` 当成当前已注入。新增 `--repair`，服务未注册时只重新注册，不卸载现有任务。
- **`--refresh` 安全刷新入口**：只对 revision 落后于当前 Hook 的页面调用 `webContents.reload()`；用户设置和缓存保存在 localStorage，不重复注入监听器。`--doctor` 会把这些页面标为 `stale-renderer`。
- **页面健康指标**：`kct.js` 暴露只读 `window.__kct.health()`，hook 汇总每个渲染页面的 revision / stale / blocks / mounted / unsupported / translated / failed；渲染进程退出时清除旧的 loaded 状态。
- **自更新缓存**：下载的运行时文件按清单哈希缓存，重试只补齐缺失或损坏文件；清单变化自动清空缓存，成功后删除。
- **60 秒兜底唤醒**：LaunchAgent 增加 `StartInterval=60`，目录监听漏事件时仍能重新检查。

### 修复

- **候选版本只有真实注入成功才会标记健康**：启动器读取结构化结果；`waiting` / `transient` 保持候选并等待下一次运行，`failed` / `incompatible` 或缺少确认结果时回滚到 `previous`。等待状态不再消耗失败次数，也不会写入 `healthyAt`。
- **自动更新显式禁止 LaunchAgent 迁移**：`deploy` 默认 `allowMigration: false`，自动更新路径强制关闭迁移；即使 `XPC_SERVICE_NAME` 缺失或异常，也只会在切换指针阶段失败并提示终端执行 `--install`，不会 `bootout/bootstrap`。只有 `--install` 和显式终端 `--update` 允许迁移。
- **运行锁增加所有者启动时间**：锁目录写入 `pid` + `owner.json`（含进程启动时间）；PID 被复用时启动时间不匹配才回收，无法验证时保守保留，避免误删有效锁。
- **渲染器版本滞后可被识别**：Hook 比较自身 revision 与页面 revision，`--doctor` 报告 `stale-renderer`，不再把旧页面上的新 Hook 误报成新版页面。
- **更新失败有界退避**：检查成功才记录 `updateCheckedFor`；网络或校验失败按 1/5/30 分钟退避，最多 4 次，同一进程不重复下载相同文件。
- **签名验证成为放行条件（macOS）**：恢复 `codesign --verify` 对官方签名、标识和团队身份的校验；失败停止挂载。打包 CSS 只作辅助证据，实时页面在注入后检查，避免官方改类名/资源名导致误停。
- **迁移恢复顺序**：迁移日志在服务恢复成功后才删除，bootstrap 失败时下次仍可重试；`--repair` 会先确认稳定入口确实带 `launch()`，避免把旧加载器重新注册成后台服务。
- **诊断与注入互斥**：`--doctor` 的实时探测先获取运行时锁，忙时报告 `busy`，不与 `--once` 争用 inspector 端口。

### 修复（第三轮审查返工）

- **v0.2.11 旧用户可安全进入新架构**：新增旧布局识别与一次性迁移。显式 `--install` 时写迁移日志、暂停服务、把磁盘上的旧五文件存成独立可回滚版本、再存新六文件、替换稳定入口与 plist，失败自动还原旧入口/plist 并重启旧服务。自动更新路径绝不 `bootout`，只做文件级迁移并原地替换入口（路径不变，launchd 无需改动），下一次触发由启动器完成确认。
- **旧更新器留下的半迁移状态可自愈**：v0.2.11 的更新器只下载自己那五个文件，可能留下“五个文件已换新但没有启动器、没有版本指针”的安装。`migrateLegacyInPlace()` 会核对磁盘文件与发布清单一致后只补拉 `runtime-launcher.mjs`，重建版本目录与指针。
- **候选版本必须实时验证**：候选启动跳过一切历史状态复用，强制重新验证应用签名、重新注入 Hook 并读取页面。`launchOutcome` 要求本次运行有 `liveVerified`；历史 `active` 记录只能得到 `transient`。自相矛盾的“声称 active 但未实时验证”按失败处理并回滚。
- **页面 revision 分层统计**：Hook 现在区分“页面已挂载”和“本 revision 已挂载”。旧页面继续回答 `loaded` 时记为 `stale`，不再被计为成功注入；`health()` 返回 current / stale / pending / unresponsive 四类计数，只有当前 revision 的页面参与渲染健康判断。
- **旧渲染器不会被误判为失败**：Hook 装好但打开的窗口仍跑旧 `kct.js` 时结果是 `transient`，候选保持待确认；连续 3 次启动后标记 `rendererStale` 并记录 `--refresh` 提示，而不是无限等待或错误回滚。
- **无回滚目标时不留下损坏安装**：候选失败且没有 `previous` 时，稳定入口直接运行当前版本并标记 `degraded`，而不是让安装停在无法启动的指针上。

- **五文件安装可以自我修复**：旧版更新器只部署五个文件，新版 `runtime.mjs` 可能成为没有 `runtime-launcher.mjs` 的入口。迁移现在按「识别旧布局 → 取发布清单 → 校验本地五文件 → 下载并校验启动器 → 原子写入并复核 → 才动态导入启动器」的顺序执行，不再在启动器存在之前导入它。任何一步失败都不写入指针，旧文件保持可运行，下次启动自动重试。
- **入口类型判定不再依赖单个字符串**：`runtime.mjs` 自身含有启动器的函数签名（用于校验），只看签名会把运行时误判成启动器。判定改为「含 `launch(` 且不含 `tick(`」。

### 测试

- 新增 `legacy-bootstrap.test.mjs`（5 项）：在完全隔离的临时目录里只放旧版五文件，从该目录的 `runtime.mjs` 启动迁移，用本地模拟下载验证启动器获取、校验、安装与指针一致性，并覆盖下载失败保留可运行旧文件、重试成功、本地文件被篡改时拒绝迁移。
- 新增 `legacy-upgrade.test.mjs`（14 项），直接以 `v0.2.11` 标签下的原始代码作为升级入口，覆盖旧更新器漏掉启动器、半迁移自愈、显式/自动迁移、迁移失败还原、旧版回滚、诊断读取、stale 渲染器宽限与 waiting 不消耗失败次数。
- macOS 运行时套件增至 71 项，新增历史 `active` 强制实时注入、Hook 缺失、Inspector 不可用、页面未挂载、无思考区块、页面分层统计与重试退避测试。
- 通用 145、macOS 85（含升级测试）、Windows 39、VS Code 12、浏览器 25+2（2 项真实浏览器检查按设计跳过）全部通过；`runtime-manifest.mjs --check` 通过。

## [0.2.11] - 2026-11-08

### 修复

- **macOS 的 LaunchAgent 重注册失败会自动重试**：官方升级触发 `--update` 时，`deploy` 先 bootout 再 bootstrap；launchd 偶尔会拒绝 bootout 之后的第一次 bootstrap，而失败路径只回滚了 plist 文件、没有把服务装回来——后台任务从此停摆，既不挂载也不检查更新。Kimi Code 1.3.2 升级当晚就发生了整整一天。现在 bootstrap 失败会先重试一次，仍失败则回滚并重启旧服务。

## [0.2.10] - 2026-11-06

### 修复

- **更新清单不再经由会缓存分支的 CDN**：jsDelivr 按 URL 缓存，`@main` 会长期返回旧清单，而旧清单里的哈希与实际文件不符，更新必然卡在哈希校验。回退源改用 `cdn.statically.io` 与 `ghproxy.net`（均透传当前内容）。下载运行时文件仍逐个校验 SHA-256。
- 已发布标签视为不可变：0.2.8 的标签在本轮被移动过，导致 CDN 持续返回旧清单。此后只递增版本号，不移动已发布标签。
- `runtime-manifest.mjs --check` 增加校验：清单必须钉在自己版本号的标签上，否则 CI 失败。

## [0.2.9] - 2026-11-06

### 修复

- 改用新的版本号发布，避免复用任何已发布过的标签。

## [0.2.8] - 2026-11-05

### 修复

- **Windows 补上自动更新**：此前只有 macOS 的 `--once` 会检查更新清单，`runtime-windows.mjs` 完全没有更新代码，`runtime-manifest.json` 也只列了 5 个 macOS 核心文件、不含 Windows 加载器本身。Windows 安装因此永远不会跟版。现新增 `runtime-manifest-windows.json`（8 个文件，含 `runtime-windows.mjs` 与 `windows-bridge.ps1`），Windows 在每次 Kimi 启动后检查一次，下载后逐文件校验 SHA-256，暂存到数据目录，再在释放锁后由同一进程完成安装并重新注册计划任务。新增手动入口 `node runtime-windows.mjs --update`。为支撑两端差异，`runtime-update.mjs` 的清单校验与下载改为接受文件列表参数。
- 更新改为「暂存 → 释放锁 → 原地安装」，不再 spawn 独立进程：计划任务 watcher 整场持有 bundle 锁，独立安装进程会一直等不到锁；而在 SSH 会话里启动的 detached 进程还会随会话结束被终止。现在 `--once` / `--update` 先暂存到 `.update-stage-*`，释放锁后由同一进程调用 `install`（它会先写 stop 文件让 watcher 自行退出并让出锁）。
- **bridge 脚本改从已部署的 bundle 取路径**：`install` 从暂存目录运行时，`windows-bridge.ps1` 的默认路径也落在暂存目录；安装返回后该目录即被删除，紧接着的 `Start`（以及 `Disable`）必然报「找不到 .ps1 文件」，此前会误报为「已安装但无法启动」。现在 `Install` 直接指向新 bundle，后续 `Start` 也使用已部署路径。
- 安装后清除 `.update-stage-*` 暂存目录，避免每次更新留下整份运行时副本。
- **更新源增加国内可直连镜像**：真实 Windows 机器上 `raw.githubusercontent.com` 的 TCP 443 能连上但 HTTPS 请求超时（典型的大陆网络情况），自动更新因此一直失败。现在清单与每个运行时文件都先试官方域名，失败后自动改用 jsDelivr（`cdn.jsdelivr.net/gh/wssz527/kimi-cot-translate@<ref>/...`），下载内容仍逐个校验 SHA-256。
- 计划任务启动改为短暂重试：Task Scheduler 接受启动请求是异步的，刚注册的任务可能拒绝第一次请求，此前会被误报为「已安装但无法启动」。
- **watcher 暂存后必须继续安装**：`--watch` 在暂存更新后直接返回，而 `main()` 只打印结果——计划任务模式下每次只下载、永不安装，Windows 自动更新实际上仍是坏的。现在 `--watch` 返回后由同一进程继续执行安装。
- **watcher 安装后要能接替**：计划任务是 `-MultipleInstances IgnoreNew`，watcher 自己调 `install()` 时又处在运行中，`Install` 会等自己退出（必然超时），`Start` 也会被丢弃。现在 watcher 走 `skipWait` 跳过自等待，并由新增的 `Restart` 动作安排一个延迟助手，在本进程退出后启动新任务。
- **bridge 失败信息不再被吞掉**：`execFile` 只给「Command failed」，PowerShell 的真实 stderr 丢失。现在把 stderr 最后一行带入错误信息。
- PowerShell 侧改用 `PSObject.Properties` 读取可选字段：`Set-StrictMode -Version Latest` 下访问缺失属性会抛错，新增的可选字段因此无法安全缺省。
- **安装不再等待旧 watcher 退出**：计划任务是 `-ExecutionTimeLimit 0`，watcher 常驻，等待只会超时。实测这段等待耗掉 24.4 秒并超过 bridge 的 20 秒超时，导致每次更新都失败。已移除；`-Force` 注册本身会覆盖旧任务。bridge 超时同时放宽到 45 秒。
- **更新后任务要重新注册**：此前 `Restart` 只是启动了旧任务，任务执行体仍指向旧 bundle，于是「装好了但跑的还是老版本」。现在延迟助手读取 `enabled.json`，用其中的路径重新注册任务并启动（新增 `Reload` 动作）。

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
