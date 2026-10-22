const vscode = require('vscode');
const { MAX_SOURCE_CHARS, assertEngine, createSession, renderHtml, restoreTarget } = require('./adapter.cjs');

const TARGET_KEY = 'kct.targetLanguage';

function activate(context) {
  const panels = new Set();
  context.subscriptions.push({ dispose: () => { for (const panel of panels) panel.dispose(); } });
  context.subscriptions.push(vscode.commands.registerCommand('kct.translateCopiedThinking', async () => {
    let source;
    try {
      source = await vscode.env.clipboard.readText();
      if (source.length > MAX_SOURCE_CHARS) {
        await vscode.window.showWarningMessage(`Copy at most ${MAX_SOURCE_CHARS} characters of thinking.`);
        return;
      }
    } catch {
      await vscode.window.showErrorMessage('Unable to read the clipboard. Check VS Code clipboard permissions.');
      return;
    }
    try {
      const panel = vscode.window.createWebviewPanel(
        'kct.copiedThinking', 'KCT: Copied Thinking', vscode.ViewColumn.Beside,
        { enableScripts: true, localResourceRoots: [
          context.extensionUri, vscode.Uri.joinPath(context.extensionUri, 'vendor'),
        ] },
      );
      const engine = assertEngine(require('./vendor/kct.cjs'));
      const target = restoreTarget(engine, context.globalState, TARGET_KEY);
      const session = createSession(engine, (message) => {
        void panel.webview.postMessage(message).then(undefined, () => {});
      });
      const listener = panel.webview.onDidReceiveMessage((message) => {
        if (message?.type === 'translate' && engine.TARGET_LANGUAGES.includes(message.target)) {
          void context.globalState.update(TARGET_KEY, message.target).then(undefined, () => {});
        }
        return session.receive(message);
      });
      panels.add(panel);
      panel.onDidDispose(() => { panels.delete(panel); session.dispose(); listener.dispose(); });
      panel.webview.html = renderHtml({
        source,
        target,
        languages: engine.TARGET_LANGUAGES,
        scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'view.js')).toString(),
      });
    } catch {
      await vscode.window.showErrorMessage('Unable to open KCT preview. Run node vscode/build.cjs before launching the extension.');
    }
  }));
}

module.exports = { activate };
