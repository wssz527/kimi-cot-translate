# 贡献指南

感谢你的兴趣。这是一个个人维护的实验性项目，贡献前请先读这一页。

## 环境

- Node.js 24（`node --version` 应为 `v24.x`）。
- `npm ci` 安装开发依赖（仅 Playwright，用于测试；运行扩展本身不需要任何 npm 依赖）。

## 测试

改动后必须通过与你改动面相关的测试：

```sh
npm test              # 共享 UI、hook、ACP 协议
npm run test:browser  # 浏览器扩展
npm run test:vscode   # VS Code 预览
npm run test:windows  # Windows 加载器（模拟）
npm run test:macos    # macOS 加载器（仅 macOS）
```

## 硬性规则

1. **不要提交手工添加的未知 Electron / 官方安装包哈希。** `supported-runtimes.json`、`supported-windows-runtimes.json`、`windows-live.yml` 中的哈希必须来自真实隔离验证（真实下载官方包、校验签名、实际挂载测试），并在 PR 中附上验证过程说明。
2. **改动选择器或 DOM 适配必须带证据**：在 `docs/` 对应文档中更新上游结构引用（公开仓库 commit / 公开资源 URL），并附测试。
3. **不要新增未在文档中声明的网络端点。** 翻译请求只应发往用户明确选择的服务。
4. `kct.js` 必须保持 CJS/ESM 双形态：不得出现顶层 `import` / 顶层 `await`（`cli.mjs` 与 `vscode/` 通过 `require` 加载它）。
5. 本项目不经 npm 分发，`package.json` 的 `"private": true` 是有意为之，请勿删除。

## 版本号

根 `package.json` 是唯一版本来源。`browser/manifest.json`、`vscode/package.json`、`cli.mjs` 中的版本由 `npm run version:sync` 从根目录同步，请不要手工单独修改。

## 安全

安全相关问题不要在公开 Issue 讨论，见 `SECURITY.md`。
