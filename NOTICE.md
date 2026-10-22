# 项目及第三方说明

`kimi-cot-translate` 是独立实现的非官方实验性扩展，与 Kimi Code、Moonshot AI、Microsoft、Google 无隶属或背书关系。

Kimi、Kimi Code 是 Moonshot AI 的商标；本项目使用该名称仅为说明互操作对象，不构成任何隶属或背书关系。Microsoft、Bing、Google、VS Code 等名称亦为其各自所有者的商标。

## 许可证

本项目以 MIT License 发布，见仓库根目录 `LICENSE`。按「现状」提供，不含任何明示或默示担保；作者不对因宿主更新导致的失效、数据或账号问题承担责任。

## 内容与来源

- 仓库仅包含扩展源码、说明、测试；浏览器扩展与 VS Code 预览的构建产物由 `npm run build:browser` / `npm run build:vscode` 生成，或从 GitHub Release 附件获取。不包含 Kimi Code、Electron 或任何第三方应用的二进制文件。
- 常规测试使用合成内容；显式设置 `KCT_KIMI_BIN` 的 CLI 集成测试会在隔离目录中启动指定的官方 CLI，并使用本机模拟模型端点。
- 对宿主的适配仅基于阅读公开仓库与公开网页的前端行为，并在运行时定位 DOM；未复制官方源码。
- 翻译请求格式参考了某实验性翻译器的公开行为，未复制其代码，也未捆绑该项目。
- 源码中的 Bing、Google 和自定义服务接口由对应服务方提供。这些是公共免鉴权端点，没有公开 SLA，使用可能受各服务方条款约束，可用性不获保证；长期或大量使用建议使用自带凭据的自定义服务。

## 运行时依赖

运行时不依赖任何 npm 包。开发测试使用 Playwright（Apache-2.0，仅开发依赖，不随产物分发）。
