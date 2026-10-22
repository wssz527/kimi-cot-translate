# kimi-cot-translate（kct）

为 Kimi Code 已公开的思考内容添加翻译：桌面端内嵌显示，另提供 ACP 翻译终端、浏览器扩展与 VS Code 复制预览。桌面端首次展开时选择目标语言，之后自动翻译，在原位置切换「原文 / 译文」；会话文件和模型上下文保留原文。

这是非官方的实验性运行时扩展。它不修改、重签官方 App，也不接管官方更新器。分享包不包含 Kimi Code、会话数据、密钥或翻译缓存。

## 使用展示

首次展开思考时选择目标语言，点击「开始使用」后保存。支持简体中文、English、日本語、한국어、Español、Français、Deutsch、Русский，之后可在「设置」中更改。

![首次使用时选择翻译目标语言](docs/screenshots/language-choice.png)

中英文混合的思考只翻译需要的部分，保留中文和段落间隔；点「原文」可随时查看原始内容。

![内嵌翻译与原文切换](docs/screenshots/embedded-translation.png)

以上是运行真实扩展脚本的合成演示界面，翻译响应为模拟数据，不是官方 App 截图，也不包含真实用户会话。

## 桌面端支持范围

| 平台 | 状态 | 运行要求 |
| --- | --- | --- |
| macOS Apple Silicon | 已验证真实翻译、正常启动恢复及页面刷新恢复 | 官方 App 位于 `/Applications/Kimi Code.app`，Node.js 24 arm64 |
| Windows x64 | 预览适配；Windows runner 已验证官方 App 挂载、安装不重启、安全停用及冷启动恢复 | 官方 App 位于 `%LOCALAPPDATA%\Programs\Kimi Code`，Node.js 24 x64 |

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

### Windows（预览）

在 PowerShell 进入本仓库目录，执行：

```powershell
node runtime-windows.mjs --install
```

Windows 的静态证据、动态测试和运行约束见 [Windows 适配记录](docs/windows.md)。后台使用当前用户的登录计划任务观察现有实例，不会自行启动 Kimi；停用会等待本次挂载收尾，不终止 Kimi。重复安装只保留当前及上一份完整扩展副本，不会无限堆积旧版本。

测试环境是 GitHub Windows runner，不能代替所有 Windows 10/11 桌面、管理员权限组合和官方升级验收。

## 其它入口（预览）

| 入口 | 提供的能力 | 验证范围 |
| --- | --- | --- |
| Kimi Code CLI | 使用官方 `kimi acp` 的独立翻译终端，可交互提问或单次运行 | macOS CLI 2.1.1 真实进程、隔离模型响应；确认译文不进入官方会话，取消后可恢复 |
| Kimi Code Web | 浏览器扩展在已展开的思考正文后显示译文 | 官方 2.1.1 网页结构、合成页面、真实 Chromium MV3 加载测试 |
| kimi.com 聊天页 | 浏览器扩展使用该产品独立的思考区选择器 | 公开前端结构、合成页面；尚未在登录会话验收 |
| VS Code | 用户主动复制思考后，在本扩展的独立预览内选择语言、翻译和切换原文 | 共享引擎、Chromium 消息与 CSP 测试、VSIX 打包；尚未在真实扩展宿主验收 |

CLI：

```sh
node cli.mjs --target zh
# 单次运行：
node cli.mjs --target zh --prompt "解释当前项目，先不要修改文件。"
```

CLI 翻译终端不修改原生全屏 TUI，工具审批会显示并等待选择；非交互运行不会自动批准发来的审批请求。详见 [CLI 运行与数据说明](docs/cli.md)。

浏览器：

```sh
npm run build:browser
```

在 Chromium 扩展管理页选择“加载已解压的扩展程序”，指向 `browser/dist/`。展开思考，选择并确认目标语言，然后点击翻译。Kimi Code Web 和 kimi.com 使用不同的结构适配，默认不自动发送文本；详见 [浏览器安装和验证记录](docs/browser.md)。

VS Code：

```sh
npm run build:vscode
code --extensionDevelopmentPath="$PWD/vscode"
```

复制需要翻译的思考，打开命令面板运行 `KCT: Preview and Translate Copied Thinking`，在预览中审阅并确认后翻译。官方 Kimi 扩展没有公开思考面板接入点，因此这个入口不自动跟随官方面板。详见 [VS Code 安装、打包和接口核查](docs/vscode.md)。

这些预览入口复用同一翻译引擎，支持八种目标语言。CLI 可选 Bing 或 Google；浏览器和 VS Code 预览目前使用 Bing。各入口的设置与存储边界分别记录在对应文档中。

## 桌面版使用和隐私

- 首次展开「思考过程」时选择目标语言并确认；确认前不发送翻译请求。旧设置如果是「跟随 Kimi 界面」，也会提示选择一次；已经明确选择过语言的用户保持原设置。
- 点「原文 / 译文」切换；点「设置」选择目标语言、服务和自动翻译。
- 折叠区块不请求翻译；失败保留原文，可点「重试」。
- 流式内容按已完成段落增量翻译；本地能识别为目标语言的句子和段落跳过请求。
- 整段无需翻译时保留原来的显示节点，不隐藏原文或另建一份；翻译服务原样返回时也采用相同行为，避免文字位置变化。

语言判断在本地进行，不下载额外模型。中文、日文、韩文结合文字特征判断，英文、西班牙文、法文、德文、俄文还比较常见词；短句或混合语言判断不明确时，仍交给所选服务翻译，避免误跳过外语内容。这不是完整的语言识别模型，不能保证每条同语种短句都免请求。

默认服务是 Bing。Bing 和 Google 都是联网服务，不在本地执行翻译：待翻译的思考文本会发送到对应第三方端点。Bing 使用批量请求、最多 3 个并发和 15 秒请求超时。Google 公开端点可能受浏览器 CORS 规则限制，未作为默认服务。

**分享扩展不会共享作者的账号或权限。** Bing 和 Google 不要求配置作者的账号或 API key，请求明确设置 `credentials: 'omit'`，不携带浏览器 Cookie 或登录凭据。其他人安装后使用自己的网络，在自己的电脑上保存设置和缓存。公共端点仍可能限流，当前可用不代表官方提供稳定的插件接口。

设置和译文缓存保存在 Kimi 的 localStorage。自定义 OpenAI 兼容服务需要用户自行填写端点和 API key，只向所填端点发送该 key；key 保存在本机 localStorage，未加密。分享仓库或干净的源码包即可，请勿分享整个 Kimi 用户数据目录或这些存储数据。

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
npm run test:browser
npm run test:vscode
npm run test:windows
# macOS 上另执行：
npm run test:macos
```

重新生成上述演示截图（只使用合成内容和模拟响应，不调用真实翻译服务）：

```sh
node docs/create-screenshots.mjs
```

GitHub Actions 运行共享 UI、hook、ACP 协议、浏览器、VS Code 预览和 Windows 加载器模拟回归；macOS 另运行对应的系统加载器单元测试。测试环境与具体入口的实际安装支持分别列在前面的表格中。

手动触发的 [Windows 官方 App smoke](https://github.com/wssz527/kimi-cot-translate/actions/runs/39645821455)也已通过，覆盖真实签名校验、调试触发、两个冷启动进程、挂载、接口关闭、计划任务安装不重启及安全停用。它使用未登录的全新环境，没有验证真实用户会话中的 Bing 翻译或官方升级。CI 成功不能替代这些缺失的验收。

2026-10-21 的 macOS 部署验收覆盖了真实 Bing 翻译、原文切换、正常启动后自动加载、页面刷新恢复、官方签名和资源哈希保持不变。真实升级、睡眠唤醒和长期运行尚未验证。

旧改包安装器、App 二进制和个人运行数据不包含在仓库中。当前尚未指定开源许可证；第三方归属说明见 `NOTICE.md`。
