const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { MAX_SOURCE_CHARS, createSession, renderHtml, restoreTarget } = require('./adapter.cjs');

function fakeEngine(translateText = async (text) => `translated:${text}`) {
  return {
    TARGET_LANGUAGES: ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru'],
    state: { settings: { provider: 'custom', customEndpoint: 'https://example.test', targetLanguage: 'en' } },
    translateText,
    pruned: 0,
    prunePending() { this.pruned++; },
  };
}

test('closed previews are released and extension shutdown disposes only the remaining panels', async () => {
  let command;
  const panels = [];
  const context = {
    extensionUri: 'https://extension.test/', subscriptions: [],
    globalState: { get: () => 'ja', update: async () => {} },
  };
  const vscode = {
    commands: { registerCommand: (name, handler) => { command = handler; return { dispose() {} }; } },
    env: { clipboard: { readText: async () => 'Synthetic copied thought.' } },
    ViewColumn: { Beside: 2 },
    Uri: { joinPath: () => ({ toString: () => 'https://extension.test/view.js' }) },
    window: {
      createWebviewPanel: () => {
        const panel = {
          disposed: false,
          webview: {
            postMessage: async () => true,
            onDidReceiveMessage: () => ({ dispose() {} }),
            asWebviewUri: (uri) => uri,
          },
          onDidDispose(listener) { this.onDispose = listener; },
          dispose() { if (!this.disposed) { this.disposed = true; this.onDispose(); } },
        };
        panels.push(panel);
        return panel;
      },
      showErrorMessage: (message) => assert.fail(message),
    },
  };
  const sandbox = {
    module: { exports: {} },
    require: (name) => name === 'vscode' ? vscode
      : name === './adapter.cjs' ? require('./adapter.cjs') : fakeEngine(),
  };
  runInNewContext(readFileSync(join(__dirname, 'extension.cjs'), 'utf8'), sandbox);
  sandbox.module.exports.activate(context);
  for (let i = 0; i < 20; i++) {
    await command();
    panels.at(-1).dispose();
  }
  assert.equal(context.subscriptions.length, 2, 'disposed preview objects must not accumulate in subscriptions');
  await command();
  assert.equal(panels.at(-1).disposed, false);
  context.subscriptions.forEach((entry) => entry.dispose());
  assert(panels.every((panel) => panel.disposed));
});

test('validates the message boundary before calling the shared translator', async () => {
  let called = 0;
  const engine = fakeEngine(() => { called++; });
  const messages = [];
  const session = createSession(engine, (message) => messages.push(message));
  for (const message of [
    { source: '' }, { source: '   ' }, { source: 23 }, { source: 'x'.repeat(MAX_SOURCE_CHARS + 1) },
    { source: 'thinking', target: 'unknown' },
  ]) {
    await session.receive({ type: 'translate', target: 'zh', ...message });
  }
  await session.receive(null);
  await session.receive({ type: 'unknown' });
  assert.equal(called, 0);
  assert.equal(messages.length, 5);
  assert(messages.every((message) => message.type === 'error'));
  session.dispose();
});

test('saved target is restored through Memento, with zh for invalid values', async () => {
  const engine = fakeEngine();
  const globalState = {
    saved: 'ja',
    get(key) { assert.equal(key, 'kct.targetLanguage'); return this.saved; },
    async update(key, value) { assert.equal(key, 'kct.targetLanguage'); this.saved = value; },
  };
  const target = restoreTarget(engine, globalState, 'kct.targetLanguage');
  assert.equal(target, 'ja');
  await globalState.update('kct.targetLanguage', 'en');
  assert.equal(renderHtml({
    source: 'thought', target, languages: engine.TARGET_LANGUAGES, scriptUri: 'http://kct.test/view.js',
  }).includes('<option value="ja" selected>'), true);
  globalState.saved = 'unsupported';
  assert.equal(restoreTarget(engine, globalState, 'kct.targetLanguage'), 'zh');
});

test('uses shared segmentation/translation with explicit Bing settings and preserves source and global settings', async () => {
  const source = '  First thought.\n\nAnother thought.  ';
  const messages = [];
  const engine = fakeEngine(async (text, target, progress, settings, valid) => {
    assert.equal(text, source);
    assert.equal(target, 'ja');
    assert.equal(settings.provider, 'bing');
    assert.equal(settings.targetLanguage, 'ja');
    assert(valid());
    progress('partial');
    return 'translated';
  });
  const before = structuredClone(engine.state);
  const session = createSession(engine, (message) => messages.push(message));
  const input = { type: 'translate', source, target: 'ja' };
  await session.receive(input);
  assert.deepEqual(messages, [{ type: 'progress', text: 'partial' }, { type: 'done', text: 'translated' }]);
  assert.deepEqual(input, { type: 'translate', source, target: 'ja' });
  assert.deepEqual(engine.state, before);
  session.dispose();
});

test('cancel, duplicate clicks and disposal cannot display stale translations', async () => {
  const jobs = [];
  const engine = fakeEngine((text, target, progress, settings, valid) =>
    new Promise((resolve, reject) => jobs.push({ resolve, reject, valid, progress })));
  const messages = [];
  const session = createSession(engine, (message) => messages.push(message));
  const first = session.receive({ type: 'translate', source: 'first', target: 'zh' });
  await session.receive({ type: 'translate', source: 'duplicate', target: 'zh' });
  assert.equal(jobs.length, 1);
  await session.receive({ type: 'cancel' });
  assert.equal(jobs[0].valid(), false);
  assert.equal(engine.pruned, 1);
  const second = session.receive({ type: 'translate', source: 'second', target: 'zh' });
  jobs[0].progress('stale progress');
  jobs[0].resolve('stale result');
  await first;
  assert.equal(jobs[1].valid(), true);
  session.dispose();
  jobs[1].reject(new Error('late failure'));
  await second;
  await session.receive({ type: 'translate', source: 'closed', target: 'zh' });
  assert.equal(jobs.length, 2);
  assert.deepEqual(messages, [{ type: 'cancelled' }]);
});

test('provider failures expose no original text or endpoint and permit retry', async () => {
  const messages = [];
  let fail = true;
  const engine = fakeEngine(async () => {
    if (fail) throw new Error('secret thought and provider internals');
    return 'retry result';
  });
  const session = createSession(engine, (message) => messages.push(message));
  await session.receive({ type: 'translate', source: 'secret thought', target: 'zh' });
  assert.equal(messages[0].type, 'error');
  assert(!JSON.stringify(messages).includes('secret'));
  fail = false;
  await session.receive({ type: 'translate', source: 'secret thought', target: 'zh' });
  assert.deepEqual(messages[1], { type: 'done', text: 'retry result' });
  session.dispose();
});

test('shared kct.js Node export actually translates only foreign prose through the existing provider', async (t) => {
  const engine = require('../kct.js');
  const before = structuredClone(engine.state.settings);
  engine.state.cache.clear();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    const texts = JSON.parse(options.body);
    return new Response(JSON.stringify(texts.map(() => ({
      translations: [{ text: '\u7ffb\u8bd1\u540e\u7684\u601d\u8003\u3002' }],
    }))), { headers: { 'content-type': 'application/json' } });
  });
  const source = 'The first thought is to check this code.\n\n\u8fd9\u662f\u4e2d\u6587\u5185\u5bb9\u3002';
  const messages = [];
  const session = createSession(engine, (message) => messages.push(message));
  t.after(() => { session.dispose(); engine.state.cache.clear(); });
  await session.receive({ type: 'translate', source, target: 'zh' });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), ['The first thought is to check this code.']);
  assert.equal(new URL(calls[0].url).origin, 'https://edge.microsoft.com');
  assert.equal(new URL(calls[0].url).searchParams.get('to'), 'zh-Hans');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(messages.at(-1), {
    type: 'done', text: '\u7ffb\u8bd1\u540e\u7684\u601d\u8003\u3002\n\n\u8fd9\u662f\u4e2d\u6587\u5185\u5bb9\u3002',
  });
  assert.deepEqual(engine.state.settings, before);
  await session.receive({ type: 'translate', source: '\u8fd9\u662f\u4e2d\u6587\u5185\u5bb9\u3002', target: 'zh' });
  assert.equal(calls.length, 1, 'target-language-only text must not reach the provider');
});

test('real browser: explicit sending, strict CSP, literal source/result and original switch', async (t) => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const source = '</textarea><script>window.pwned=true</script>\nFirst thought & details.';
  const output = '<img src="https://example.test/tracker">translated';
  const calls = [];
  const errors = [];
  const external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const engine = fakeEngine(async (...args) => { calls.push(args); return output; });
  const session = createSession(engine, (message) =>
    page.evaluate((data) => window.dispatchEvent(new MessageEvent('message', { data })), message));
  t.after(() => session.dispose());
  await page.exposeBinding('sendToHost', (context, message) => session.receive(message));
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({ postMessage: (message) => { void window.sendToHost(message); } });
  });
  const html = renderHtml({
    source, languages: engine.TARGET_LANGUAGES, scriptUri: 'http://kct.test/view.js',
  });
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /script-src 'nonce-[^']+' http:\/\/kct\.test/);
  assert(!html.includes("unsafe-inline"));
  assert(!html.includes("unsafe-eval"));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url === 'http://kct.test/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url === 'http://kct.test/view.js') return route.fulfill({
      contentType: 'text/javascript', body: readFileSync(join(__dirname, 'view.js'), 'utf8'),
    });
    external.push(url);
    return route.abort();
  });
  await page.goto('http://kct.test/');
  assert.equal(await page.locator('#source').inputValue(), source);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(calls.length, 0, 'opening the preview must not translate');
  await page.getByLabel('Target language').selectOption('ja');
  await page.getByRole('button', { name: 'Translate with Bing', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Translation complete.'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], source);
  assert.equal(calls[0][1], 'ja');
  assert.equal(await page.locator('#result').textContent(), output);
  assert.equal(await page.locator('#result img').count(), 0);
  await page.getByRole('button', { name: 'Original', exact: true }).click();
  assert.equal(await page.locator('#source').inputValue(), source);
  assert.equal(await page.locator('#source').isVisible(), true);
  await page.locator('#source').fill('edited thought');
  assert.equal(await page.getByRole('button', { name: 'Translation', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
