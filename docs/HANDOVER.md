# KCT（kimi-cot-translate）交接文档

> 最后更新：2026-11-08 · 当前版本：v0.3.0 · 维护者：wssz527
>
> 交接对象：任何接手本项目的开发者（或未来的维护会话）。读完这一篇，应该能独立完成日常维护、发版和故障排查。

---

## 1. 项目是什么

KCT 是一个**非官方的免费开源插件**（MIT），为 Kimi Code 的思维链（思考过程）提供实时中文/多语言翻译。核心原则：

- **不修改官方 App**：不动 EXE、不重签、不改 `app.asar`。只通过调试接口向运行中的进程注入内存脚本。
- **第三方显示层工具**：宿主是否官方签名与「能不能翻译」无关，签名只记录不拦截（用户明确决策）。
- **版本号不参与放行**：官方升级只要不动思考区块的 DOM 结构、不关调试能力，翻译就继续工作。

### 支持的入口

| 入口 | 注入方式 | 成熟度 |
| --- | --- | --- |
| macOS 桌面（Kimi Code.app） | SIGUSR1 触发 Node inspector，主进程内存 hook | ✅ 真机长期验证 |
| Windows 桌面 | CDP（`--remote-debugging-port=9222`）直接注入渲染进程 | ✅ 真机验证 |
| Kimi Code CLI（ACP） | 独立翻译终端 | ✅ 真机验证 |
| Kimi Code Web / kimi.com | Chromium MV3 浏览器扩展 | 真实验证 / 部分验证 |
| VS Code | 复制思考后独立预览翻译 | 结构验证 |

### 仓库与发布

- 仓库：`https://github.com/wssz527/kimi-cot-translate`（main 分支，本地克隆在 `~/AgentProjects/kimi-cot-translate`）
- 发版方式：打 `v*` 标签推送 → GitHub Actions `release.yml` 自动跑测试、构建、附产物（zip / VSIX / SHA256SUMS）
- 自更新：已安装用户的加载器在每次 Kimi 启动后读 `runtime-manifest.json`（macOS）/ `runtime-manifest-windows.json`（Windows），比对新版本后下载、逐文件校验 SHA-256、原子替换

---

## 2. 当前状态（交接时快照）

### 用户的真实环境

| 机器 | 说明 |
| --- | --- |
| **Mac（本机）** | Kimi Code **1.3.2**（Electron 45.x），KCT 0.3.0 已挂载运行。数据目录 `~/Library/Application Support/kimi-cot-translate/`，LaunchAgent `com.user.kimi-cot-translate.runtime` |
| **Windows 局域网机** | `ssh wssz-win`（192.168.0.107，用户 wssz2），Windows 11，Kimi Code 1.3.x 装在 `%LOCALAPPDATA%\Programs\Kimi Code`。KCT 0.2.10/0.2.11 已验证。快捷方式已加 `--remote-debugging-port=9222` |

### 测试基线（全部通过）

```
npm test              142 项（共享 UI / hook / ACP）
npm run test:macos     60 项（macOS 加载器 / 启动器 / 诊断 / 锁）
npm run test:windows   39 项（Windows 加载器模拟）
npm run test:vscode    12 项（VS Code）
npm run test:browser   25+2 项（2 项依赖真实浏览器，跳过属正常）
```

CI（`.github/workflows/tests.yml`）在 ubuntu / windows / macos 三平台跑；`release.yml` 打标签触发；`windows-live.yml` 手动触发，解压真实官方安装包做全链路 smoke（官方包更新后按设计失败，需人工核对哈希）。

### 环境注意事项

- 本机访问 GitHub 走 `127.0.0.1:7890`（mihomo）代理，**偶发中断**。推送失败时先 `curl api.github.com` 探测，等几分钟重试即可，不要乱改配置。
- Windows 真机直连 `raw.githubusercontent.com` 会 TLS 超时（大陆网络），必须走 CDN 回退（见 §5）。
- Windows 上 SSH 会话（session 0）无法操作 GUI、无法拉起交互进程；验证 GUI 行为要用计划任务或让用户操作。

---

## 3. 架构速览

### 共享核心（三端复用）

- `kct.js`（59KB）——翻译引擎 + UI：Bing/Google/自定义端点、缓存（500 条 / 2MiB / 7 天）、语言判断、增量翻译、原文切换、`window.__kct.health()` 只读状态
- `runtime-hook.mjs` ——注入到宿主主进程的 hook，负责把 `kct.js` 送进每个渲染进程；渲染进程退出时清除 loaded 状态，并向诊断提供页面健康指标

### macOS 稳定启动器（`runtime-launcher.mjs` → 部署为 `runtime.mjs`）

- LaunchAgent 只执行数据目录里的稳定入口 `runtime.mjs`，并带 `StartInterval=60` 作为 `WatchPaths` 的兜底。
- 入口只做版本选择：校验 `deployment.json` 指向的版本目录（六个文件的 SHA-256），在版本目录里启动真正的 `runtime.mjs`。
- 普通更新只写 `versions/<id>/` 并原子切换指针，不执行 `bootout/bootstrap`；新版本 `--once` 写入结构化 `.last-run.json`，只有 `outcome: success` 才把候选标记为健康；`waiting` / `transient` 保持候选，`failed` / `incompatible` 回滚到 `previous`。
- 只有启动器或 plist 本身变化才执行受控迁移：写迁移日志 → bootout → 切指针 → 替换稳定入口/plist → bootstrap；崩溃后下一次运行按日志恢复旧入口、旧 plist、旧指针并重新注册服务。
- 流程：发现进程 → 校验（官方签名与团队身份 + 进程身份 + inspector fuse）→ SIGUSR1 开临时 inspector（12 秒自动关闭）→ 安装内存 hook → 关端口确认。
- 状态文件 `runtime-state.json`；诊断 `--doctor`；修复注册 `--repair`；自更新 `--update`。

### Windows 加载器（`runtime-windows.mjs` + `windows-bridge.ps1`）

- PowerShell bridge 负责 Discover / Signature / Install / Restart / Reload / Disable（编码参数传递，`Set-StrictMode` 下可选字段必须走 `PSObject.Properties`）
- 流程：计划任务 watcher 常驻 → 发现进程 → 校验 → CDP 注入渲染进程 → `Page.addScriptToEvaluateOnNewDocument` 保证刷新存活
- 安装 = 新 bundle 目录 + 重写 `enabled.json` + 重注册计划任务；watcher 自更新走「暂存 → 释放锁 → 同进程安装 → 延迟助手重启任务」（`Reload` 动作）

### 更新基础设施

- `runtime-update.mjs`：清单获取（官方域名 → `cdn.statically.io` / `ghproxy.net` 透传回退）→ 下载 → 逐文件哈希校验；`cacheDir` 复用已校验文件，清单变化时清空缓存
- `scripts/runtime-manifest.mjs`：生成/校验清单（macOS 六个文件，含 `runtime-launcher.mjs`）；`--check` 会验证清单钉在自己版本的标签上
- `scripts/version-sync.mjs`：从根 `package.json` 同步版本到 browser/vscode/cli/runtime-update
- 自更新在注入完成后才发起；失败按 1/5/30 分钟退避，最多 4 次，成功才记录 `updateCheckedFor`

---

## 4. 硬性规则（违反会出事故）

1. **已发布的 git 标签不可移动。** jsDelivr 按 URL 缓存（含 tag），移动标签会让 CDN 持续返回旧清单，所有客户端哈希校验失败。只递增版本号。（0.2.8 的教训，见 §6）
2. **清单必须钉在自己版本的标签上**，`runtime-manifest.mjs --check` 会拦截，CI 已接入。
3. **不手工添加未知 Electron / 官方包哈希**到 `supported-*.json` 或 `windows-live.yml`。哈希只能来自真实隔离验证。
4. **PowerShell bridge 禁止 `Stop-Process` / `Stop-ScheduledTask` / `taskkill`**（会杀掉用户正在看的翻译会话），有测试守护这条规则。
5. **改思考区块选择器必须带证据**（上游公开 commit / 资源 URL）并更新 `docs/` 对应文档。
6. **CI 里的 macOS job 可能因 GitHub runner 容量不足失败**（报 "not acquired by Runner"）。这不是代码问题，本地 `npm run test:macos` 通过即可。
7. **LaunchAgent 只指向稳定入口。** 普通模块更新禁止 `bootout/bootstrap`；自动更新路径显式 `allowMigration: false`，即使 `XPC_SERVICE_NAME` 缺失或异常也不得迁移；只有显式 `--install` 或终端 `--update` 可以受控迁移。
8. **版本目录与指针不可手工编辑。** `deployment.json` 只由 `runtime-launcher.mjs` 写；每个版本目录用 `.bundle.json` + 六文件哈希校验，迁移日志未清时不得绕过恢复。
9. **候选版本健康必须有结构化注入确认。** `--once` 的退出码 0 不等于成功；启动器只接受 ID 匹配的 `.last-run.json` 中 `outcome: success`，等待/临时状态不得写入 `healthyAt`。
10. **页面刷新只通过 `--refresh` 或用户手动刷新。** 安装和更新不得自动刷新页面，避免丢失未保存界面状态。

---

## 5. 关键设计决策（不要回退）

> 本节以当前重构分支为准；与 0.2.11 及更早文档冲突处，按本节执行。

| 决策 | 原因 |
| --- | --- |
| macOS 以官方签名与团队身份作为放行条件；Windows 仍只记录 `describeSignature` | 本次任务明确要求保留官方签名校验，签名失败即停止挂载。代价是官方轮换证书/团队时需要更新代码中的签名要求；这是安全边界，不绕过 |
| 版本号不参与放行 | 跨 Electron 大版本（43→45）已实测无碍；熔断在「官方签名 / inspector fuse」，实时页面结构由 `--doctor` 报告 |
| 稳定启动器 + 版本目录 + 原子指针 | 普通更新不触碰 LaunchAgent；断电或崩溃可回到上一完整版本 |
| 结构化启动结果 + 真实注入确认 | 退出码 0 不能证明注入成功；等待状态不能被当成健康或消耗失败次数 |
| 自动更新 `allowMigration: false` | 不依赖环境变量识别执行上下文，自动路径永远不会卸载自身服务 |
| 页面 revision 比较 + `--refresh` | 旧页面保留旧 `kct.js` 时明确报告 `stale-renderer`，只重载落后页面，不清除设置 |
| 锁所有者 `pid + startedAt` | 防止 PID 复用让陈旧锁永久占据；无法验证时保守保留 |
| 只有启动器/plist 变化才迁移 | 避免自更新在服务进程内卸载自身；迁移有日志，可恢复旧入口、旧 plist、旧指针 |
| 自更新缓存已校验文件、失败有界退避 | 网络中断不破坏当前版本，也不无限重试或重复下载 |
| 打包 CSS 只作辅助证据 | 官方改类名/资源名不应误停；实时页面在注入后由 health 检查 |
| Windows 走 CDP 而非 `process._debugProcess` | 后者要求宿主注册 `node-debug-handler`，真实 Kimi Code 不注册，永远失败 |
| Windows 更新走「暂存 → 释放锁 → 同进程安装 → `Restart`/`Reload` 延迟助手」 | watcher 整场持有 bundle 锁且自身就是要被替换的任务实例；独立 detached 进程在 SSH 会话下会被清理 |
| 更新回退源不用 jsDelivr | jsDelivr 按 URL 缓存**分支引用**，`@main` 会长期返回旧清单 → 哈希必然失配。用透传代理 |
| `--once` 同一 Kimi 进程最多查 4 次更新 | `updateCheckedFor` 记录成功的进程身份；失败按 1/5/30 分钟退避，重启 Kimi 重新计数 |
| revision = hash(kct.js + hook + loader + supported) | 注意 **不含 runtime-update.mjs / runtime-launcher.mjs**，所以只改更新器或启动器的小版本 revision 不变，是设计使然，不是 bug |

---

## 6. 血泪史（已修的坑，改动相关代码前先读）

按时间序，全部有真机证据，详细记录在 `CHANGELOG.md` 0.2.3–0.3.0 各节：

1. **Electron 大版本白名单**（0.2.3 移除）：官方 43→45 曾导致永久停用。
2. **Windows `_debugProcess` 不成立**（0.2.5 改 CDP）：对真实 Electron 安装永远报「找不到文件」。
3. **官方签名轮换导致 Windows 全灭**（0.2.5/0.2.7 去门禁）：`5603104F…` → `187C364D…`。Windows 侧保持只记录；macOS 在本次重构中重新要求官方签名，轮换时必须更新签名要求。
4. **隐藏窗口 rAF 停摆**（0.2.6）：rAF + 250ms 定时器兜底。
5. **Windows 锁竞争报 EPERM**（0.2.7）：Windows 对「创建/删除中」的目录返回 EPERM/EACCES/ENOTEMPTY，不只 EEXIST。
6. **Windows 自动更新整条链路缺失 + 7 个连环坑**（0.2.8–0.2.10）：更新器从未在 Windows 实现过；修的过程中发现 watcher 不安装、装完没人接替、bridge 路径指向将被删除的暂存目录、等待常驻 watcher 退出（24s 超时）、任务不重注册、stderr 被吞、CDN 缓存旧清单。**每一条都有真机复现**。
7. **macOS LaunchAgent 重注册失败导致服务消失一天**（0.2.11，最新）：官方升 1.3.2 时 bootstrap 被 launchd 拒绝，失败路径只回滚了 plist 没恢复服务。现在 bootstrap 自动重试一次，仍失败则回滚文件并恢复旧服务。
8. **CDP 端口 9222 必须由快捷方式带上**（Windows）：终端裸启 `kimi` 不带参数，加载器会明确报「未监听调试端口」等待，不会误判为损坏。
9. **独立复核发现的四个缺口**（0.3.0）：候选 `--once` 退出码 0 不代表注入成功；自动更新仅靠 `XPC_SERVICE_NAME` 识别执行上下文；旧页面保留旧 `kct.js` 却可能报告新版成功；锁只用 PID 存活判断会被复用的 PID 永久占据。现在分别用结构化 `.last-run.json`、显式 `allowMigration: false`、`stale-renderer`/`--refresh`、`pid + startedAt` 修正。

---

## 7. 日常操作手册

### 发版（全部命令）

```sh
cd ~/AgentProjects/kimi-cot-translate
npm version <x.y.z> --no-git-tag-version   # ① 根 package.json 为唯一真源
node scripts/version-sync.mjs              # ② 同步到 browser/vscode/cli/runtime-update
node scripts/runtime-manifest.mjs          # ③ 重新生成两个清单（macOS 六个文件）
node scripts/runtime-manifest.mjs --check  # ④ 校验（CI 也会跑）
# 跑全量测试（macOS 60 项）→ commit → push main → 打标签 push
git tag -a v<x.y.z> -m "v<x.y.z>" && git push origin v<x.y.z>
# Release 工作流自动构建上传；RELEASE_NOTES.md 即发布说明
```

发版后验证：`gh run list`（Release + Tests 全绿）→ 用 `resolveUpdate` + `downloadBundle` 模拟一次客户端更新，确认哈希匹配。若新增或删除运行时文件，必须同步 `BUNDLE_FILES`（launcher）、`RUNTIME_FILES`、`CORE_FILES`、`MANIFESTS`；漏一处会让版本目录校验或自更新失败。

### 排查「翻译不显示」（macOS）

```sh
D="$HOME/Library/Application Support/kimi-cot-translate"
node "$D/runtime.mjs" --check        # 最近一次后台检查（历史，不是实时证明）
node "$D/runtime.mjs" --doctor       # 实时：安装/服务/进程/注入/页面/翻译/更新
node "$D/runtime.mjs" --repair       # 服务未注册时只重新注册，不卸载现有任务
node "$D/runtime.mjs" --refresh      # 只刷新 revision 落后的页面
cat "$D/deployment.json"             # current / previous / candidate / blocked
tail -5 "$D/runtime.log"
launchctl list | grep kimi-cot       # 空 = LaunchAgent 没注册
node "$D/runtime.mjs" --once         # 手动跑一轮
node "$D/runtime.mjs" --install      # 迁移或重装稳定入口
```

判断口诀：`--check` 的 `active` 只是上次运行记录，不能证明当前页面仍挂着；先看 `--doctor`：`injection.status: loaded` + `page.status: mounted` 才是实时确认，`translation.status: working` 才说明翻译成功；`page.status: stale-renderer` 表示页面仍运行旧脚本，执行 `--refresh` 或手动刷新。`--check` 的 `waiting` = 没找到合规进程；`error` + `detail` = 看关键字（`signature or signing identity` = 签名/团队不匹配；`reasoning UI changed` = 上游改结构；fuse 被禁 = 无法注入）。LaunchAgent 消失 = 先 `--repair`，无效再 `--install`。

### 排查「翻译不显示」（Windows）

```powershell
node runtime-windows.mjs --check
```

- `error: Kimi is not listening on the debugging port 9222` → 快捷方式没带参数，或从终端裸启的
- 确认任务：`Get-ScheduledTask KimiCoTTranslate-Windows-*`（State 应为 Running）
- `enabled.json` 指向当前 bundle；`Get-NetTCPConnection -LocalPort 9222` 确认 CDP 在听

### 远程验证 Windows 真机（从 Mac）

```sh
ssh wssz-win 'powershell -NoProfile -Command "node \"$env:LOCALAPPDATA\kimi-cot-translate\windows\..\..\..\" 2>&1"'
# 常用：检查计划任务、runtime-state.json、CDP 端口
```

注意：SSH 会话里 `Start-Process` 起的延迟进程会随会话结束被清理，**不能**用来验证延迟重启逻辑；要看真实效果需在计划任务上下文跑。

---

## 8. 待办与已知边界

- **未验收**：官方跨版本升级全流程（1.3.2→1.4 之类）、睡眠唤醒、长期运行、多用户切换。
- **本重构已在本机 Kimi 1.3.2 做过一次真实安装、候选健康确认、stale-renderer 检测与 `--refresh` 验收**；官方真实跨版本升级仍未执行。
- **kimi.com 登录会话、VS Code 真实扩展宿主**未验收（README 已声明）。
- **翻译端点**：Bing（默认）/ Google 为公共免鉴权端点，无 SLA；自定义端点支持 OpenAI 兼容格式，key 明文存 localStorage（已披露）。
- **`revision` 不含 `runtime-update.mjs` / `runtime-launcher.mjs`**：只改更新器或启动器时，客户端 revision 不变。若未来改动影响注入的文件集合，记得检查 `CORE_FILES`（macOS）/ `FILES`（Windows）与清单脚本的 `MANIFESTS` 是否同步。
- **docs/compat.md** 记录宿主兼容性变化；官方升级后如有结构变化需更新 `supported-*.json` 并附验证记录。

---

## 9. 文件地图

```
kct.js                    翻译引擎+UI（三端共享核心）
runtime-launcher.mjs      稳定启动器（版本目录 / 原子指针 / 启动失败回滚 / 迁移日志）
runtime.mjs               macOS 运行时（进程校验 / inspector / deploy / doctor / 自更新）
runtime-hook.mjs          注入主进程的 hook
runtime-update.mjs        自更新核心（清单/下载/哈希），版本号内嵌（RUNTIME_VERSION）
runtime-windows.mjs       Windows 加载器（CDP / 计划任务 / bundle 安装）
windows-bridge.ps1        PowerShell 桥（进程发现/签名/任务注册/Restart/Reload）
runtime-manifest.json     macOS 更新清单（6 文件，钉 v标签）
runtime-manifest-windows.json  Windows 更新清单（8 文件，含 windows-bridge.ps1）
supported-runtimes.json   macOS 已验证内核哈希（仅诊断，不拦截）
supported-windows-runtimes.json  同上（Windows）
cli.mjs / cli-acp.mjs     CLI 入口
browser/  vscode/         浏览器扩展与 VS Code 扩展
scripts/                  清单生成、版本同步
docs/                     cli / browser / vscode / windows 适配记录 + compat
test.cjs + *.test.mjs     五个测试套件
deployment.json           数据目录里的版本指针（运行时生成，不入库）
versions/<sha256>/        数据目录里的完整运行副本（运行时生成，不入库）
CHANGELOG.md / RELEASE_NOTES.md / SECURITY.md / CONTRIBUTING.md
```

---

*交接完成。如有本文件未覆盖的情况，优先读 `CHANGELOG.md` 对应版本条目——那里面记的是当时真实的排查过程和证据。*
