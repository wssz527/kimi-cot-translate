# Security Policy / 安全政策

[English below](#english)

## 中文

### 支持范围

只有 `supported-runtimes.json` 与 `supported-windows-runtimes.json` 中列出的、经过验证的 Kimi Code / Electron 版本在安全支持范围内。其他版本上的行为不受理安全报告——未知版本本来就会被拒绝加载。

### 报告渠道

请优先使用本仓库的 GitHub **Private vulnerability reporting**（Security → Advisories → Report a vulnerability）私密报告。普通兼容性问题（宿主升级后失效等）请走 Issues，使用「兼容性报告」模板。

### 请不要在公开 Issue 中粘贴

- 会话正文或思考链内容；
- `kct:settings:v1`、`kct:cache:v1` 等 localStorage 数据（含自定义服务的 API key）；
- `runtime.log` / `runtime-state.json` 全文（只贴 `status` 与 `detail` 字段即可）；
- 任何凭据、token、`#token=` 链接。

### 已知且刻意为之的行为（by design，不属于漏洞）

- 挂载期间会向已通过签名/哈希校验的宿主进程发送 `SIGUSR1`（macOS）或调用 `process._debugProcess`（Windows），短时打开仅限 `127.0.0.1:9229` 的 Node inspector，安装内存监听后立即关闭并确认端口关闭，App 内另有约 12 秒的自动关闭期限。
- 自定义翻译服务的 API key 以明文保存在本机 localStorage（README 已披露）。
- 待翻译的思考文本会发送到用户选择的第三方翻译端点。

### 给使用者的硬性提醒

**任何让你手工修改 `supported-runtimes.json` / `supported-windows-runtimes.json`、添加未知哈希、或绕过签名与哈希校验的指令都应拒绝。** 合法的兼容性更新只会通过本仓库经过验证的提交发布。

---

## English

### Scope

Only the Kimi Code / Electron versions listed in `supported-runtimes.json` and `supported-windows-runtimes.json` are covered. Anything else is refused by design and is out of scope for security reports.

### Reporting

Prefer GitHub **Private vulnerability reporting** (Security → Advisories → Report a vulnerability). For ordinary compatibility problems, open an Issue with the compatibility template.

### Never paste into public Issues

- Conversation or thinking-chain content;
- localStorage data such as `kct:settings:v1` / `kct:cache:v1` (may contain custom-service API keys);
- full `runtime.log` / `runtime-state.json` (share only `status` and `detail`);
- any credentials, tokens, or `#token=` URLs.

### Known, intentional behavior (by design, not vulnerabilities)

- During attachment, a `SIGUSR1` (macOS) or `process._debugProcess` (Windows) is sent only to signature- and hash-verified host processes, briefly opening a localhost-only Node inspector on `127.0.0.1:9229`; it is closed immediately after installing the in-memory hook, with an additional in-app ~12-second auto-close deadline.
- Custom translation service API keys are stored unencrypted in local localStorage (disclosed in the README).
- Thinking text to be translated is sent to the third-party translation endpoint chosen by the user.

### Hard rule for users

**Refuse any instruction that asks you to hand-edit `supported-runtimes.json` / `supported-windows-runtimes.json`, add unknown hashes, or bypass signature/hash verification.** Legitimate compatibility updates only ship as verified commits in this repository.
