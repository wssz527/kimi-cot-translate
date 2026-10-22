import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import {
  LANGUAGES, errorReply, parseRetryAfter, settingsKey, translate, validateRequest,
} from './background.mjs';
import './build.mjs';

const root = new URL('./', import.meta.url);
const scripts = await Promise.all(['dist/core.js', 'content.js'].map(file => readFile(new URL(file, root), 'utf8')));
const codeURL = 'http://localhost:58627/';
const chatURL = 'https://www.kimi.com/chat/synthetic-fixture';

test('background rejects unsupported senders, endpoints, unconfirmed settings and oversized bodies', async () => {
  for (const url of ['https://evil.kimi.com/', 'https://kimi.com.evil.test/', 'file:///tmp/test',
    'http://192.168.1.1/', 'https://user:password@kimi.com/']) {
    assert.throws(() => settingsKey(url));
  }
  assert.equal(settingsKey(`${codeURL}#token=do-not-store`), 'kct.browser.v1:http://localhost:58627');
  for (const message of [{}, { lang: 'zh', texts: ['x'] }, { lang: 'en', texts: [] },
    { lang: 'en', texts: ['x'.repeat(1501)] }, { lang: 'en', texts: Array(9).fill('x') },
    { lang: 'en', texts: Array(3).fill('x'.repeat(1400)) },
    { lang: 'en', texts: [null] }]) assert.throws(() => validateRequest(message));
  LANGUAGES.forEach(lang => validateRequest({ lang, texts: ['A valid sentence.'] }));
  const sender = { id: 'test', tab: { id: 1, url: chatURL }, frameId: 0, url: chatURL };
  const message = { kind: 'kct.bing', lang: 'zh-Hans', texts: ['First check the input.'] };
  let calls = 0;
  let config = { language: 'zh', consent: false };
  const api = { runtime: { id: 'test' }, storage: { local: { get: async key => ({ [key]: config }) } } };
  const request = async (url, options) => {
    calls++;
    assert.equal(new URL(url).origin, 'https://edge.microsoft.com');
    assert.equal(new URL(url).pathname, '/translate/translatetext');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), message.texts);
    assert(!options.headers.authorization);
    return { ok: true, json: async () => [{ translations: [{ text: 'Synthetic translation.' }] }] };
  };
  await assert.rejects(translate(message, sender, api, request), /confirm/);
  config = { language: 'ja', consent: true };
  await assert.rejects(translate(message, sender, api, request), /confirm/);
  config = { language: 'zh', consent: true };
  for (const override of [{ id: 'other' }, { frameId: 1 }, { tab: null }, { url: 'https://evil.test/' }]) {
    await assert.rejects(translate(message, { ...sender, ...override }, api, request));
  }
  for (const url of ['https://kimi.com/other', 'http://localhost:58627/', 'https://evil.test/']) {
    await assert.rejects(translate(message, { ...sender, tab: { id: 1, url } }, api, request));
  }
  for (const documentLifecycle of ['prerender', 'cached', 'pending_deletion']) {
    await assert.rejects(translate(message, { ...sender, documentLifecycle }, api, request), /Stale/);
  }
  assert.equal(calls, 0);
  assert.equal((await translate(message, {
    ...sender, documentLifecycle: 'active', tab: { id: 1, url: 'https://www.kimi.com/chat/new-session' },
  }, api, request))[0].translations[0].text, 'Synthetic translation.');
  await assert.rejects(translate(message, sender, api, async () => ({
    ok: false, status: 503, headers: { get: () => null },
  })), error => error.message.includes('503') && error.status === 503 && error.network === undefined);
  await assert.rejects(translate(message, sender, api, async () => {
    throw new TypeError('Failed to fetch');
  }), { message: /fetch/, network: true });
  await assert.rejects(translate(message, sender, api, async () => ({
    ok: true, json: async () => { throw new SyntaxError('Unexpected token'); },
  })), error => /Unexpected token/.test(error.message) && error.network === undefined);
  await assert.rejects(translate(message, sender, api, async () => ({
    ok: true, json: async () => { throw new TypeError('Failed to read response body'); },
  })), { message: /read response body/, network: true });
  await assert.rejects(translate(message, sender, api, async () => ({ ok: true, json: async () => [] })), /response/);
  let receivedSignal;
  const nativeTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => nativeTimeout.call(AbortSignal, 20);
  await assert.rejects(translate(message, sender, api, async (url, options) => {
    receivedSignal = options.signal;
    return new Promise((resolve, reject) => {
      // AbortSignal.timeout() rejects fetch in real browsers; this keeps the
      // test fast while checking the worker passes a bounded signal.
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  }), { name: 'TimeoutError' });
  AbortSignal.timeout = nativeTimeout;
  assert.equal(receivedSignal.aborted, true);
});

test('background preserves HTTP status and parses Retry-After seconds or HTTP-date', async () => {
  const sender = { id: 'test', tab: { id: 1, url: chatURL }, frameId: 0, url: chatURL };
  const message = { kind: 'kct.bing', lang: 'zh-Hans', texts: ['First check the input.'] };
  const api = {
    runtime: { id: 'test' },
    storage: { local: { get: async key => ({ [key]: { language: 'zh', consent: true } }) } },
  };
  for (const [header, expected] of [['60', 60000], [new Date(Date.now() + 60000).toUTCString(), 59000]]) {
    await assert.rejects(translate(message, sender, api, async () => ({
      ok: false,
      status: 429,
      headers: { get: name => name === 'retry-after' ? header : null },
    })), error => error.status === 429 && Math.abs(error.retryAfterMs - expected) < 2000);
  }
  const now = Date.parse('2026-10-22T00:00:00Z');
  assert.equal(parseRetryAfter('60', now), 60000);
  assert.equal(parseRetryAfter('Thu, 22 Oct 2026 00:01:00 GMT', now), 60000);
  assert.equal(parseRetryAfter('not-a-date', now), undefined);
  assert.deepEqual(errorReply(Object.assign(new Error('HTTP 429'), { status: 429, retryAfterMs: 60000 })),
    { ok: false, error: 'HTTP 429', status: 429, retryAfterMs: 60000 });
  assert.equal(errorReply(new Error('Invalid translation response')).network, undefined);
});

test('generated bridge rebuilds structured errors and marks transport failures', async () => {
  const core = await readFile(new URL('dist/core.js', root), 'utf8');
  const start = core.indexOf('  const fetch = async (url, options) => {');
  const reply = error => ({ ok: false, error: error.message, ...error });
  const needle = '    return { ok: true, json: async () => reply.payload };';
  const end = core.indexOf(needle, start) + needle.length + 4;
  const bridge = sendMessage => new Function('chrome', `return (${core.slice(
    core.indexOf('async (url, options) =>', start),
    end,
  )});`)({ runtime: { sendMessage } });
  const options = { method: 'POST', body: '["hello"]' };
  const url = 'https://edge.microsoft.com/translate/translatetext?to=zh-Hans';
  for (const failure of [
    reply(Object.assign(new Error('Translation HTTP 429'), { status: 429, retryAfterMs: 60000 })),
    reply(Object.assign(new Error('Invalid translation response'), {})),
  ]) {
    const call = bridge(async () => failure);
    await assert.rejects(call(url, options), error => error.message === failure.error &&
      error.status === failure.status && error.retryAfterMs === failure.retryAfterMs &&
      error.network === (failure.network === true));
  }
  await assert.rejects(bridge(async () => { throw new TypeError('Message port closed'); })(url, options),
    { message: /Message port closed/, network: true });
});

async function fixture(t, {
  chat = false, settings, gate = false, fail = false, url, source, hash = '', translateMode = '',
} = {}) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const target = `${url || (chat ? chatURL : codeURL)}${hash}`;
  const html = await readFile(new URL(`fixtures/${chat ? 'kimi-chat' : 'code-web'}.html`, root), 'utf8');
  await page.route('**/*', route => route.request().isNavigationRequest()
    ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
  await page.goto(target);
  await page.clock.install();
  await page.evaluate(({ settings, gate, fail, source, translateMode }) => {
    const key = `kct.browser.v1:${location.origin}`;
    const values = settings ? { [key]: settings } : {};
    let changed;
    let holdChanges = false;
    let release;
    window.requests = [];
    window.blocked = false;
    window.fail = fail;
    const pending = gate ? new Promise(resolve => { release = resolve; }) : null;
    window.release = () => release?.();
    window.__externalStorageChange = next => {
      const changes = { [key]: { oldValue: values[key], newValue: next } };
      values[key] = next;
      if (!holdChanges) changed?.(changes, 'local');
    };
    window.__holdStorageChanges = toggle => { holdChanges = toggle; };
    window.__values = values;
    window.chrome = {
      storage: {
        local: {
          get: async key => ({ [key]: values[key] }),
          set: async update => {
            const changes = {};
            for (const [key, newValue] of Object.entries(update)) {
              changes[key] = { oldValue: values[key], newValue };
              values[key] = newValue;
            }
            changed?.(changes, 'local');
          },
        },
        onChanged: { addListener: callback => { changed = callback; } },
      },
      runtime: {
        sendMessage: async message => {
          if (!values[key]?.consent) throw new Error('No consent');
          window.requests.push(message);
          if (pending) await pending;
          if (window.fail) return typeof window.fail === 'object'
            ? window.fail : { ok: false, error: 'Synthetic HTTP 503' };
          const reply = window.translateMode === 'real' ? (text => `REAL:${text}`) : (text => `译文:${text}`);
          return { ok: true, payload: message.texts.map(text => ({ translations: [{ text: reply(text) }] })) };
        },
      },
    };
    window.translateMode = translateMode;
    window.originalSource = document.querySelector('#thinking .think-text, #thinking .toolcall-content-text');
    window.originalMarkup = window.originalSource.innerHTML;
    window.originalNormal = document.querySelector('#normal').outerHTML;
    window.localStorageBefore = JSON.stringify(localStorage);
  }, { settings, gate, fail, source, translateMode });
  if (source !== undefined) {
    await page.evaluate(source => {
      window.originalSource.textContent = source;
      window.originalMarkup = window.originalSource.innerHTML;
    }, source);
  }
  for (const [index, content] of scripts.entries()) {
    await page.addScriptTag({ content });
    if (index === 0) await page.evaluate(() => {
      const original = KCTBrowserCore.translateText;
      window.translateArgs = [];
      KCTBrowserCore.translateText = (...args) => {
        window.translateArgs.push({ retryFailed: args[5] });
        return original(...args);
      };
    });
  }
  const ui = page.locator('#thinking [data-kct-browser]');
  const tick = async (ms = 850) => {
    await page.clock.runFor(ms);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  };
  return { page, ui, tick, requests: () => page.evaluate(() => window.requests) };
}

async function consent(f) {
  await f.ui.getByLabel('翻译目标语言').selectOption('zh');
  await f.ui.getByRole('button', { name: '确认语言并允许发送到 Bing' }).click();
}

test('worker 429 metadata pauses all Bing jobs until Retry-After expires', async t => {
  const f = await fixture(t, {
    settings: { language: 'zh', consent: true, auto: false },
    fail: { ok: false, error: 'Translation HTTP 429', status: 429, retryAfterMs: 60000 },
  });
  await f.page.clock.pauseAt(await f.page.evaluate(() => Date.now() + 1000));
  await f.page.evaluate(() => {
    window.requestTimes = [];
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async message => {
      window.requestTimes.push(Date.now());
      return send(message);
    };
  });
  await f.ui.getByRole('button', { name: '翻译本段', exact: true }).click();
  assert.equal((await f.requests()).length, 1);
  await f.page.evaluate(() => {
    window.fail = false;
    window.queuedTranslation = KCTBrowserCore.translateText('Another queued source.', 'zh', () => {}, { provider: 'bing' });
  });
  await f.page.clock.runFor(59999);
  assert.equal((await f.requests()).length, 1);
  await f.page.clock.runFor(1);
  await f.ui.locator('output').waitFor({ state: 'visible' });
  assert.equal(await f.page.evaluate(() => window.queuedTranslation), '译文:Another queued source.');
  const times = await f.page.evaluate(() => window.requestTimes);
  assert.equal(times.length, 3);
  assert(times.slice(1).every(time => time - times[0] >= 60000));
});

test('worker parsing failures never retry automatically, including stable fragments after source updates', async t => {
  const f = await fixture(t, {
    settings: { language: 'zh', consent: true, auto: true },
    fail: { ok: false, error: 'Invalid translation response' },
  });
  await f.ui.getByRole('status').filter({ hasText: '翻译失败' }).waitFor();
  assert.equal((await f.requests()).length, 1);
  await f.tick(10000);
  assert.equal((await f.requests()).length, 1);
  await f.page.evaluate(() => {
    window.originalSource.textContent = 'First check the input.\n\nA new streaming tail.';
  });
  await f.tick();
  await f.ui.getByRole('status').filter({ hasText: '翻译失败' }).waitFor();
  const requests = await f.requests();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].texts, ['A new streaming tail.']);
  await f.page.evaluate(() => { window.fail = false; });
  await f.ui.getByRole('button', { name: '翻译本段', exact: true }).click();
  await f.ui.locator('output').waitFor({ state: 'visible' });
  assert.equal((await f.requests()).length, 3);
  assert.deepEqual(await f.page.evaluate(() => window.translateArgs.map(args => args.retryFailed)), [false, false, true]);
});

test('settings are scoped by origin and a failed save cannot enable transmission', async t => {
  const f = await fixture(t, { chat: true });
  await f.page.evaluate(() => {
    const original = chrome.storage.local.set;
    chrome.storage.local.set = async () => { throw new Error('quota'); };
    window.restoreSet = () => { chrome.storage.local.set = original; };
  });
  await f.tick();
  await f.ui.getByLabel('翻译目标语言').selectOption('zh');
  await f.tick();
  assert.match(await f.ui.getByRole('status').textContent(), /设置保存失败/);
  assert.equal(await f.ui.getByRole('button', { name: '翻译本段', exact: true }).isDisabled(), true);
  assert.deepEqual(await f.requests(), []);
  await f.page.evaluate(() => window.restoreSet());
  await f.ui.getByLabel('翻译目标语言').selectOption('ja');
  await f.tick();
  await f.ui.getByRole('button', { name: '确认语言并允许发送到 Bing' }).click();
  assert.equal(await f.ui.getByRole('button', { name: '翻译本段', exact: true }).isEnabled(), true);
  const stored = await f.page.evaluate(() => chrome.storage.local.get(
    'kct.browser.v1:https://www.kimi.com'));
  assert.deepEqual(stored, { 'kct.browser.v1:https://www.kimi.com': { language: 'ja', consent: true, auto: false } });
});

test('applySettings preserves real translations for auto-only local and external changes', async t => {
  const f = await fixture(t, {
    settings: { language: 'zh', consent: true, auto: true }, translateMode: 'real',
  });
  await f.ui.locator('output').waitFor({ state: 'visible' });
  assert.equal(await f.ui.locator('output').textContent(), 'REAL:First check the input.\n\nREAL:Then verify the result.');
  await f.page.evaluate(() => window.__externalStorageChange({
    language: 'zh', consent: true, auto: false,
  }));
  await f.tick();
  assert.equal(await f.ui.locator('output').textContent(),
    'REAL:First check the input.\n\nREAL:Then verify the result.');
  assert.equal(await f.ui.locator('output').isVisible(), true);
  assert.equal((await f.requests()).length, 1, 'auto changes must not retranslate or clear the result');
  await f.page.evaluate(() => window.__externalStorageChange({
    language: 'ja', consent: true, auto: false,
  }));
  await f.tick();
  assert.equal(await f.ui.locator('output').isVisible(), false);
  assert.equal(await f.ui.locator('output').textContent(), '');

  await f.page.evaluate(() => {
    window.__externalStorageChange({ language: 'zh', consent: true, auto: true });
  });
  await f.tick(1800);
  assert.equal((await f.requests()).length, 1, 'cached translation is reused after language change');
  assert.equal(await f.ui.locator('output').textContent(),
    'REAL:First check the input.\n\nREAL:Then verify the result.');
  await f.ui.getByLabel('自动翻译可见思考').uncheck();
  await f.tick();
  assert.equal(await f.ui.getByLabel('自动翻译可见思考').isChecked(), false);
  assert.equal(await f.ui.locator('output').textContent(),
    'REAL:First check the input.\n\nREAL:Then verify the result.');
  assert.equal((await f.requests()).length, 1, 'cached result plus an auto-only toggle must not retranslate');
});

test('pure target-language source keeps the original node and shows no duplicate output', async t => {
  const f = await fixture(t,
    { settings: { language: 'zh', consent: true, auto: false }, source: '先检查输入，再确认结果。\n\n然后返回答案。' },
  );
  await consent(f);
  await f.ui.getByRole('button', { name: '翻译本段', exact: true }).click();
  await f.ui.getByRole('status').filter({ hasText: '无需翻译' }).waitFor();
  assert.deepEqual(await f.requests(), [], 'pure target-language prose does not need a network request');
  assert.equal(await f.ui.locator('output').isVisible(), false);
  assert.equal(await f.ui.locator('output').textContent(), '');
  assert.equal(await f.page.evaluate(() => window.originalSource.innerText), '先检查输入，再确认结果。\n\n然后返回答案。');
  assert.equal(await f.page.evaluate(() => document.querySelector('[data-kct-browser]').shadowRoot.querySelectorAll('output').length), 1);
});

test('twelve adjacent foreign sentences share one Bing request and one text', async t => {
  const source = Array.from({ length: 12 }, (_, i) =>
    `Sentence ${i + 1} checks the input before returning the result.`).join(' ');
  const f = await fixture(t, {
    settings: { language: 'zh', consent: true, auto: false },
    source,
  });
  await f.ui.getByRole('button', { name: '翻译本段', exact: true }).click();
  await f.ui.locator('output').waitFor({ state: 'visible' });
  const requests = await f.requests();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].texts, [source]);
});

test('fenced and inline code and bare URLs are not sent and remain unchanged', async t => {
  const fenced = '```js\nconst cache = new Map();\n\ncache.set("key", "value");\n```';
  const tildeFenced = '~~~text\nsecond fenced block\n\nwith a blank line\n~~~';
  const inline = "Then review `cache.has('key')` before returning.";
  const url = 'https://example.test/docs';
  const source = `先检查缓存行为。\n\n${fenced}\n\n${tildeFenced}\n\n${inline}\n\n${url}`;
  const f = await fixture(t, {
    settings: { language: 'zh', consent: true, auto: false },
    source,
  });
  await f.ui.getByRole('button', { name: '翻译本段', exact: true }).click();
  await f.ui.locator('output').waitFor({ state: 'visible' });
  const requests = await f.requests();
  assert.equal(requests.length, 1);
  const sent = requests.flatMap((request) => request.texts).join('\n');
  for (const code of [fenced, tildeFenced, "cache.has('key')", url]) {
    assert.equal(sent.includes(code), false, `${code} must not reach the provider`);
  }
  const output = await f.ui.locator('output').textContent();
  for (const preserved of [fenced, tildeFenced, "cache.has('key')", url]) {
    assert.equal(output.includes(preserved), true, `${preserved} must survive translation`);
  }
});

test('target-language prose around fenced and inline code makes no provider request', async t => {
  const source = [
    '先检查缓存行为。',
    '```js\nconst cache = new Map();\n\ncache.set("key", "value");\n```',
    '~~~text\nsecond fenced block\n\nwith a blank line\n~~~',
    "使用 `cache.has('key')` 并参考 https://example.test/docs 后返回答案。",
  ].join('\n\n');
  const f = await fixture(t, {
    settings: { language: 'zh', consent: true, auto: false },
    source,
  });
  await f.ui.getByRole('button', { name: '翻译本段', exact: true }).click();
  await f.page.waitForFunction(() =>
    document.querySelector('#thinking [data-kct-browser]')?.shadowRoot
      ?.querySelector('[role="status"]')?.textContent.includes('无需翻译'), null, { timeout: 3000 });
  assert.deepEqual(await f.requests(), []);
  assert.equal(await f.page.evaluate(() => window.originalSource.innerText), source);
});

test('provider-injected fenced code falls back to the original source', async t => {
  const source = 'Check the input before returning the answer.';
  const f = await fixture(t, {
    settings: { language: 'zh', consent: true, auto: false },
    source,
  });
  await f.page.evaluate(() => {
    window.requests = [];
    chrome.runtime.sendMessage = async message => {
      window.requests.push(message);
      return {
        ok: true,
        payload: message.texts.map(() => ({
          translations: [{ text: '译文\n```js\ninjected code\n```' }],
        })),
      };
    };
  });
  const result = await f.page.evaluate(source => KCTBrowserCore.translateText(
    source, 'zh', () => {}, { provider: 'bing' }, () => true, true,
  ), source);
  assert.equal(result, source);
  assert.equal((await f.requests()).length, 1);
});

test('supported #token fragment can translate without persisting or forwarding the token', async t => {
  const f = await fixture(t, {
    chat: true,
    settings: { language: 'zh', consent: true, auto: false },
    hash: '#token=fixture-secret',
  });
  await f.ui.getByRole('button', { name: '翻译本段', exact: true }).click();
  await f.ui.locator('output').waitFor({ state: 'visible' });
  assert.equal((await f.requests()).length, 1);
  assert.equal(await f.page.evaluate(() => location.hash), '#token=fixture-secret');
  const key = await f.page.evaluate(() => `kct.browser.v1:${location.origin}`);
  assert.doesNotMatch(key, /fixture-secret/);
  const stored = await f.page.evaluate(key => chrome.storage.local.get(key), key);
  assert.deepEqual(Object.keys(stored), [key]);
  assert.doesNotMatch(JSON.stringify(stored), /fixture-secret/);
  assert.doesNotMatch(JSON.stringify(await f.requests()), /fixture-secret/);
});

for (const chat of [false, true]) {
  const product = chat ? 'kimi.com' : 'Kimi Code Web';
  test(`${product}: exact DOM, explicit consent, original preserved and shared-core translation`, async t => {
    const f = await fixture(t, { chat });
    const { page, ui } = f;
    assert.equal(await page.locator('[data-kct-browser]').count(), 1);
    await f.tick(1500);
    assert.deepEqual(await f.requests(), []);
    await ui.getByLabel('翻译目标语言').selectOption('zh');
    await f.tick();
    assert.deepEqual(await f.requests(), [], 'selection alone must not send');
    await ui.getByRole('button', { name: '确认语言并允许发送到 Bing' }).click();
    await f.tick();
    assert.deepEqual(await f.requests(), [], 'confirmation keeps auto disabled');
    await ui.getByRole('button', { name: '翻译本段', exact: true }).click();
    await ui.locator('output').waitFor({ state: 'visible' });
    assert.match(await ui.locator('output').textContent(), /^译文:/);
    const requests = await f.requests();
    assert.equal(requests.length, 1, 'shared engine batches both paragraphs');
    const sent = requests.flatMap(request => request.texts).join('');
    assert.match(sent, /First check/);
    assert.match(sent, /Then verify/);
    assert.doesNotMatch(sent, /Normal|Private|Collapsed|Hidden|Wrong product|Ordinary tool|code example/);
    assert.equal(await page.evaluate(() => window.originalSource.innerHTML === window.originalMarkup), true);
    assert.equal(await page.evaluate(() => document.querySelector('#normal').outerHTML === window.originalNormal), true);
    assert.equal(await page.evaluate(() => document.querySelector('#thinking .think-text, #thinking .toolcall-content-text') === window.originalSource), true);
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage) === window.localStorageBefore), true);
    await ui.getByRole('button', { name: '收起译文', exact: true }).click();
    assert.equal(await ui.locator('output').isVisible(), false);
    assert.equal(await page.evaluate(() => window.originalSource.checkVisibility()), true);
    for (const content of scripts) await page.addScriptTag({ content });
    assert.equal(await page.locator('[data-kct-browser]').count(), 1, 'duplicate injection must not mount twice');
  });

  test(`${product}: opt-in auto translates only visible expanded thinking and detects node replacement`, async t => {
    const f = await fixture(t, { chat });
    await consent(f);
    await f.ui.getByLabel('自动翻译可见思考').check();
    await f.ui.locator('output').waitFor({ state: 'visible' });
    assert.equal((await f.requests()).length, 1);
    await f.page.evaluate(() => {
      const replacement = window.originalSource.cloneNode(false);
      replacement.textContent = 'Now analyze the changed input carefully.';
      window.originalSource.replaceWith(replacement);
    });
    await f.tick();
    await f.ui.locator('output').waitFor({ state: 'visible' });
    assert.equal((await f.requests()).length, 2);
    assert.match(await f.ui.locator('output').textContent(), /changed input/);
    await f.page.evaluate(() => document.querySelector('#thinking').style.display = 'none');
    await f.tick();
    assert.equal(await f.page.locator('[data-kct-browser]').count(), 0);
    assert.equal((await f.requests()).length, 2);
  });

  test(`${product}: collapsed/clipped/offscreen blocks never transmit; source changes resume after pending work`, async t => {
    const f = await fixture(t, { chat, gate: true, settings: { language: 'zh', consent: true, auto: true } });
    await f.page.waitForFunction(() => window.requests.length === 1);
    await f.page.evaluate(() => { window.originalSource.textContent = 'Changed while the request is still running.'; });
    await f.tick();
    await f.page.evaluate(() => window.release());
    await f.tick(1800);
    await f.ui.locator('output').waitFor({ state: 'visible' });
    assert.match(await f.ui.locator('output').textContent(), /Changed while/);
    assert.equal((await f.requests()).length, 2);
    await f.page.evaluate(() => {
      const block = document.querySelector('#thinking');
      block.style.cssText = 'position:absolute;top:3000px';
      window.originalSource.textContent = 'An offscreen change must never be sent.';
    });
    await f.tick();
    assert.equal((await f.requests()).length, 2);
    await f.page.evaluate(() => {
      const block = document.querySelector('#thinking');
      block.style.cssText = 'height:0;overflow:hidden';
      window.originalSource.textContent = 'A clipped change must never be sent.';
    });
    await f.tick();
    assert.equal((await f.requests()).length, 2);
  });

  test(`${product}: navigation/collapse discards pending results and provider failures preserve source`, async t => {
    const f = await fixture(t, { chat, gate: true, fail: true });
    await consent(f);
    await f.ui.getByRole('button', { name: '翻译本段', exact: true }).click();
    await f.page.waitForFunction(() => window.requests.length === 1);
    await f.page.evaluate(() => history.pushState({}, '', '/another-synthetic-chat'));
    await f.page.evaluate(() => window.release());
    await f.tick();
    assert.equal(await f.ui.locator('output').isVisible(), false);
    assert.equal(await f.page.evaluate(() => window.originalSource.innerHTML === window.originalMarkup), true);
    await f.ui.getByRole('button', { name: '翻译本段', exact: true }).click();
    await f.page.waitForFunction(() => window.requests.length === 2);
    await f.ui.getByRole('status').filter({ hasText: '503' }).waitFor();
    await f.page.evaluate(() => { window.fail = false; });
    await f.ui.getByRole('button', { name: '翻译本段', exact: true }).click();
    await f.ui.locator('output').waitFor({ state: 'visible' });
    assert.equal(await f.page.evaluate(() => window.originalSource.innerHTML === window.originalMarkup), true);
  });
}

test('unknown origin cannot mount even a matching desktop fixture', async t => {
  const f = await fixture(t, { url: 'https://example.test/' });
  await f.tick();
  assert.equal(await f.page.locator('[data-kct-browser]').count(), 0);
  assert.deepEqual(await f.requests(), []);
});

test('live kimi.com public bundle selectors remain exact', {
  skip: process.env.KCT_CHECK_UPSTREAM !== '1' && 'Set KCT_CHECK_UPSTREAM=1 for public upstream check',
}, async () => {
  const js = await (await fetch('https://statics.moonshot.cn/kimi-web-seo/assets/BMcnQ8jb.js')).text();
  for (const marker of [
    'class:Y([`toolcall-container thinking-container`,{"is-expanded":!n.value}])',
    'class:`toolcall-content`',
    'class:`toolcall-content-text`',
  ]) assert.ok(js.includes(marker), `Missing public marker: ${marker}`);
  const css = await (await fetch('https://statics.moonshot.cn/kimi-web-seo/assets/DolkzG3r.css')).text();
  assert.match(css, /\.thinking-container \.toolcall-content/);
});

test('tagged Kimi Code 2.1.1 web bundle selectors remain exact', {
  skip: process.env.KCT_CHECK_UPSTREAM !== '1' && 'Set KCT_CHECK_UPSTREAM=1 for public upstream check',
}, async t => {
  const url = 'https://raw.githubusercontent.com/MoonshotAI/kimi-code/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/apps/kimi-code/dist-web/assets/index-CiJ6FDOC.js';
  const response = await fetch(url);
  if (response.status === 429) return t.skip('GitHub raw rate limited');
  assert.equal(response.status, 200);
  const js = await response.text();
  for (const marker of [
    'class:We(["think",{mob:e.mobile,open:p(n),streaming:e.streaming}])',
    'class:"think-head",type:"button"',
    'class:We(["think-body",{open:p(n),instant:c.value}])',
    'class:"think-body-inner"',
    'class:"think-text"',
  ]) assert.ok(js.includes(marker), `Missing tagged bundle marker: ${marker}`);
});

test('actual unpacked MV3 translates after SPA navigation with worker transport and extension storage', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kct-mv3-fixture-'));
  const extension = fileURLToPath(new URL('dist/', root));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  t.after(async () => { await context.close(); await rm(dir, { recursive: true, force: true }); });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    globalThis.requests = [];
    globalThis.fetch = async (url, options) => {
      globalThis.requests.push({ url, credentials: options.credentials, texts: JSON.parse(options.body) });
      return { ok: true, json: async () => JSON.parse(options.body).map(text => ({ translations: [{ text: `MV3译文:${text}` }] })) };
    };
  });
  const html = await readFile(new URL('fixtures/code-web.html', root), 'utf8');
  await context.route('http://localhost:58627/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  const page = await context.newPage();
  await page.goto(codeURL);
  await page.evaluate(() => history.pushState(null, '', '/sessions/mv3-fixture'));
  const ui = page.locator('#thinking [data-kct-browser]');
  await ui.waitFor();
  assert.deepEqual(await worker.evaluate(() => globalThis.requests), []);
  await ui.getByLabel('翻译目标语言').selectOption('zh');
  await ui.getByRole('button', { name: '确认语言并允许发送到 Bing' }).click();
  await ui.getByRole('button', { name: '翻译本段', exact: true }).click();
  await ui.locator('output').waitFor({ state: 'visible' });
  assert.match(await ui.locator('output').textContent(), /MV3译文/);
  const requests = await worker.evaluate(() => globalThis.requests);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].credentials, 'omit');
  assert.equal(await page.evaluate(() => globalThis.KCTBrowserCore), undefined, 'content script runs in isolated world');
  const stored = await worker.evaluate(() => chrome.storage.local.get(null));
  assert.deepEqual(stored, { 'kct.browser.v1:http://localhost:58627': { language: 'zh', consent: true, auto: false } });
});
