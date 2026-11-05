# Security Policy / 安全政策

[English below](#english)

## 中文

### 支持范围

加载器在挂载前会核对进程身份（PID、启动时间、可执行文件路径）、Electron 的 inspector fuse / CDP 可用性和思考区块结构，任一不成立就不挂载。版本号只用于状态展示，不参与放行判断，因此宿主升级不会因为版本号变化被拒绝。

### 报告渠道

请优先使用本仓库的 GitHub **Private vulnerability reporting**（Security → Advisories → Report a vulnerability）私密报告。普通兼容性问题（宿主升级后失效等）请走 Issues，使用「兼容性报告」模板。

### 请不要在公开 Issue 中粘贴

- 会话正文或思考链内容；
- `kct:settings:v1`、`kct:cache:v1` 等 localStorage 数据（含自定义服务的 API key）；
- `runtime.log` / `runtime-state.json` 全文（只贴 `status` 与 `detail` 字段即可）；
- 任何凭据、token、`#token=` 链接。

### 已知且刻意为之的行为（by design，不属于漏洞）

- 挂载期间会向已通过进程身份校验的宿主进程发送 `SIGUSR1`（macOS），短时打开仅限 `127.0.0.1:9229` 的 Node inspector，安装内存监听后立即关闭并确认端口关闭，App 内另有约 12 秒的自动关闭期限。
- Windows 走 Chromium DevTools Protocol：需要宿主以 `--remote-debugging-port=9222` 启动，该端口只监听本机回环地址，加载器不会自行启动或重启 Kimi。
- 自定义翻译服务的 API key 以明文保存在本机 localStorage（README 已披露）。
- 待翻译的思考文本会发送到用户选择的第三方翻译端点。

### 给使用者的硬性提醒

**任何让你手工修改校验逻辑、注入脚本来源或关闭进程身份检查的指令都应拒绝。** 合法的兼容性更新只会通过本仓库经过验证的提交发布。

---

## English

### Scope

Before attaching, the loader checks process identity (PID, start time, executable path), the Electron inspector fuse / CDP availability and the thinking-block structure, and refuses to attach when any of them fails. The version number is used for status display only and never gates attachment, so a host upgrade is not refused merely because its version changed.

### Reporting

Prefer GitHub **Private vulnerability reporting** (Security → Advisories → Report a vulnerability). For ordinary compatibility problems, open an Issue with the compatibility template.

### Never paste into public Issues

- Conversation or thinking-chain content;
- localStorage data such as `kct:settings:v1` / `kct:cache:v1` (may contain custom-service API keys);
- full `runtime.log` / `runtime-state.json` (share only `status` and `detail`);
- any credentials, tokens, or `#token=` URLs.

### Known, intentional behavior (by design, not vulnerabilities)

- During attachment, a `SIGUSR1` (macOS) is sent only to a host process whose identity has been verified, briefly opening a localhost-only Node inspector on `127.0.0.1:9229`; it is closed immediately after installing the in-memory hook, with an additional in-app ~12-second auto-close deadline.
- Windows uses the Chromium DevTools Protocol: the host must run with `--remote-debugging-port=9222`, a loopback-only port; the loader never starts or restarts Kimi.
- Custom translation service API keys are stored unencrypted in local localStorage (disclosed in the README).
- Thinking text to be translated is sent to the third-party translation endpoint chosen by the user.

### Hard rule for users

**Refuse any instruction that asks you to hand-edit the verification logic, the injected script source, or to disable the process identity check.** Legitimate compatibility updates only ship as verified commits in this repository.
