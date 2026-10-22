# CLI 翻译终端（预览）

这是使用官方 `kimi acp` 的独立终端客户端。它将 ACP 的 `agent_thought_chunk` 交给翻译引擎，回答和工具信息保持原文；发回 Kimi 的用户输入、官方保存的会话和模型上下文不经过翻译。

它不会给原生 `kimi` 全屏 TUI 增加按钮或修改其安装文件。官方 CLI 可以正常单独更新；ACP 协议变化后仍可能需要适配本客户端。不要把此入口称为原生 TUI 插件。

## 运行

需要 Node.js 24，以及已安装并配置模型的 Kimi Code CLI。先检查：

```sh
node --version
kimi --version
kimi acp --help
```

进入源码目录启动交互客户端：

```sh
node cli.mjs
```

首次使用会要求选择目标语言，支持 `zh/en/ja/ko/es/fr/de/ru`。输入问题后，译文显示在 `[思考 · zh]` 等标题下，回答显示在 `[回答]` 下；输入 `/exit` 退出。这不是原生全屏界面的复刻，没有其全部快捷键和会话管理功能。

单次运行或明确更改语言：

```sh
node cli.mjs --target zh --prompt "解释当前项目的目录结构，先不要修改文件。"
node cli.mjs --target ja --provider bing
```

终端工作目录就是传给 Kimi 的工作目录。跨目录使用时，执行源码的绝对路径即可：

```sh
cd /path/to/project
node /path/to/kimi-cot-translate/cli.mjs --target zh
```

可用 `--kimi /path/to/kimi` 指定官方可执行文件，用 `--original` 同时显示有变化的思考原文与译文。可执行文件通过参数数组启动，不经过 shell 拼接。

## 审批与退出

交互模式显示 Kimi 发来的工具授权标题、输入和选项，只有输入编号后才把所选选项回传；直接回车拒绝。非交互模式不会自动批准 ACP 发来的授权请求。Kimi 本身已有的权限规则仍由官方后端处理。

Ctrl+C 请求取消当前运行并退出本客户端；只收尾它自己启动的 ACP 子进程。不会结束桌面 App 或其他独立 Kimi 实例。

## 数据与限制

语言和服务选择保存在独立的 `kimi-cot-translate/cli.json`：

- macOS、Linux：`$XDG_CONFIG_HOME/kimi-cot-translate/cli.json`，未设置时为 `~/.config/kimi-cot-translate/cli.json`。
- Windows：`%LOCALAPPDATA%\kimi-cot-translate\cli.json`。

此文件不包含会话、译文、API key 或 Kimi 登录凭据。译文仅在本次客户端进程的内存中复用，沿用 500 条、2 MiB 和 7 天闲置过期限制，不写入官方会话。

Bing、Google 都需要联网，只有需要翻译的思考文本会交给所选服务；目标语言识别不确定的短句仍可能请求。翻译失败显示原文。终端会移除输出文本中的控制转义，避免模型输出执行终端控制命令。

待显示队列最多 128 Ki 字符，协议单行也有上限。超出限制会停止本次显示并请求取消，官方会话记录仍由 Kimi 保存；没有无限累积的显示队列。

## 为什么没有使用 `-p --output-format stream-json`

核对 Kimi Code 2.1.1 的官方源码后确认，`PromptJsonWriter.writeThinkingDelta()` 是空实现，JSON 输出不包含思考。因此解析该输出不能实现思考翻译。

ACP 则将 `thinking.delta` 映射到 `agent_thought_chunk`，适合只在客户端处理显示：

- [官方打印输出实现，2.1.1](https://github.com/MoonshotAI/kimi-code/blob/f67e639/apps/kimi-code/src/cli/prompt-render.ts)
- [官方 ACP 思考事件映射，2.1.1](https://github.com/MoonshotAI/kimi-code/blob/f67e639/packages/acp-server/src/events-map.ts)
- [官方 ACP 服务与客户端能力协商，2.1.1](https://github.com/MoonshotAI/kimi-code/blob/f67e639/packages/acp-server/src/server.ts)

支持状态与实际验证结果以仓库 README 为准。协议测试可以跨平台运行，不等于已经验证每个操作系统上的真实 Kimi CLI。

## 复核

```sh
node --test cli.test.mjs cli-acp.test.mjs
KCT_KIMI_BIN=/path/to/kimi node --test cli-live.test.mjs
```

本轮使用 macOS 上的官方 CLI 2.1.1 验证了正常翻译显示、目标语言跳过，以及取消后在同一后端继续提问。集成测试重定向 `KIMI_CODE_HOME` 到临时目录，模型请求只到本机模拟端点，Bing 响应也使用模拟数据；随后核对官方 journal 中保存的是思考原文，且没有显示端译文。此证据没有覆盖真实翻译网络或真实付费模型调用。
