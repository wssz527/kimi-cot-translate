# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。0.x 阶段 minor 版本可能包含影响兼容性的变更。

宿主（Kimi Code / Electron）兼容性变化不跟随本项目版本号：`supported-runtimes.json` 哈希的新增与失效单独记录在 `docs/compat.md`。

## [Unreleased]

### 新增

- 运行时自更新：后台任务每 6 小时检查一次仓库发布的更新清单（`runtime-manifest.json`），发现新版本时下载运行时文件、逐个校验 SHA-256，再通过既有的原子部署路径替换（失败自动回滚）。新增 `node runtime.mjs --update` 手动入口；`--check` 输出新增 `updateStatus` / `updateVersion` / `lastUpdateCheckAt` 字段。
- 未知内核哈希不再直接熔断：改为在官方签名、inspector fuse、Electron 主版本与思考区块结构四项同时成立时放行，并记 `verified: "contract"`。官方小版本升级只要不改思考区块结构即可继续工作，无需等待新版或重装。

### 修复

- macOS 进程发现改用进程表精确匹配：`pgrep -x "Kimi Code"` 无法匹配含空格的进程名，会导致「Kimi Code is not running」的误判，后台任务因此不再挂载。

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
