# kimi-cot-translate（kct）

为 Kimi Code 桌面端的思考过程添加内嵌翻译。展开后自动翻译，在原位置切换「原文 / 译文」；会话文件和模型上下文保留原文。

这是非官方的实验性运行时扩展。它不修改、重签官方 App，也不接管官方更新器。分享包不包含 Kimi Code、会话数据、密钥或翻译缓存。

## 支持范围

| 平台 | 状态 | 运行要求 |
| --- | --- | --- |
| macOS Apple Silicon | 已验证真实翻译、正常启动恢复及页面刷新恢复 | 官方 App 位于 `/Applications/Kimi Code.app`，Node.js 24 arm64 |
| Windows x64 | 实验适配；官方安装包静态检查通过，动态验收待完成 | 官方 App 位于 `%LOCALAPPDATA%\Programs\Kimi Code`，Node.js 24 x64 |

当前验证对象为 Kimi Code 1.1.1 / Electron 43.1.1。不同平台使用各自的二进制允许列表，不能互换哈希。安装和运行不需要 npm 依赖；Playwright 仅用于开发测试。

加载器只处理当前用户正常启动的默认实例。多个主实例、测试 profile 和外部调试实例会跳过。

## 从 Kimi Code 内安装

可以直接让 Kimi Code 在自己的终端执行本仓库中的命令，不依赖 Codex 或其他 AI 工具。机器需要先安装对应架构的 Node.js 24。

安装只设置扩展的后台加载器，不会强制退出或重启 Kimi，也不修改官方安装包。首次安装会向符合校验条件的现有进程加载翻译界面。更新扩展时，已经加载旧脚本的页面在下次正常刷新或重开后使用新版，安装命令不会擅自刷新页面。

### macOS

解压后在终端进入本目录，确认 `node --version` 为 `v24.x`，执行：

```sh
node runtime.mjs --install
```

安装会校验官方 App，并把四个运行文件复制到当前用户的持久目录：

```text
~/Library/Application Support/kimi-cot-translate/
```

后台任务位于：

```text
~/Library/LaunchAgents/com.user.kimi-cot-translate.runtime.plist
```

登录时及每 10 秒检查一次现有进程。正常打开 Kimi Code 后，通常十几秒内自动挂载。Kimi 未运行时只等待；加载器不会启动或退出 Kimi，也不会创建第二个 Kimi 应用。

运行副本独立于解压目录，安装后移动源码不会影响它。后台任务使用安装时 Node 的绝对路径；如果移除或移动该 Node，请重新执行安装命令。

### Windows（实验）

在 PowerShell 进入本仓库目录，执行：

```powershell
node runtime-windows.mjs --install
```

Windows 的静态证据、运行约束和测试边界见 [Windows 适配记录](docs/windows.md)。动态验收完成之前，请不要把实验适配理解为已经支持所有 Windows 环境。

## 使用和隐私

- 展开「思考过程」，标题右侧出现翻译控件。
- 点「原文 / 译文」切换；点「设置」选择目标语言、服务和自动翻译。
- 折叠区块不请求翻译；失败保留原文，可点「重试」。
- 流式内容按已完成段落增量翻译；原本已是目标语言的内容跳过请求。

默认服务是 Bing，目标语言跟随 Kimi 界面。待翻译的思考文本会发送给所选第三方翻译服务。Bing 使用批量请求、最多 3 个并发和 15 秒请求超时。

设置和译文缓存保存在 Kimi 的 localStorage。自定义 OpenAI 兼容服务的 API key 也保存在 localStorage，未加密；请勿分享这些存储数据。浏览器 CORS 规则仍适用，Google 公开端点未作为默认服务。

### 缓存会不会一直变大？

译文缓存同时受以下限制，达到任一限制都会清理：

- 最多 500 条，超过时淘汰最近最少使用的条目。
- 序列化 JSON 最多 2 MiB，按 UTF-16 字节计算，包含 key 和时间戳。
- 条目 7 天未使用后过期；页面运行时由单个到期计时器清理，启动和读写时也会检查。

缓存按文本 hash 复用，不绑定会话。离开一个会话不会立刻删除所有已翻译条目，但闲置条目会过期，数量和容量始终受限。旧版无时间戳缓存的 7 天窗口从首次迁移时开始；损坏或已经超出预算的旧缓存会清空。

离开会话、折叠或替换思考内容时，失效的排队任务会取消。已经发出的请求可能继续到完成或 15 秒超时，但不会把失效结果写回缓存。点设置中的「清空缓存」后，清空之前发出的请求也不会重新填入缓存。

这里只处理插件译文和临时任务，不删除 Kimi 的聊天历史、原文或设置。上述容量是译文缓存预算，不是 Kimi 整个进程的内存上限。

## 检查、停用

macOS：

```sh
node "$HOME/Library/Application Support/kimi-cot-translate/runtime.mjs" --check
```

Windows 在本仓库目录执行：

```powershell
node runtime-windows.mjs --check
```

状态是最近一次后台检查的记录：

- `active`、`loaded: 1`、`inspectorClosed: true`：所记录的 PID 已完成挂载，调试接口已关闭。
- `waiting`：等待正常实例启动，或等待多个实例、端口占用等条件解除。
- `error`：校验或挂载失败，读取 `detail`；不会向同一进程连续发信号。
- `blocked-inspector`：调试接口未能确认关闭，请正常退出 Kimi，再查看日志。

状态保存在对应用户数据目录的 `runtime-state.json`，macOS 另有 `runtime.log`。Windows 数据目录为 `%LOCALAPPDATA%\kimi-cot-translate\windows`。这些诊断记录不包含会话正文或服务密钥。

停止后续自动加载：

```sh
# macOS
node "$HOME/Library/Application Support/kimi-cot-translate/runtime.mjs" --disable
```

```powershell
# Windows，在本仓库目录执行
node runtime-windows.mjs --disable
```

已加载的翻译层在下次正常退出 Kimi 时消失。停用不会强行结束会话；需要重新启用时再次执行安装命令。

## Kimi 更新后的行为

插件文件位于官方 App 以外，正常 App 更新不会覆盖这些文件。新进程启动后，后台任务会重新检查签名、实际运行文件、已验证的 Electron 内核哈希、inspector fuse 和思考区块结构，再自动挂载。

兼容的更新无需手工重装。若官方更新更换 Electron 内核、关闭相关调试能力或改变思考区块结构，翻译会停用，等待扩展适配。不要通过手工添加未知哈希来绕过校验。

这不是官方承诺稳定的插件 API，不能保证所有未来版本都兼容。当前只验证过正常重启恢复和页面刷新恢复，尚未完成真实跨版本升级验收。静态结构检查也无法证明所有新版交互都兼容。

挂载期间会短时开启仅限本机的 Node inspector，检查所属 PID 后安装内存监听，再关闭接口并确认端口关闭。首条调试命令还设置了 App 内关闭期限。未知内核不会收到开启 inspector 的信号。

## 本地检查

开发测试使用锁定的 Playwright 版本，安装运行插件本身不需要这些依赖：

```sh
npm ci
npx playwright install chromium
npm test
# macOS 上另执行：
npm run test:macos
```

GitHub Actions 在 Linux、Windows 和 macOS 上运行共享 UI 与 hook 回归；macOS 另运行对应的系统加载器单元测试。CI 成功仅说明相应测试通过，不能替代真实 Kimi 官方更新验收。

2026-10-21 的 macOS 部署验收覆盖了真实 Bing 翻译、原文切换、正常启动后自动加载、页面刷新恢复、官方签名和资源哈希保持不变。真实升级、睡眠唤醒和长期运行尚未验证。

旧改包安装器、App 二进制和个人运行数据不包含在仓库中。当前尚未指定开源许可证；第三方归属说明见 `NOTICE.md`。
