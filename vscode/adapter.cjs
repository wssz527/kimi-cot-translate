const { randomBytes } = require('node:crypto');

const MAX_SOURCE_CHARS = 64000;

function assertEngine(engine) {
  if (typeof engine?.translateText !== 'function' ||
      typeof engine?.prunePending !== 'function' ||
      !Array.isArray(engine?.TARGET_LANGUAGES) || !engine?.state?.settings) {
    throw new Error('Shared kct.js must export translateText, prunePending, TARGET_LANGUAGES and state. Run node vscode/build.cjs after updating the shared translator.');
  }
  return engine;
}

function restoreTarget(engine, state, key = 'kct.targetLanguage') {
  const saved = state.get(key);
  return engine.TARGET_LANGUAGES.includes(saved) ? saved : 'zh';
}

function createSession(engine, send) {
  assertEngine(engine);
  let current;
  let closed = false;
  const cancel = (notify = true) => {
    current = undefined;
    engine.prunePending();
    if (notify) send({ type: 'cancelled' });
  };
  return {
    async receive(message) {
      if (closed) return;
      if (message?.type === 'cancel') {
        cancel();
        return;
      }
      if (message?.type !== 'translate') return;
      if (current) return;
      if (typeof message.source !== 'string' || !message.source.trim() ||
          message.source.length > MAX_SOURCE_CHARS ||
          !engine.TARGET_LANGUAGES.includes(message.target)) {
        send({ type: 'error', text: `Choose a supported language and provide 1-${MAX_SOURCE_CHARS} characters.` });
        return;
      }
      const job = {};
      current = job;
      const valid = () => !closed && current === job;
      // Keep provider choice local to this call; do not change other adapters' settings.
      const settings = { ...engine.state.settings, provider: 'bing', targetLanguage: message.target };
      try {
        const translated = await engine.translateText(message.source, message.target,
          (text) => { if (valid()) send({ type: 'progress', text }); }, settings, valid);
        if (valid()) send({ type: 'done', text: translated });
      } catch {
        if (valid()) send({ type: 'error', text: 'Translation failed. The original is unchanged; retry when the service is available.' });
      } finally {
        if (current === job) current = undefined;
      }
    },
    dispose() {
      closed = true;
      cancel(false);
    },
  };
}

function htmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function renderHtml({ source, target = 'zh', languages, scriptUri }) {
  const nonce = randomBytes(24).toString('base64');
  const scriptOrigin = new URL(scriptUri).origin;
  const choices = languages.map((lang) =>
    `<option value="${htmlEscape(lang)}"${lang === target ? ' selected' : ''}>${htmlEscape(lang)}</option>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${scriptOrigin}; style-src 'nonce-${nonce}'; connect-src 'none'; form-action 'none'; base-uri 'none';">
<title>Copied thinking translation</title>
<style nonce="${nonce}">
body{max-width:960px;margin:24px auto;padding:0 16px;font:var(--vscode-font-size)/1.6 var(--vscode-font-family);color:var(--vscode-foreground)}
label{display:block}textarea,pre{box-sizing:border-box;width:100%;min-height:280px;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}
textarea{color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:12px}
button,select{font:inherit;margin:8px 8px 8px 0;padding:4px 8px}button{cursor:pointer}
button:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
[hidden]{display:none!important}#status{min-height:1.6em}
</style></head><body>
<h1>Copied thinking translation</h1>
<p>Separate preview. Copy only the reasoning you want to translate from Kimi.
Opening this preview sends nothing. Clicking Translate sends the text that needs translation to Bing
(edge.microsoft.com). No Kimi account, conversation history or model context is accessed.</p>
<label for="target">Target language</label><select id="target">${choices}</select>
<button id="translate">Translate with Bing</button><button id="cancel" hidden>Cancel</button>
<button id="original" disabled>Original</button><button id="translated" disabled>Translation</button>
<p id="status" role="status" aria-live="polite"></p>
<label id="source-label" for="source">Copied text (review or edit before sending)</label>
<textarea id="source" maxlength="${MAX_SOURCE_CHARS}" spellcheck="false">${htmlEscape(source)}</textarea>
<pre id="result" aria-label="Translation" hidden></pre>
<script nonce="${nonce}" src="${htmlEscape(scriptUri)}"></script>
</body></html>`;
}

module.exports = { MAX_SOURCE_CHARS, assertEngine, createSession, renderHtml, restoreTarget };
