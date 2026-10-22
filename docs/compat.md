# 兼容性记录

本项目版本与宿主（Kimi Code / Electron）兼容性的对应关系。宿主兼容性的增减**不跟随**本项目的语义化版本——新增一条已验证哈希不代表本项目发了新版本。

## 当前支持

| Kimi Code | Electron | 平台 | 验证方式 | 验证日期 |
| --- | --- | --- | --- | --- |
| 1.1.1 | 43.1.1 | macOS arm64 | 真实翻译、启动恢复、刷新恢复、签名与资源哈希不变 | 2026-10-21 |
| 1.1.1 | 43.1.1 | Windows x64 | CI runner 真实挂载、安装不重启、安全停用、冷启动恢复 | 2026-10-22 |

具体哈希见 `supported-runtimes.json`（macOS）与 `supported-windows-runtimes.json`（Windows）。两平台的允许列表不能互换。

## 适配流程

1. 官方发布新版本后，`windows-live.yml` 会按设计失败（哈希熔断）；macOS 侧表现为 `--check` 报 `New Electron runtime`。
2. 适配需要真实下载官方包、校验签名、在隔离环境实际挂载并跑翻译验收。
3. 通过后才把新哈希提交进允许列表。**不接受**未经此流程的哈希 PR。

## 尚未验收

真实跨版本升级（旧版安装 → 宿主更新 → 自动恢复）、睡眠唤醒、长期运行、另一台实机。

## 不适配的宿主

**Kimi 桌面端（Kimi.app，com.moonshot.kimichat，3.2.15 验证）**：与本项目机制不兼容，无适配计划。本项目的挂载依赖 Electron 的 Node inspector fuse（`EnableNodeCliInspectArguments`）；Kimi Code 的 fuse 串为 `101100001`（开启），而 Kimi.app 官方二进制为 `100011001`（关闭）。打开它需要修改官方 Electron Framework 二进制，会破坏签名并违背本项目「不修改、不重签官方 App」的原则，因此不予考虑。Kimi 网页版（kimi.com）用户可使用浏览器扩展入口（实验性）。
