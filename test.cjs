const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('playwright');

const SCRIPT = readFileSync(join(__dirname, 'kct.js'), 'utf8');
const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function fixture(t, { texts = ['First paragraph.\n\nSecond paragraph.'], manual = false,
  streaming = false, delay = 0, fail = false, timeout = false, cache, settings = {},
  clock, holdResponses = false, inject = true } = {}) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 900, height: 700 } });
  let release = () => {};
  const gate = holdResponses ? new Promise((resolve) => { release = resolve; }) : null;
  t.after(() => { release(); return context.close(); });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  let active = 0;
  let peak = 0;
  let shouldFail = fail;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://kct.test/', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
      :root{--font-ui:sans-serif;--text-base:14px;--leading-normal:1.6;--color-text:#222;
      --color-text-muted:#666;--color-text-faint:#888;--color-surface-raised:#fff;--color-line:#ddd}
      body{margin:30px;font:14px/1.6 sans-serif}.think{--think-gutter:20px;--think-gap:8px;margin:16px 0}
      .think-head{display:flex;align-items:center;gap:8px;width:100%;min-height:20px;padding:0;
      border:0;background:none;color:var(--color-text-muted);font:inherit;line-height:20px;text-align:left}
      .think-body{display:grid;grid-template-rows:minmax(0,0fr);overflow:hidden}
      .think-body.open{grid-template-rows:minmax(0,1fr)}.think-body-inner{min-height:0;overflow:hidden;padding-left:28px}
      .think-text{font:14px/1.6 sans-serif;color:#666;white-space:pre-wrap;margin:0;padding:6px 0 0}
      </style></head><body><main>${texts.map((text, index) => `
      <div class="think ${streaming ? 'streaming' : ''}" id="t${index}">
      <button class="think-head" aria-expanded="false"><span>◇</span><span>思考过程</span><span>3 秒</span><span>›</span></button>
      <div class="think-body" inert><div class="think-body-inner"><pre class="think-text">${esc(text)}</pre></div></div></div>`).join('')}
      </main><script>
      localStorage.setItem('kimi-locale','zh');
      document.querySelectorAll('.think-head').forEach(head => head.onclick=()=>{
        const body=head.parentElement.querySelector('.think-body');
        const open=body.classList.toggle('open'); body.inert=!open;
        head.setAttribute('aria-expanded',String(open));head.parentElement.classList.toggle('open',open);
      });
      </script></body></html>`,
  }));
  await page.route('https://edge.microsoft.com/**', async (route) => {
    const text = route.request().postDataJSON();
    const lang = new URL(route.request().url()).searchParams.get('to');
    const item = { text, lang, start: Date.now() };
    requests.push(item);
    active++;
    peak = Math.max(peak, active);
    try {
      if (gate) await gate;
      const wait = typeof delay === 'function' ? delay(requests.length) : delay;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      await route.fulfill({
        status: shouldFail ? (typeof shouldFail === 'number' ? shouldFail : 503) : 200,
        contentType: 'application/json',
        body: JSON.stringify(text.map((value) => ({ translations: [{ text: `${lang}:${value}` }] }))),
      });
    } catch (_) { /* A closing fixture may cancel its test response. */ }
    finally { active--; }
  });
  await page.goto('http://kct.test/');
  await page.evaluate(({ cache, settings, manual }) => {
    if (cache !== undefined) localStorage.setItem('kct:cache:v1', cache);
    localStorage.setItem('kct:settings:v1',
      JSON.stringify({ autoTranslate: !manual, targetLanguage: 'zh', ...settings }));
  }, { cache, settings, manual });
  if (clock) await page.clock.install({ time: new Date(clock) });
  if (timeout) await page.evaluate(() => {
    const original = window.setTimeout;
    window.setTimeout = (fn, ms, ...args) => original(fn, ms === 15000 ? 80 : ms, ...args);
  });
  if (inject) await page.addScriptTag({ content: SCRIPT });
  return {
    page, requests, errors, release, peak: () => peak,
    recover: () => { shouldFail = false; },
    open: (index = 0) => page.locator(`#t${index} .think-head`).click(),
    done: (index = 0) => page.waitForFunction((id) => {
      const el = document.querySelector(`#t${id} .kct-status`);
      return el?.dataset.state === 'ok' && el.textContent === '';
    }, index),
  };
}

test('selected Chinese target, one batch, collapsed UI, original preserved, cache reused', async (t) => {
  const f = await fixture(t);
  const { page } = f;
  assert.equal(await page.locator('.kct-bar').isVisible(), false);
  assert.equal(f.requests.length, 0);
  await f.open();
  await f.done();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].text, ['First paragraph.', 'Second paragraph.']);
  assert.equal(f.requests[0].lang, 'zh-Hans');
  assert.equal(await page.locator('pre:not([data-kct])').textContent(), 'First paragraph.\n\nSecond paragraph.');
  const head = await page.locator('.think-head').boundingBox();
  const bar = await page.locator('.kct-bar').boundingBox();
  assert.equal(head.y, bar.y);
  await page.getByRole('button', { name: '查看原文', exact: true }).click();
  assert.equal(await page.locator('pre:not([data-kct])').isVisible(), true);
  await page.getByRole('button', { name: '查看译文', exact: true }).click();
  await page.evaluate(() => window.__kct.resetAll());
  await f.done();
  assert.equal(f.requests.length, 1);
  await f.open();
  await page.locator('.kct-bar').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.kct-bar').isVisible(), false);
  assert.deepEqual(f.errors, []);
});

test('first expansion requires a language choice, persists it and does not prompt after reload', async (t) => {
  for (const targetLanguage of [undefined, 'auto']) {
    await t.test(targetLanguage === undefined ? 'missing target' : 'legacy auto target', async (t) => {
      const f = await fixture(t, { settings: { targetLanguage } });
      const { page } = f;
      await page.clock.install();
      assert.equal(await page.locator('#kct-settings').count(), 0);
      assert.equal(f.requests.length, 0);
      await f.open();
      const panel = page.locator('#kct-settings');
      await panel.waitFor({ timeout: 3000 });
      await page.clock.runFor(1000);
      assert.equal(f.requests.length, 0);
      assert.equal(await page.locator('pre:not([data-kct])').isVisible(), true);
      assert.equal(await page.locator('.kct-translated').count(), 0);
      await page.getByLabel('目标语言').selectOption('ja');
      await page.clock.runFor(1000);
      assert.equal(f.requests.length, 0, 'a selection must wait for confirmation');
      await panel.getByRole('button', { name: '开始使用', exact: true }).click();
      await f.done();
      assert.equal(await panel.count(), 0);
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].lang, 'ja');
      assert.match(await page.locator('.kct-translated').textContent(), /^ja:/);
      assert.equal(await page.evaluate(() =>
        JSON.parse(localStorage.getItem('kct:settings:v1')).targetLanguage), 'ja');
      await f.open();
      await f.open();
      await page.clock.runFor(1000);
      assert.equal(await panel.count(), 0);
      await page.reload();
      await page.addScriptTag({ content: SCRIPT });
      await f.open();
      await f.done();
      assert.equal(await panel.count(), 0);
      assert.equal(await page.evaluate(() => window.__kct.state.settings.targetLanguage), 'ja');
      assert.match(await page.locator('.kct-translated').textContent(), /^ja:/);
      assert(f.requests.every((request) => request.lang === 'ja'));
      assert.deepEqual(f.errors, []);
    });
  }
});

test('all eight matching target languages and Chinese inline code preserve the original node and its geometry', async (t) => {
  for (const [targetLanguage, source, label = targetLanguage] of [
    ['zh', '先检查输入是否完整，再逐步分析问题。\n\n确认结果后返回答案。'],
    ['ja', 'まず入力を確認してから、問題を順番に分析します。\n\n結果を確認して回答します。'],
    ['en', 'First check the input, then analyze the problem carefully.\n\nWe should check the result before we return the answer.'],
    ['ko', '먼저 입력 내용을 확인하고 문제를 차근차근 분석합니다.\n\n결과를 확인한 뒤 정확한 답변을 제공합니다.'],
    ['es', 'Primero debemos verificar los datos y luego revisar el resultado antes de responder.'],
    ['fr', 'Nous devons vérifier les données et notre résultat avant de répondre.'],
    ['de', 'Wir müssen die Daten prüfen und dann das Ergebnis mit unserem Bericht vergleichen.'],
    ['ru', 'Сначала мы проверим данные, затем нужно проверить результат, чтобы ответ был точным.'],
    ['zh', '先执行 `const result = await response.json()`，确认 `result.ok === true` 后再返回答案。', 'zh with inline code'],
  ]) {
    await t.test(label, async (t) => {
      const f = await fixture(t, { texts: [source], settings: { targetLanguage }, inject: false });
      const { page } = f;
      await f.open();
      const original = page.locator('pre:not([data-kct])');
      const box = await original.boundingBox();
      assert(box);
      await original.evaluate((el) => { window.originalPre = el; });
      await page.clock.install();
      await page.addScriptTag({ content: SCRIPT });
      await f.done();
      await page.clock.runFor(1000);
      assert.equal(f.requests.length, 0);
      assert.equal(await original.isVisible(), true);
      assert.equal(await original.textContent(), source);
      assert.equal(await original.evaluate((el) => el === window.originalPre), true);
      assert.equal(await page.locator('.kct-translated').count(), 0);
      assert.deepEqual(await original.boundingBox(), box);
      assert.equal(await page.locator('button[title="翻译这段思考"]').evaluate((el) => el.hidden), true);
      assert.equal(await page.locator('#kct-settings').count(), 0);
      await f.open();
      await f.open();
      await page.clock.runFor(1000);
      assert.equal(f.requests.length, 0);
      assert.equal(await original.isVisible(), true);
      assert.equal(await page.locator('.kct-translated').count(), 0);
      assert.deepEqual(await original.boundingBox(), box);
      assert.deepEqual(f.errors, []);
    });
  }
});

test('unrelated class mutations on a target-language block settle without recurring animation frames', async (t) => {
  const f = await fixture(t, { texts: ['先检查输入是否完整，再逐步分析问题。'] });
  await f.page.clock.install();
  await f.open();
  await f.done();
  await f.page.clock.runFor(1000);
  const original = f.page.locator('pre:not([data-kct])');
  const box = await original.boundingBox();
  assert(box);
  await f.page.evaluate(() => {
    const raf = window.requestAnimationFrame;
    window.scheduledFrames = 0;
    window.requestAnimationFrame = (callback) => {
      window.scheduledFrames++;
      return raf(callback);
    };
    document.querySelector('.think').classList.add('unrelated-host');
    document.querySelector('.think-body-inner').classList.add('unrelated-body');
    document.querySelector('pre:not([data-kct])').classList.add('unrelated-source');
  });
  await f.page.clock.runFor(1000);
  const frames = await f.page.evaluate(() => window.scheduledFrames);
  assert(frames > 0, 'the mutation must exercise the thinking-block update');
  await f.page.clock.runFor(1000);
  assert.equal(await f.page.evaluate(() => window.scheduledFrames), frames,
    'class mutations must settle instead of sustaining a requestAnimationFrame loop');
  assert.equal(f.requests.length, 0);
  assert.equal(await original.isVisible(), true);
  assert.equal(await f.page.locator('.kct-translated').count(), 0);
  assert.deepEqual(await original.boundingBox(), box);
  assert.deepEqual(f.errors, []);
});

test('mixed Chinese and English send only English and preserve Chinese in place', async (t) => {
  for (const separator of ['\n\n', '']) {
    await t.test(separator ? 'separate paragraphs' : 'one paragraph', async (t) => {
      const source = ['先检查输入。', 'Analyze the input carefully.', '最后确认结果。'].join(separator);
      const f = await fixture(t, { texts: [source] });
      await f.open();
      await f.done();
      assert.deepEqual(f.requests.map((request) => request.text), [['Analyze the input carefully.']]);
      assert.equal(f.requests[0].lang, 'zh-Hans');
      assert.equal(await f.page.locator('.kct-translated').textContent(),
        ['先检查输入。', 'zh-Hans:Analyze the input carefully.', '最后确认结果。'].join(separator));
      assert.equal(await f.page.locator('pre:not([data-kct])').textContent(), source);
      assert.deepEqual(f.errors, []);
    });
  }
});

test('an unchanged service response keeps ambiguous text in its original node and position', async (t) => {
  const source = 'Confirmed.';
  const f = await fixture(t, { texts: [source], settings: { targetLanguage: 'en' }, inject: false });
  const requests = [];
  await f.page.route('https://edge.microsoft.com/**', (route) => {
    const text = route.request().postDataJSON();
    requests.push(text);
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(text.map((value) => ({ translations: [{ text: value }] }))),
    });
  });
  await f.open();
  const original = f.page.locator('pre:not([data-kct])');
  const box = await original.boundingBox();
  assert(box);
  await original.evaluate((el) => { window.originalPre = el; });
  await f.page.addScriptTag({ content: SCRIPT });
  await f.done();
  assert.deepEqual(requests, [[source]]);
  assert.equal(await original.isVisible(), true);
  assert.equal(await original.textContent(), source);
  assert.equal(await original.evaluate((el) => el === window.originalPre), true);
  assert.equal(await f.page.locator('.kct-translated').count(), 0);
  assert.deepEqual(await original.boundingBox(), box);
  assert.equal(await f.page.locator('button[title="翻译这段思考"]').evaluate((el) => el.hidden), true);
  assert.deepEqual(f.errors, []);
});

test('uncertain Latin text is translated instead of being mistaken for the selected language', async (t) => {
  for (const [targetLanguage, source] of [
    ['en', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.'],
    ['en', 'Bonjour, veuillez examiner les données avant de répondre.'],
    ['fr', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.'],
  ]) {
    await t.test(`${targetLanguage}: ${source}`, async (t) => {
      const f = await fixture(t, { texts: [source], settings: { targetLanguage } });
      await f.open();
      await f.done();
      assert.deepEqual(f.requests.map((request) => request.text), [[source]]);
      assert.equal(f.requests[0].lang, targetLanguage);
      assert.equal(await f.page.locator('.kct-translated').textContent(), `${targetLanguage}:${source}`);
      assert.deepEqual(f.errors, []);
    });
  }
});

test('manual translation remains available with auto translation disabled', async (t) => {
  const f = await fixture(t, { manual: true });
  await f.open();
  const button = f.page.getByRole('button', { name: '翻译', exact: true });
  assert.equal(await button.isEnabled(), true);
  assert.equal(f.requests.length, 0);
  await button.click();
  await f.done();
  assert.equal(f.requests.length, 1);
});

test('batch concurrency, ordered incremental output and original-view preference', async (t) => {
  const source = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
  const f = await fixture(t, { texts: [source], delay: (i) => i === 1 ? 50 : 700 });
  await f.open();
  await f.page.waitForFunction(() => document.querySelector('.kct-translated')?.textContent.startsWith('zh-Hans:'));
  assert.match(await f.page.locator('.kct-status').textContent(), /翻译中/);
  await f.page.getByRole('button', { name: '查看原文', exact: true }).click();
  await f.done();
  assert.equal(f.requests.length, 3);
  assert.equal(f.peak(), 3);
  assert.equal(await f.page.locator('.think').getAttribute('kct-view'), 'original');
  assert.equal(await f.page.locator('.kct-translated').textContent(),
    source.split('\n\n').map((text) => `zh-Hans:${text}`).join('\n\n'));
});

test('in-flight requests shared by identical expanded blocks', async (t) => {
  const f = await fixture(t, { texts: ['Shared paragraph.', 'Shared paragraph.'], delay: 250 });
  await f.open(0);
  await f.open(1);
  await Promise.all([f.done(0), f.done(1)]);
  assert.equal(f.requests.length, 1);
});

test('streaming translates completed paragraphs and leaves the tail readable', async (t) => {
  const f = await fixture(t, { texts: ['Completed paragraph.\n\nUnfinished'], streaming: true });
  await f.open();
  await f.page.waitForFunction(() => !!document.querySelector('.kct-translated'));
  assert.deepEqual(f.requests[0].text, ['Completed paragraph.']);
  assert.equal(await f.page.locator('.kct-translated').textContent(), 'zh-Hans:Completed paragraph.\n\nUnfinished');
  await f.page.evaluate(() => {
    document.querySelector('pre:not([data-kct])').textContent += ' tail';
  });
  await f.page.waitForFunction(() => document.querySelector('.kct-translated')?.textContent.endsWith('Unfinished tail'));
  assert.equal(f.requests.length, 1);
  await f.page.evaluate(() => {
    document.querySelector('pre:not([data-kct])').textContent += ' paragraph.';
    document.querySelector('.think').classList.remove('streaming');
  });
  await f.done();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].text, ['Unfinished tail paragraph.']);
});

test('stream ending at a paragraph boundary settles without another request', async (t) => {
  const f = await fixture(t, { texts: ['Completed paragraph.\n\n'], streaming: true });
  await f.open();
  await f.page.waitForFunction(() => !!document.querySelector('.kct-translated'));
  await f.page.evaluate(() => document.querySelector('.think').classList.remove('streaming'));
  await f.done();
  assert.equal(f.requests.length, 1);
});

test('failures wait for explicit retry; no mutation-triggered retry storm', async (t) => {
  const f = await fixture(t, { fail: 400 });
  await f.open();
  await f.page.getByRole('button', { name: '重试', exact: true }).waitFor();
  await f.page.evaluate(() => document.querySelector('.think').classList.add('unrelated'));
  await f.page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(f.requests.length, 1);
  assert.equal(await f.page.locator('pre:not([data-kct])').isVisible(), true);
  f.recover();
  await f.page.getByRole('button', { name: '重试', exact: true }).click();
  await f.done();
  assert.equal(f.requests.length, 2);
});

async function mockFailures(page, mode, retryAfter = null) {
  await page.evaluate(({ mode, retryAfter }) => {
    window.translationCalls = [];
    window.responseMode = mode;
    Math.random = () => 0.5;
    window.fetch = async (url, options) => {
      const host = new URL(url).hostname;
      const texts = host === 'translate.googleapis.com'
        ? [new URLSearchParams(options.body).get('q')] : JSON.parse(options.body);
      window.translationCalls.push({ texts, time: Date.now(), host });
      if (window.responseMode === 'network') throw new TypeError('Failed to fetch');
      if (window.responseMode === 'body network') return {
        ok: true, json: async () => { throw new TypeError('Failed to read response body'); },
      };
      if (window.responseMode === 'json') return new Response('{');
      if (window.responseMode === 'shape') return new Response('[]');
      if (window.responseMode !== 'ok') return new Response('', {
        status: Number(window.responseMode),
        headers: retryAfter === null ? {} : { 'retry-after': retryAfter },
      });
      return new Response(JSON.stringify(host === 'translate.googleapis.com'
        ? [texts.map(text => [`译:${text}`])]
        : texts.map(text => ({ translations: [{ text: `译:${text}` }] }))));
    };
  }, { mode, retryAfter });
}

test('429 pauses only its provider, honors seconds and HTTP-date, and resumes queued batches', async (t) => {
  for (const retryAfter of ['60', 'Thu, 22 Oct 2026 00:01:00 GMT', 'invalid', null]) {
    await t.test(String(retryAfter), async (t) => {
      const source = Array.from({ length: 80 }, (_, i) => `Limited paragraph ${i}.`).join('\n\n');
      const f = await fixture(t, { texts: [source], clock: '2026-10-22T00:00:00Z' });
      await mockFailures(f.page, '429', retryAfter);
      await f.page.clock.pauseAt(new Date('2026-10-22T00:00:01Z'));
      await f.open();
      await f.page.clock.runFor(16);
      await f.page.waitForFunction(() => window.__kct.state.cooldowns.size === 1 && window.__kct.state.active === 0);
      const initial = await f.page.evaluate(() => window.translationCalls.length);
      assert.equal(initial, 3, 'only the requests already in flight may reach the limited provider');
      assert.equal(await f.page.evaluate(() => window.__kct.state.queue.length), 10);
      await f.page.evaluate(() => {
        window.responseMode = 'ok';
        window.googleResult = window.__kct.translateText('Other provider.', 'zh', () => {}, { provider: 'google' });
      });
      assert.equal(await f.page.evaluate(() => window.googleResult), '译:Other provider.');
      assert.equal(await f.page.evaluate(() => window.translationCalls.length), initial + 1,
        'a different provider must remain usable during cooldown');
      const { deadline, now, first } = await f.page.evaluate(() => ({
        deadline: window.__kct.state.cooldowns.get('bing'), now: Date.now(), first: window.translationCalls[0].time,
      }));
      assert.equal(deadline, retryAfter?.includes('GMT') ? Date.parse(retryAfter) : first + 60000);
      await f.page.clock.runFor(deadline - now - 1);
      assert.equal(await f.page.evaluate(() => window.translationCalls.length), initial + 1);
      await f.page.clock.runFor(1);
      await f.done();
      const calls = await f.page.evaluate(() => window.translationCalls.filter(call => call.host === 'edge.microsoft.com'));
      assert.equal(calls.length, 13);
      assert(calls.slice(initial).every(call => call.time >= deadline));
      assert.deepEqual(f.errors, []);
    });
  }
});

test('5xx and network failures back off with bounded jitter, stop after two retries, and release concurrency', async (t) => {
  for (const [mode, random, delay] of [
    ['503', 0, 800], ['network', 0.5, 1000], ['503', 1, 1200], ['body network', 0.5, 1000],
  ]) {
    await t.test(`${mode}, jitter ${random}`, async (t) => {
      const f = await fixture(t, { texts: ['Retry source.'], clock: '2026-10-22T00:00:00Z' });
      await mockFailures(f.page, mode);
      await f.page.evaluate(random => { Math.random = () => random; }, random);
      await f.page.clock.pauseAt(new Date('2026-10-22T00:00:01Z'));
      await f.open();
      await f.page.clock.runFor(16);
      await f.page.waitForFunction(() => window.__kct.state.queue.length === 1 && window.__kct.state.active === 0);
      const remaining = await f.page.evaluate(() => window.__kct.state.queue[0].readyAt - Date.now());
      await f.page.clock.runFor(remaining - 1);
      assert.equal(await f.page.evaluate(() => window.translationCalls.length), 1);
      await f.page.clock.runFor(1);
      assert.equal(await f.page.evaluate(() => window.translationCalls.length), 2);
      await f.page.clock.runFor(delay * 2 - 1);
      assert.equal(await f.page.evaluate(() => window.translationCalls.length), 2);
      await f.page.clock.runFor(1);
      await f.page.getByRole('button', { name: '重试', exact: true }).waitFor();
      await f.page.clock.runFor(10000);
      const calls = await f.page.evaluate(() => window.translationCalls);
      assert.equal(calls.length, 3);
      assert.deepEqual(calls.slice(1).map((call, i) => call.time - calls[i].time), [delay, delay * 2]);
      assert.deepEqual(await f.page.evaluate(() => ({
        active: window.__kct.state.active, queued: window.__kct.state.queue.length,
      })), { active: 0, queued: 0 });
      assert.deepEqual(f.errors, []);
    });
  }
});

test('a transient retry succeeds without poisoning the failure cache', async (t) => {
  const f = await fixture(t, { clock: '2026-10-22T00:00:00Z' });
  await mockFailures(f.page, '503');
  await f.page.clock.pauseAt(new Date('2026-10-22T00:00:01Z'));
  await f.open();
  await f.page.clock.runFor(16);
  const remaining = await f.page.evaluate(() => {
    window.responseMode = 'ok';
    return window.__kct.state.queue[0].readyAt - Date.now();
  });
  await f.page.clock.runFor(remaining);
  await f.done();
  assert.equal(await f.page.evaluate(() => window.translationCalls.length), 2);
  assert.equal(await f.page.evaluate(() => window.__kct.state.failures.size), 0);
  assert.deepEqual(f.errors, []);
});

test('collapsing a block cancels delayed retries and provider cooldown work', async (t) => {
  for (const mode of ['503', '429']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, { clock: '2026-10-22T00:00:00Z' });
      await mockFailures(f.page, mode, '60');
      await f.page.clock.pauseAt(new Date('2026-10-22T00:00:01Z'));
      await f.open();
      await f.page.clock.runFor(16);
      assert.equal(await f.page.evaluate(() => window.__kct.state.queue.length), 1);
      await f.open();
      await f.page.clock.runFor(60000);
      assert.equal(await f.page.evaluate(() => window.translationCalls.length), 1);
      assert.deepEqual(await f.page.evaluate(() => ({
        queued: window.__kct.state.queue.length, pending: window.__kct.state.inFlight.size,
        failures: window.__kct.state.failures.size,
      })), { queued: 0, pending: 0, failures: 0 });
      assert.deepEqual(f.errors, []);
    });
  }
});

test('4xx, JSON parsing and shape failures are structured where applicable and never auto-retry', async (t) => {
  for (const mode of ['401', 'json', 'shape']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, { manual: true, clock: '2026-10-22T00:00:00Z' });
      await mockFailures(f.page, mode, '5');
      const error = await f.page.evaluate(async () => {
        try { await window.__kct.translateText('Rejected source.', 'zh'); } catch (error) {
          return { status: error.status, retryAfterMs: error.retryAfterMs };
        }
      });
      if (mode === '401') assert.deepEqual(error, { status: 401, retryAfterMs: 5000 });
      await f.page.clock.runFor(10000);
      assert.equal(await f.page.evaluate(() => window.translationCalls.length), 1);
    });
  }
});

test('streaming failures are cached by completed fragment for 30 seconds; manual retry clears only those fragments', async (t) => {
  const f = await fixture(t, {
    texts: ['Failed completed paragraph.\n\nGrowing'], streaming: true, clock: '2026-10-22T00:00:00Z',
  });
  await mockFailures(f.page, '400');
  await f.open();
  await f.page.clock.runFor(800);
  await f.page.getByRole('button', { name: '重试', exact: true }).waitFor();
  for (let i = 0; i < 6; i++) {
    await f.page.evaluate(() => { document.querySelector('.think-text').textContent += ' tail'; });
    await f.page.clock.runFor(800);
  }
  assert.equal(await f.page.evaluate(() => window.translationCalls.length), 1);
  await f.page.evaluate(() => {
    document.querySelector('.think-text').textContent += '\n\nNew completed paragraph.\n\nTail';
  });
  await f.page.clock.runFor(800);
  const calls = await f.page.evaluate(() => window.translationCalls);
  assert.equal(calls.length, 2);
  assert(calls[1].texts.every(text => text !== 'Failed completed paragraph.'));
  await f.page.clock.runFor(30000);
  await f.page.evaluate(() => { document.querySelector('.think-text').textContent += ' after expiry'; });
  await f.page.clock.runFor(800);
  assert.equal(await f.page.evaluate(() => window.translationCalls.length), 3);
  await f.page.evaluate(() => {
    window.responseMode = 'ok';
    document.querySelector('.think').classList.remove('streaming');
  });
  await f.page.clock.runFor(100);
  await f.page.getByRole('button', { name: '重试', exact: true }).click();
  await f.done();
  assert.equal(await f.page.evaluate(() => window.translationCalls.length), 5);
  assert.deepEqual(f.errors, []);
});

test('hard limits preserve unbroken text and surrogate pairs', async (t) => {
  const source = 'A'.repeat(1499) + '😀' + 'B'.repeat(3600);
  const f = await fixture(t, { texts: [source] });
  await f.open();
  await f.done();
  const pieces = f.requests.flatMap((request) => request.text);
  assert.equal(pieces.join(''), source);
  assert(pieces.every((text) => text.length <= 1500 && !/[\uD800-\uDBFF]$/.test(text)));
  assert(f.requests.every((request) => request.text.join('').length <= 4000));
});

test('changing language while a request is pending cannot render the old result', async (t) => {
  const f = await fixture(t, { holdResponses: true });
  const firstRequest = f.page.waitForRequest('https://edge.microsoft.com/**');
  await f.open();
  await firstRequest;
  await f.page.evaluate(() => {
    window.languageOutputs = [];
    new MutationObserver(() => {
      const text = document.querySelector('.kct-translated')?.textContent;
      if (text) window.languageOutputs.push(text);
    }).observe(document.querySelector('.think-body-inner'), { childList: true, characterData: true, subtree: true });
  });
  const nextRequest = f.page.waitForRequest('https://edge.microsoft.com/**');
  await f.page.getByRole('button', { name: '思维链翻译设置' }).click();
  await f.page.getByLabel('目标语言').selectOption('ja');
  await nextRequest;
  await f.page.keyboard.press('Escape');
  f.release();
  await f.done();
  await f.page.waitForFunction(() => window.__kct.state.active === 0);
  assert.match(await f.page.locator('.kct-translated').textContent(), /^ja:/);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.map((request) => request.lang), ['zh-Hans', 'ja']);
  const outputs = await f.page.evaluate(() => window.languageOutputs);
  assert(outputs.length > 0);
  assert(outputs.every((text) => text.startsWith('ja:')), 'an obsolete language must never be rendered');
  assert.equal(await f.page.evaluate(() =>
    JSON.parse(localStorage.getItem('kct:settings:v1')).targetLanguage), 'ja');
  assert.deepEqual(f.errors, []);
});

test('switching a pending translation to the source language preserves the original and discards the old result', async (t) => {
  const source = 'We should check the input before we return the answer.';
  const f = await fixture(t, { texts: [source], holdResponses: true });
  await f.open();
  await f.page.waitForFunction(() => window.__kct.state.active === 1);
  const original = f.page.locator('pre:not([data-kct])');
  const box = await original.boundingBox();
  assert(box);
  await f.page.getByRole('button', { name: '思维链翻译设置' }).click();
  await f.page.getByLabel('目标语言').selectOption('en');
  await f.page.keyboard.press('Escape');
  await f.done();
  f.release();
  await f.page.waitForFunction(() => window.__kct.state.active === 0);
  assert.equal(f.requests.length, 1);
  assert.equal(await original.isVisible(), true);
  assert.equal(await original.textContent(), source);
  assert.equal(await f.page.locator('.kct-translated').count(), 0);
  assert.deepEqual(await original.boundingBox(), box);
  assert.equal(await f.page.evaluate(() => window.__kct.state.cache.size), 0);
  assert.equal(await f.page.evaluate(() =>
    JSON.parse(localStorage.getItem('kct:settings:v1')).targetLanguage), 'en');
  assert.deepEqual(f.errors, []);
});

test('replaced body and replaced source nodes recover without stale or duplicated output', async (t) => {
  const f = await fixture(t);
  await f.open();
  await f.done();
  await f.page.evaluate(() => {
    const body = document.querySelector('.think-body-inner');
    const copy = document.createElement('div');
    copy.className = 'think-body-inner';
    copy.innerHTML = '<pre class="think-text">Replacement body.</pre>';
    body.replaceWith(copy);
  });
  await f.done();
  assert.equal(await f.page.locator('.kct-translated').textContent(), 'zh-Hans:Replacement body.');
  await f.page.evaluate(() => {
    const source = document.querySelector('pre:not([data-kct])');
    const replacement = source.cloneNode(true);
    replacement.classList.remove('kct-source-hidden');
    source.remove();
    document.querySelector('.think-body-inner').append(replacement);
  });
  await f.page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await f.page.locator('pre:not([data-kct])').isVisible(), false);
  assert.equal(await f.page.locator('.kct-translated').count(), 1);
});

test('timeout releases the queue and exposes retry', async (t) => {
  const f = await fixture(t, { timeout: true, delay: 200 });
  await f.open();
  await f.page.getByRole('button', { name: '重试', exact: true }).waitFor();
  assert.match(await f.page.locator('.kct-status').getAttribute('title'), /超时/);
  assert.equal(await f.page.evaluate(() => window.__kct.state.active), 0);
  assert.equal(await f.page.locator('pre:not([data-kct])').isVisible(), true);
});

test('unrelated DOM activity does not rescan all thinking blocks', async (t) => {
  const f = await fixture(t);
  const scans = await f.page.evaluate(async () => {
    let count = 0;
    const original = document.querySelectorAll.bind(document);
    document.querySelectorAll = (...args) => { if (args[0] === '.think') count++; return original(...args); };
    const node = document.createElement('section');
    document.body.append(node);
    for (let i = 0; i < 20; i++) node.append(document.createElement('span'));
    await new Promise(requestAnimationFrame);
    return count;
  });
  assert.equal(scans, 0);
});

test('settings are labelled, keyboard closable and usable on a narrow dark page', async (t) => {
  const f = await fixture(t, { manual: true });
  await f.page.setViewportSize({ width: 375, height: 700 });
  await f.page.evaluate(() => {
    document.documentElement.style.setProperty('--color-surface-raised', '#222222');
    document.documentElement.style.setProperty('--color-text', '#eeeeee');
  });
  await f.open();
  await f.page.getByRole('button', { name: '思维链翻译设置' }).click();
  assert.equal(await f.page.getByLabel('目标语言').inputValue(), 'zh');
  const dialog = f.page.getByRole('dialog');
  const box = await dialog.boundingBox();
  assert(box.x >= 0 && box.x + box.width <= 375);
  assert.equal(await dialog.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(34, 34, 34)');
  await f.page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0);
  assert.deepEqual(f.errors, []);
});

test('custom model and endpoint changes do not reuse another service cache', async (t) => {
  const f = await fixture(t, { manual: true });
  const requests = [];
  await f.page.route('https://translator.test/**', async (route) => {
    const body = route.request().postDataJSON();
    requests.push({ url: route.request().url(), model: body.model });
    await route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: `${body.model}:${new URL(route.request().url()).pathname}` } }] }) });
  });
  const out = await f.page.evaluate(async () => {
    Object.assign(window.__kct.state.settings, {
      provider: 'custom', customEndpoint: 'https://translator.test/first', customModel: 'one',
    });
    const a = await window.__kct.translateText('Same source.', 'zh');
    window.__kct.state.settings.customModel = 'two';
    const b = await window.__kct.translateText('Same source.', 'zh');
    window.__kct.state.settings.customEndpoint = 'https://translator.test/second';
    const c = await window.__kct.translateText('Same source.', 'zh');
    const cached = await window.__kct.translateText('Same source.', 'zh');
    return [a, b, c, cached];
  });
  assert.deepEqual(out, ['one:/first', 'two:/first', 'two:/second', 'two:/second']);
  assert.equal(requests.length, 3);
});

test('changing a custom endpoint origin clears the old key and pauses automatic translation until confirmation', async (t) => {
  const f = await fixture(t, { clock: '2026-10-22T00:00:00Z', settings: {
    provider: 'custom', customEndpoint: 'https://old.translator.test/first', customKey: 'old-secret',
  } });
  const calls = [];
  for (const host of ['old', 'new']) {
    await f.page.route(`https://${host}.translator.test/**`, async (route) => {
      calls.push({ url: route.request().url(), authorization: route.request().headers().authorization });
      await route.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: '译文' } }] }) });
    });
  }
  await f.open();
  await f.done();
  assert(calls.every(call => call.authorization === 'Bearer old-secret'));
  await f.page.getByRole('button', { name: '思维链翻译设置' }).click();
  await f.page.getByLabel('端点', { exact: true }).fill('https://old.translator.test/second');
  await f.page.getByLabel('模型', { exact: true }).click();
  await f.done();
  assert.equal(await f.page.getByLabel('密钥', { exact: true }).inputValue(), 'old-secret',
    'a same-origin path change may keep the key');
  const before = calls.length;
  await f.page.getByLabel('端点', { exact: true }).fill('https://new.translator.test/translate');
  await f.page.getByLabel('模型', { exact: true }).click();
  await f.page.clock.runFor(1000);
  assert.equal(calls.length, before);
  assert.equal(await f.page.getByLabel('密钥', { exact: true }).inputValue(), '');
  assert.deepEqual(await f.page.evaluate(() => ({
    key: window.__kct.state.settings.customKey,
    pending: window.__kct.state.settings.customKeyPending,
    stored: JSON.parse(localStorage.getItem('kct:settings:v1')).customKey,
  })), { key: '', pending: true, stored: '' });
  await f.page.reload();
  await f.page.addScriptTag({ content: SCRIPT });
  await f.open();
  await f.page.clock.runFor(1000);
  assert.equal(calls.length, before, 'the confirmation requirement must survive reload');
  await f.page.getByRole('button', { name: '思维链翻译设置' }).click();
  await f.page.getByLabel('密钥', { exact: true }).fill('new-secret');
  await f.page.getByLabel('模型', { exact: true }).click();
  await f.page.clock.runFor(1000);
  assert.equal(calls.length, before, 'editing the new key must still wait for confirmation');
  await f.page.getByRole('button', { name: '确认密钥', exact: true }).click();
  await f.done();
  const newCalls = calls.filter(call => new URL(call.url).hostname === 'new.translator.test');
  assert(newCalls.length > 0);
  assert(newCalls.every(call => call.authorization === 'Bearer new-secret'));
  assert.deepEqual(f.errors, []);
});

test('remote HTTP custom endpoints are rejected in settings and at send time; loopback HTTP remains supported', async (t) => {
  const f = await fixture(t, { manual: true, settings: {
    provider: 'custom', customEndpoint: 'https://translator.test/first', customKey: 'secret',
  } });
  await f.open();
  await f.page.getByRole('button', { name: '思维链翻译设置' }).click();
  await f.page.getByLabel('端点', { exact: true }).fill('http://remote.test/translate');
  await f.page.getByLabel('模型', { exact: true }).click();
  assert.match(await f.page.getByRole('alert').textContent(), /必须使用 HTTPS/);
  assert.equal(await f.page.evaluate(() => window.__kct.state.settings.customEndpoint), 'https://translator.test/first');
  const result = await f.page.evaluate(async () => {
    const calls = [];
    window.fetch = async (url, options) => {
      calls.push({ url, redirect: options.redirect });
      return new Response(JSON.stringify({ choices: [{ message: { content: '译文' } }] }));
    };
    let error;
    try {
      await window.__kct.translateText('Unsafe endpoint.', 'zh', () => {}, {
        provider: 'custom', customEndpoint: 'http://remote.test/translate', customKey: 'secret',
      });
    } catch (failure) { error = failure.message; }
    const rejectedCalls = calls.length;
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      await window.__kct.translateText('Local endpoint.', 'zh', () => {}, {
        provider: 'custom', customEndpoint: `http://${host}/translate`, customKey: '',
      });
    }
    return { error, rejectedCalls, calls };
  });
  assert.match(result.error, /必须使用 HTTPS/);
  assert.equal(result.rejectedCalls, 0);
  assert.equal(result.calls.length, 3);
  assert(result.calls.every(call => call.redirect === 'error'));
  assert.deepEqual(f.errors, []);
});

test('custom endpoint confirmation also permits an explicitly empty key', async (t) => {
  const f = await fixture(t, { manual: true, settings: {
    provider: 'custom', customEndpoint: 'http://localhost/first', customKey: 'old-secret',
  } });
  const calls = [];
  await f.page.route('http://127.0.0.1/**', async (route) => {
    calls.push(route.request().headers().authorization);
    await route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: '译文' } }] }) });
  });
  await f.open();
  await f.page.getByRole('button', { name: '思维链翻译设置' }).click();
  await f.page.getByLabel('端点', { exact: true }).fill('http://127.0.0.1/translate');
  await f.page.getByLabel('模型', { exact: true }).click();
  await f.page.getByRole('button', { name: '确认密钥', exact: true }).click();
  await f.page.keyboard.press('Escape');
  await f.page.getByRole('button', { name: '翻译这段思考', exact: true }).click();
  await f.done();
  assert(calls.length > 0);
  assert(calls.every(authorization => authorization === undefined));
  assert.equal(await f.page.evaluate(() => window.__kct.state.settings.customKeyPending), false);
  assert.deepEqual(f.errors, []);
});

test('malformed batch responses remain errors and never enter the cache', async (t) => {
  const f = await fixture(t);
  await f.page.route('https://edge.microsoft.com/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ translations: [{ text: '' }] }]) }));
  await f.open();
  await f.page.getByRole('button', { name: '重试', exact: true }).waitFor();
  assert.equal(await f.page.locator('.kct-translated').count(), 0);
  assert.equal(await f.page.evaluate(() => window.__kct.state.cache.size), 0);
  assert.equal(await f.page.locator('pre:not([data-kct])').isVisible(), true);
});

test('legacy cache migration caps startup at 500 entries without changing settings or keys', async (t) => {
  const entries = Array.from({ length: 650 }, (_, i) =>
    [`bing\u0000zh\u0000${i.toString(36)}-1-1`, `cached translation ${i}`]);
  entries[649][0] = 'custom\u0000zh\u0000https://translator.test/private-endpoint\u0000model\u0000i1-1-1';
  const f = await fixture(t, { cache: JSON.stringify(entries), settings: { customKey: 'keep-this-test-key' } });
  const result = await f.page.evaluate(() => ({
    size: window.__kct.state.cache.size,
    rows: JSON.parse(localStorage.getItem('kct:cache:v1')),
    settings: JSON.parse(localStorage.getItem('kct:settings:v1')),
  }));
  assert.equal(result.size, 500);
  assert.equal(result.rows.length, 500);
  assert.equal(result.rows[0][1], 'cached translation 150');
  assert.equal(result.rows.at(-1)[1], 'cached translation 649');
  assert(result.rows.every(([key, text, time]) =>
    /^[a-z0-9-]+:[a-z0-9-]+$/.test(key) && typeof text === 'string' && Number.isFinite(time)));
  assert.deepEqual(result.settings, { autoTranslate: true, targetLanguage: 'zh', customKey: 'keep-this-test-key' });
});

test('corrupt and oversized old caches are discarded at startup without touching settings', async (t) => {
  for (const cache of ['{invalid', '{"not":"entries"}',
    JSON.stringify([['bing\u0000zh\u00001-1-1', 'x'.repeat(1024 * 1024)]])]) {
    const f = await fixture(t, { cache, settings: { customKey: 'preserved-test-key' } });
    assert.deepEqual(await f.page.evaluate(() => ({
      size: window.__kct.state.cache.size,
      stored: localStorage.getItem('kct:cache:v1'),
      key: window.__kct.state.settings.customKey,
    })), { size: 0, stored: '[]', key: 'preserved-test-key' });
    assert.deepEqual(f.errors, []);
  }
});

test('legacy translations remain reusable and cache hits refresh LRU and the seven-day idle expiry', async (t) => {
  const day = 24 * 60 * 60 * 1000;
  const clock = '2026-01-01T00:00:00Z';
  const original = await fixture(t, { manual: true, clock });
  await original.page.evaluate(() => window.__kct.translateText('Retained source.', 'zh'));
  const row = await original.page.evaluate(() => JSON.parse(localStorage.getItem('kct:cache:v1'))[0]);
  const entries = [
    [`bing\u0000zh\u0000${row[0].split(':')[1]}`, row[1]],
    ...Array.from({ length: 499 }, (_, i) =>
      [`bing\u0000zh\u0000${i.toString(36)}-1-1`, `untouched ${i}`]),
  ];
  const f = await fixture(t, { manual: true, clock, cache: JSON.stringify(entries) });
  await f.page.clock.fastForward(day);
  assert.equal(await f.page.evaluate(() => window.__kct.translateText('Retained source.', 'zh')), row[1]);
  assert.equal(f.requests.length, 0, 'migration must retain a usable cache key');
  await f.page.evaluate(() => window.__kct.translateText('A fresh source.', 'zh'));
  const rows = await f.page.evaluate(() => JSON.parse(localStorage.getItem('kct:cache:v1')));
  assert.equal(rows.length, 500);
  assert.equal(rows[0][1], 'untouched 1', 'the least recently used entry must be evicted');
  assert.equal(rows.at(-2)[1], row[1]);
  assert(rows.at(-2)[2] >= Date.parse(clock) + day);
  const restoredClock = '2026-01-08T00:00:01Z';
  const restored = await fixture(t, {
    manual: true, clock: restoredClock,
    cache: JSON.stringify([...rows,
      ['1-1-1:bad-1-1', 'invalid timestamp', null],
      ['1-1-1:future-1-1', 'future timestamp', Date.parse(restoredClock) + day]]),
  });
  assert.deepEqual(await restored.page.evaluate(() => JSON.parse(localStorage.getItem('kct:cache:v1'))),
    rows.slice(-2), 'reloading must keep last-use timestamps and drop expired or invalid entries');
  await f.page.clock.fastForward(6 * day + 1000);
  assert.equal(await f.page.evaluate(() => window.__kct.state.cache.size), 2,
    'idle expiry must run even without another translation');
  await f.page.clock.fastForward(day + 1000);
  assert.equal(await f.page.evaluate(() => localStorage.getItem('kct:cache:v1')), '[]');
  assert.equal(await f.page.evaluate(() => window.__kct.state.cache.size), 0);
  assert.equal(f.requests.length, 1);
});

test('cache writes stay within a two-MiB UTF-16 JSON budget including escaping', async (t) => {
  const source = Array.from({ length: 20 }, (_, i) => `Budget paragraph ${i}.`).join('\n\n');
  const f = await fixture(t, { texts: [source] });
  await f.page.route('https://edge.microsoft.com/**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(route.request().postDataJSON().map(() =>
      ({ translations: [{ text: '文"\\\n'.repeat(20000) }] }))),
  }));
  await f.open();
  await f.done();
  const result = await f.page.evaluate(() => {
    const stored = localStorage.getItem('kct:cache:v1');
    return { bytes: stored.length * 2, rows: JSON.parse(stored), size: window.__kct.state.cache.size };
  });
  assert(result.bytes <= 2 * 1024 * 1024);
  assert(result.size > 0 && result.size < 20, 'byte pressure must evict entries below the count limit');
  assert.equal(result.rows.length, result.size);
  assert(result.rows.every(([key, text, usedAt]) =>
    /^[a-z0-9-]+:[a-z0-9-]+$/.test(key) && text.startsWith('文') && Number.isFinite(usedAt)));
  assert.equal(await f.page.locator('pre:not([data-kct])').textContent(), source);
});

test('removal, collapse and route changes discard old queued work and cannot refill the cache', async (t) => {
  const source = Array.from({ length: 40 }, (_, i) => `Old paragraph ${i}.`).join('\n\n');
  for (const mode of ['remove', 'collapse', 'route']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, { texts: [source], holdResponses: true });
      await f.open();
      await f.page.waitForFunction(() => window.__kct.state.active === 3 && window.__kct.state.queue.length > 0);
      await f.page.getByRole('button', { name: '思维链翻译设置' }).click();
      await f.page.evaluate((mode) => {
        if (mode === 'remove') document.querySelector('main').replaceChildren();
        if (mode === 'collapse') document.querySelector('.think-head').click();
        if (mode === 'route') history.pushState({}, '', '/sessions/next');
      }, mode);
      await f.page.waitForFunction(() => !window.__kct.state.queue.length && !window.__kct.state.inFlight.size);
      if (mode !== 'collapse') assert.equal(await f.page.getByRole('dialog').count(), 0);
      f.release();
      await f.page.waitForFunction(() => window.__kct.state.active === 0);
      assert.equal(f.requests.length, 3);
      assert.equal(await f.page.locator('.kct-translated').count(), 0);
      assert.equal(await f.page.evaluate(() => localStorage.getItem('kct:cache:v1')), '[]');
      if (mode !== 'remove') assert.equal(await f.page.locator('.think-text').textContent(), source);
      assert.deepEqual(f.errors, []);
    });
  }
});

test('invalid consumers settle before held requests finish and queued work is released', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { manual: true, holdResponses: true });
  const settled = f.page.evaluate(async () => {
    window.consumerLive = true;
    const source = Array.from({ length: 40 }, (_, i) => `Pending paragraph ${i}.`).join('\n\n');
    try {
      await window.__kct.translateText(source, 'zh', () => {}, { ...window.__kct.state.settings },
        () => window.consumerLive);
      return 'unexpected success';
    } catch (error) {
      return error.message;
    }
  });
  await f.page.waitForFunction(() => window.__kct.state.active === 3 && window.__kct.state.queue.length > 0);
  await f.page.evaluate(() => {
    window.consumerLive = false;
    document.body.append(document.createElement('section'));
  });
  assert.match(await settled, /取消/);
  assert.deepEqual(await f.page.evaluate(() => ({
    queued: window.__kct.state.queue.length,
    pending: window.__kct.state.inFlight.size,
    active: window.__kct.state.active,
  })), { queued: 0, pending: 0, active: 3 });
  f.release();
  await f.page.waitForFunction(() => window.__kct.state.active === 0);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.errors, []);
});

test('removing one shared consumer retains the request and translation for the live block', async (t) => {
  const f = await fixture(t, { texts: ['Shared live source.', 'Shared live source.'], holdResponses: true });
  await f.open(0);
  await f.open(1);
  await f.page.waitForFunction(() => [...window.__kct.state.inFlight.values()][0]?.consumers.size === 2);
  await f.page.evaluate(() => document.querySelector('#t0').remove());
  await f.page.waitForFunction(() => [...window.__kct.state.inFlight.values()][0]?.consumers.size === 1);
  f.release();
  await f.done(1);
  assert.equal(f.requests.length, 1);
  assert.equal(await f.page.locator('.kct-translated').textContent(), 'zh-Hans:Shared live source.');
  assert.equal(await f.page.evaluate(() => window.__kct.state.cache.size), 1);
  assert.deepEqual(f.errors, []);
});

test('clearing cache during a request prevents its result from immediately repopulating storage', async (t) => {
  const f = await fixture(t, { holdResponses: true });
  await f.open();
  await f.page.waitForFunction(() => window.__kct.state.active === 1);
  await f.page.getByRole('button', { name: '思维链翻译设置' }).click();
  await f.page.getByText('清空缓存', { exact: true }).click();
  f.release();
  await f.done();
  assert.equal(await f.page.evaluate(() => window.__kct.state.cache.size), 0);
  assert.equal(await f.page.evaluate(() => localStorage.getItem('kct:cache:v1')), '[]');
  assert.equal(f.requests.length, 1);
  await f.page.evaluate(() => window.__kct.resetAll());
  await f.done();
  assert.equal(f.requests.length, 2);
  assert.equal(await f.page.evaluate(() => window.__kct.state.cache.size), 2,
    'new work after clearing must still be cacheable');
  assert.deepEqual(f.errors, []);
});

test('a source replaced during translation cannot populate the old cache or overwrite new output', async (t) => {
  const f = await fixture(t, { texts: ['Old source.'], holdResponses: true });
  await f.open();
  await f.page.waitForFunction(() => window.__kct.state.active === 1);
  await f.page.evaluate(() => {
    document.querySelector('.think-text').textContent = 'New source.';
  });
  await f.page.waitForFunction(() => window.__kct.state.active === 2);
  f.release();
  await f.done();
  await f.page.waitForFunction(() => window.__kct.state.active === 0);
  assert.equal(await f.page.locator('.kct-translated').textContent(), 'zh-Hans:New source.');
  assert.deepEqual(await f.page.evaluate(() =>
    [...window.__kct.state.cache.values()].map((entry) => entry.text)), ['zh-Hans:New source.']);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.errors, []);
});

test('an old completion cannot remove the replacement request for the same source after reopening', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { texts: ['Reopened source.'] });
  const replies = [];
  let secondStarted;
  const started = new Promise((resolve) => { secondStarted = resolve; });
  t.after(() => replies.forEach((release) => release()));
  await f.page.route('https://edge.microsoft.com/**', async (route) => {
    const index = replies.length;
    await new Promise((resolve) => {
      replies.push(resolve);
      if (replies.length === 2) secondStarted();
    });
    await route.fulfill({ contentType: 'application/json',
      body: JSON.stringify([{ translations: [{ text: index ? 'New translation.' : 'Old translation.' }] }]) });
  });
  await f.open();
  await f.page.waitForFunction(() => window.__kct.state.active === 1);
  await f.open();
  await f.open();
  await started;
  replies[0]();
  await f.page.waitForFunction(() => window.__kct.state.active === 1);
  assert.equal(await f.page.evaluate(() => window.__kct.state.inFlight.size), 1);
  assert.equal(await f.page.evaluate(() => window.__kct.state.cache.size), 0);
  replies[1]();
  await f.done();
  assert.equal(await f.page.locator('.kct-translated').textContent(), 'New translation.');
  assert.equal(await f.page.evaluate(() => window.__kct.state.inFlight.size), 0);
  assert.deepEqual(f.errors, []);
});

test('removed blocks release pending animation frames and streaming debounce timers', async (t) => {
  const f = await fixture(t, { streaming: true, texts: ['Completed.\n\nTail'] });
  const frames = await f.page.evaluate(async () => {
    const pending = new Map();
    let next = 1;
    window.requestAnimationFrame = (callback) => { pending.set(next, callback); return next++; };
    window.cancelAnimationFrame = (id) => pending.delete(id);
    document.querySelector('.think-head').click();
    await Promise.resolve();
    const scheduled = pending.size;
    document.querySelector('.think').remove();
    await Promise.resolve();
    return { scheduled, retained: pending.size };
  });
  assert.deepEqual(frames, { scheduled: 1, retained: 0 });

  const g = await fixture(t, { streaming: true, texts: ['Completed.\n\nTail'] });
  await g.page.evaluate(() => {
    window.debounceTimers = new Set();
    const start = window.setTimeout;
    const stop = window.clearTimeout;
    window.setTimeout = (callback, delay, ...args) => {
      const id = start(callback, delay, ...args);
      if (delay === 700) window.debounceTimers.add(id);
      return id;
    };
    window.clearTimeout = (id) => { window.debounceTimers.delete(id); stop(id); };
  });
  await g.open();
  await g.page.waitForFunction(() => window.debounceTimers.size === 1);
  await g.page.evaluate(() => document.querySelector('.think').remove());
  await g.page.waitForFunction(() => window.debounceTimers.size === 0);
  assert.equal(g.requests.length, 0);
  assert.deepEqual(g.errors, []);
});
