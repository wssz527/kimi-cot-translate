<!-- 请勿在 PR 描述中粘贴会话正文、API key 或日志全文（见 SECURITY.md）。 -->

## 改动说明

## 验证

- [ ] 与改动面相关的测试已通过（`npm test` / `test:browser` / `test:vscode` / `test:windows` / `test:macos`）
- [ ] 文档已同步更新（README / docs/ / CHANGELOG）

## 勾选确认

- [ ] 未手工添加未验证的哈希到 `supported-runtimes.json` / `supported-windows-runtimes.json` / `windows-live.yml`
- [ ] 改动选择器或 DOM 适配时，已在 `docs/` 更新上游结构引用与证据
- [ ] 未新增文档中未声明的网络端点
- [ ] `kct.js` 未引入顶层 `import` / 顶层 `await`（保持 CJS/ESM 双形态）
