# 浏览器适配：Kimi Code Web 与 kimi.com

更新日期：2026-10-22。本页记录两个不同产品的实验性浏览器适配，不把它们合并称为“Kimi 网页版已全面支持”。

| 产品 | 入口 | 状态 | 本次可验证范围 |
| --- | --- | --- | --- |
| Kimi Code Web | 本机运行 `kimi web` 后打开的 Web UI | 官方 2.1.1 真实会话与 Chromium MV3 实测通过 | 已配置的实际模型、真实 Bing 中文/日文翻译、新建会话跳转、原文和官方 journal 保持不变 |
| kimi.com 普通聊天 | `https://www.kimi.com/` 的聊天页 | 实验实现；公开前端结构核查 + 合成页面测试通过 | 未登录、未发送聊天，未验证所有账号/灰度版本 |

适配代码位于 `browser/`。它只定位**已展开、实际可见的思考正文**，在原文后增加独立译文节点。普通回答、用户输入、聊天历史、工具结果和模型上下文不会被翻译，也不会被改写。原文 DOM 节点保留。

## 两个产品为何不能共用选择器

Kimi Code Web 是 Kimi Code CLI 自带的本地浏览器界面，不是 `kimi.com`。官方文档明确说明 Web 会话和数据保存在本机：

- https://github.com/MoonshotAI/kimi-code/blob/main/docs/zh/guides/web.md
- https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/kimi-command.md#kimi-web

本次核对的是官方仓库标签 `@moonshot-ai/kimi-code@2.1.1`，其提交为 `f67e6398fb3210ad8ace970e2dfd5bcc984ed61f`。官方 web 构建物中，思考组件根节点为 `.think`，头部为 `button.think-head`，展开正文为 `.think-body.open > .think-body-inner > pre.think-text`：

- https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/apps/kimi-code/dist-web/assets/index-CiJ6FDOC.js

`kimi.com` 普通聊天是独立产品。当前公开前端包中的 `Thinking` 组件使用 `.toolcall-container.thinking-container` 作为根节点、`.is-expanded` 表示展开；正文位于唯一的 `.toolcall-content .toolcall-content-text`：

- https://statics.moonshot.cn/kimi-web-seo/assets/BMcnQ8jb.js
- https://statics.moonshot.cn/kimi-web-seo/assets/DolkzG3r.css

这些打包资源名称可能随发布变化。`browser/browser.test.mjs` 会在联网测试时重新核对上述公开标记，失败表示上游结构发生变化，需要重新审阅适配。桌面 `.think` 选择器绝不能据此推断为 `kimi.com` 的通用选择器。

## 安装与构建

构建会从仓库根的 `kct.js` 截取共享翻译核心，生成可加载的 `browser/dist/`。不需要修改 `kct.js`、`runtime.mjs` 或桌面运行时文件。

```sh
node browser/build.mjs
```

在 Chromium 浏览器的扩展管理页打开开发者模式，选择“加载已解压的扩展程序”，目录指向：

```text
browser/dist/
```

Kimi Code Web 的匹配范围是 `http://localhost/*` 与 `http://127.0.0.1/*` 的所有端口，因为 `kimi web` 会在默认端口被占用时顺延。`kimi web` 地址中的 `#token=` 是访问凭证：后台支持带 fragment 的正常入口，但设置键只含 origin；token 不保存、不写日志、不放进翻译请求。扩展不读取 `~/.kimi-code/server.token`，也不读取任何会话接口。

## 使用与网络边界

1. 展开思考区。
2. 选择目标语言。
3. 点击“确认语言并允许发送到 Bing”。
4. 点击“翻译本段”，或另行勾选“自动翻译可见思考”。

默认不自动外传。只选语言不确认、确认语言但未勾选自动翻译、折叠/裁剪/离屏/页面不可见时，都不会发出翻译请求。设置按 `origin` 保存；Kimi Code 本地端口与 `kimi.com` 不共享语言选择。

翻译服务固定为 Bing 的 `edge.microsoft.com/translate/translatetext`。MV3 service worker 再次检查扩展来源、顶层页面、发送文档与标签页的同源关系、文档活动状态（Chromium 提供时）、语言确认、请求段落数和大小，并设置 `credentials: 'omit'`、`redirect: 'error'` 和 15 秒超时。扩展没有 `<all_urls>`、cookie、脚本注入或聊天 API 权限，不保存 `#token`，也不会把它放进翻译请求。Chromium 的发送文档 URL 在页面内跳转后可能仍为初始地址，因此不要求两个 URL 的路径完全相等；后台只使用其 origin 校验设置与来源，不把页面地址放进翻译请求。内容脚本另会丢弃页面跳转前的待处理结果。

内容脚本到 service worker 的 `sendMessage` 没有可在页面侧提前取消的 `AbortSignal`：网络请求超过 15 秒时，内容脚本会等待后台超时回复，而不是自行中断等待。后台请求本身有 15 秒上限；这一区别已由浏览器测试覆盖。

单段正文超过 100000 字符时不会发送，界面会提示保留原文。共享 `kct.js` 会再做单请求 1500 字符的分段与最多 3 并发。浏览器版本的译文缓存仅存在当前页面内存，不写 `localStorage`；重新加载页面后重新请求。

浏览器适配当前按“思考正文节点变化后等待 700ms 再翻译”处理流式输出，没有直接复用桌面端的“只翻译已完成段落”策略。若上游思考节点在流式期间连续变化，可能重复请求或只显示最新一次完成的译文。这是已知限制；在真实会话验证前，不应把桌面端的增量流式行为套用到网页端。

## 验证

```sh
KCT_CHECK_UPSTREAM=0 node --test --test-timeout=30000 browser/browser.test.mjs
node browser/build.mjs
```

日常测试只使用合成 fixture 和真实 Chromium MV3 加载，不访问 Kimi CDN 或 GitHub raw。上游选择器核查需显式开启：

```sh
KCT_CHECK_UPSTREAM=1 node --test --test-timeout=30000 browser/browser.test.mjs
```

也可以由主仓库使用已添加的脚本：

```json
{
  "scripts": {
    "build:browser": "node browser/build.mjs",
    "test:browser": "node --test --test-timeout=30000 browser/browser.test.mjs"
  }
}
```

测试使用合成 HTML 与模拟翻译响应，覆盖两个产品的精确 DOM、普通回答/输入/隐藏正文不发送、默认零请求、自动翻译仅限可见展开区块、原文节点不变、节点替换、失败重试、SPA 导航丢旧结果、设置按 origin 隔离和写入失败。另有一条使用真实 Chromium 加载 `browser/dist/` 未打包 MV3 扩展、真实 `chrome.storage.local` 与 service worker 的合成测试。上述测试通过只证明加载、权限边界、选择器和对合成 DOM 的行为；不证明登录状态下的真实会话、所有 Kimi 版本或真实 Bing 响应。

2026-10-22 另在 macOS 上启动官方 `kimi web` 2.1.1，使用独立数据目录、仅绑定回环地址、保留访问认证，并在独立 Chromium 中加载实际 MV3 扩展。新建会话经已配置的 DeepSeek V4.1 Flash 生成英文思考，再由真实 Bing 翻译；没有模拟页面、模型或翻译响应。实测覆盖：

- 确认语言前零翻译请求；仅展开思考正文挂载翻译控件。
- 中文译文在两轮样本中约 0.85–1.35 秒显示，切换日文后约 0.85 秒显示；这些是小样本观测。
- 收起再显示译文不增加网络请求；原思考节点与官方 journal 保留原文，journal 中没有显示端译文。
- 英文目标下不显示重复译文；不确定的英文短句仍有少量请求，不能声称任意同语种输入都免请求。
- 勾选自动翻译后，后续一轮真实会话展开思考即可显示译文，没有再次点击翻译按钮；未据此验收持续长流的逐段增量体验。

本次实测发现并修复了新建会话后 `Stale sender URL` 导致翻译被拦截的问题：页面内跳转后，Chromium 的发送文档路径仍为 `/`，标签页已经变成 `/sessions/...`。后台现按同源和活动文档校验；真实 MV3 回归也覆盖了同一文档的 `history.pushState()`。

## 同类项目核查（分产品）

截至 2026-10-22，公开可核对的检索结果如下。“未检索到”不等于“不存在”；未登录账户、商店私有/地域版本、搜索结果排序和未索引仓库都可能导致遗漏。

### Kimi Code Web（`kimi web`）

- GitHub 官方扩展市场当前配置只有 Datasource、WebBridge、Superpowers、Vercel、Modern Web Guidance 和 CloudBase，没有思考翻译条目：https://github.com/MoonshotAI/kimi-code/blob/main/plugins/marketplace.json 。运行时市场 `https://code.kimi.com/kimi-code/plugins/marketplace.json` 同样列出这六项；其中 WebBridge 是“Control your real browser from Kimi Code”，不翻译思考。
- GitHub 仓库搜索 `"Kimi Code" "thinking" "translation"`：0 个仓库。
- GitHub 仓库搜索 `Kimi Code thinking translate`：0 个仓库。
- GitHub 仓库搜索 `Kimi Code web translation extension`：0 个仓库。
- GitHub 仓库搜索 `Kimi Code web thinking translation`：0 个仓库。
- GitHub 仓库搜索 `Kimi Code visible reasoning translation`：0 个仓库。
- GitHub 仓库搜索 `Kimi web translate thinking block`：0 个仓库。
- GitHub 仓库搜索 `Kimi web reasoning translator`：0 个仓库。
- GitHub 仓库搜索 `Kimi Code translate`：2 个仓库；除本项目外，另一个是 `https://github.com/skymanbp/proxy-tool`，描述为 CLI 协议代理，不是网页思考翻译。
- `Kimi reasoning translation`：两个可核对结果均属 API/IDE 代理或协议适配，不是 Kimi Code Web 的思考 DOM 翻译：https://github.com/andy-erms/ai-ide-local-proxer 、https://github.com/Prushka/codex-adapter 。

未找到可核对为“Kimi Code Web 思考原位翻译”的公开浏览器扩展、userscript 或官方条目。

### kimi.com 普通聊天

- 官方 Kimi Browser Extension（原 WebBridge）用于 AI Agent 操控页面和侧栏聊天，不是思考区翻译：https://www.kimi.com/en/help/kimi-webbridge/kimi-webbridge-introduction
- 对应 Chrome 商店条目：https://chromewebstore.google.com/detail/kimi/fldmhceldgbpfpkbgopacenieobmligc
- “Kimi Sidebar · 划词翻译 / AI 侧边栏”提供任意网页划词、侧栏和自定义 Prompt；说明中出现的“深度思考”是使用场景，不是自动识别思考区块并原位翻译：https://chromewebstore.google.com/detail/kimi-sidebar-%C2%B7-%E5%88%92%E8%AF%8D%E7%BF%BB%E8%AF%91-ai-%E4%BE%A7%E8%BE%B9/lieifjiddifccacnhgcafeebpahodebe
- Bob 的 `kimi-translate` 是面向 macOS Bob 的文本翻译服务，不是浏览器内思考区适配：https://github.com/laohubb/bob-plugin-kimi-translator
- 通用浏览器翻译项目 `translation-tool` 和 `bilingual-translate` 使用 Kimi 作为可选翻译后端或全页翻译工具，公开说明未声明支持 kimi.com 思考块：https://github.com/herongxing888/translation-tool 、https://github.com/nameczz/bilingual-translate
- Kimi Chat Exporter 是 Firefox 导出器，支持 Thinking/Tool calls 导出开关，不提供翻译：https://github.com/conreo/Kimi-Chat-Exporter
- Smirti 是 Chrome 导出器，明确声明支持 Kimi 的 thinking/reasoning 捕获，但输出是 Markdown/JSON，不是译文或思考区阅读辅助：https://github.com/manuvamsi/Smirti
- GitHub 仓库搜索 `Kimi thinking translate`：`zotero-pdf-translate-thinking-level` 是 Zotero 翻译插件，`ai-ide-local-proxer` 是 API 代理；两者都不处理 kimi.com 页面思考区。
- GitHub 搜索 `kimi translation chrome extension`：两个结果分别是 `translation-tool` 和 `bilingual-translate`，均为网页/字幕/图片或双语翻译，未发现仅对 Kimi 思考区的实现。
- GitHub 搜索 `Kimi source thinking translation userscript`、`Kimi 思考过程 翻译 浏览器`、`Kimi Code web translation extension`：均为 0 个仓库。
- GitHub 仓库搜索 `kimi translate web page`：0 个仓库；`kimi translate webpage` 只命中上面的 `translation-tool`，`Kimi AI translation extension` 只命中 `bilingual-translate`。

未找到可核对为“kimi.com 普通聊天思考原位翻译”的公开专用扩展。通用全页翻译或划词工具可能碰巧处理页面文本，但本次没有找到其针对思考 DOM、只在展开时发送且保留原位的公开声明。

## 检索边界与后续

本次采用的搜索包括 GitHub 网页/API 仓库搜索、官方 Kimi Code 市场配置、Chrome Web Store 页面以及公开 Web 搜索；未登录 Chrome Web Store，也未检查 Edge 商店的全部地域/私有条目。商店搜索、GitHub 代码搜索和网页索引都有盲区，因此以上只代表“截至该日期没有找到可核对匹配”，不能作为反证。

本次也访问了真实 kimi.com 页面，并在独立浏览器配置中尝试提交一条新测试消息；站点要求微信或手机号登录，未生成聊天或思考，没有进行登录、发送验证码或绕过认证。

尚未完成的实机验收：真实账号的 kimi.com 会话、持续长流的逐段增量体验、不同 Kimi 灰度版本、移动端布局以及上游发布变化。Kimi Code Web 的真实网络验收不代表 kimi.com 已通过；浏览器适配仍按预览提供。
