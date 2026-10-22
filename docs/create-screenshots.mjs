// Node 24: node docs/create-screenshots.mjs
// The fixture supplies the shell; all translation controls come from the current kct.js.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Use Node 24 to generate these screenshots.');
const script = await readFile(new URL('../kct.js', import.meta.url), 'utf8');
const fixture = await readFile(new URL('./demo.html', import.meta.url), 'utf8');
const output = new URL('./screenshots/', import.meta.url);
const origin = 'http://kct.demo/';
const translations = new Map([
  [
    "I'll check the installation steps and the existing test commands first.",
    '我会先检查安装步骤和现有的测试命令。',
  ],
  [
    'The usage section should explain how to choose a language and view the original text.',
    '使用说明需要介绍如何选择目标语言，以及如何查看原文。',
  ],
  [
    "I'll keep the checklist short so readers can follow it without extra context.",
    '我会让清单保持简洁，读者无需额外背景也能照着操作。',
  ],
]);
const retained = '先保留原文和段落结构，已有的中文不需要重复翻译。';
const requests = [];
const blocked = [];
const errors = [];
// Even browser background traffic cannot reach an external host through this closed local proxy.
const browser = await chromium.launch({
  proxy: { server: 'http://127.0.0.1:9' },
  args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings'],
});

try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (request.url() === origin && request.method() === 'GET') {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
      return;
    }
    const url = new URL(request.url());
    if (url.origin === 'https://edge.microsoft.com' && url.pathname === '/translate/translatetext') {
      const texts = request.postDataJSON();
      requests.push({ url: request.url(), method: request.method(), texts, mocked: true });
      const known = request.method() === 'POST' && url.searchParams.get('to') === 'zh-Hans' &&
        Array.isArray(texts) && texts.every((text) => translations.has(text.trim()));
      if (known) {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(texts.map((text) => ({
            translations: [{ text: translations.get(text.trim()) }],
          }))),
        });
        return;
      }
    }
    blocked.push({ url: request.url(), method: request.method() });
    await route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(origin);
  await page.addScriptTag({ content: script });
  await page.locator('.think[data-kct-mounted]').waitFor();
  await page.locator('.think-head').click();
  const dialog = page.getByRole('dialog', { name: '思维链翻译设置', exact: true });
  try {
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '开始使用', exact: true }).waitFor();
  } catch (cause) {
    throw new Error('The current kct.js must implement first-use language selection. Rerun after that implementation is ready.', { cause });
  }
  const language = dialog.getByLabel('目标语言', { exact: true });
  assert.deepEqual(await language.locator('option').evaluateAll((options) => options.map((option) => option.value)),
    ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru']);
  await language.selectOption('zh');
  assert.equal(requests.length, 0, 'No translation request before first-use confirmation.');
  const source = await page.locator('#demo-source').textContent();
  assert(await page.locator('#demo-source').isVisible(), 'The original must remain visible during setup.');
  assert(await page.getByText('演示内容 · 非真实会话', { exact: true }).isVisible());
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(10, 10);
  const choice = await page.screenshot({ animations: 'disabled' });

  await dialog.getByRole('button', { name: '开始使用', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => {
    const status = document.querySelector('.kct-status');
    return status?.dataset.state === 'ok' && status.textContent === '';
  });
  const expected = source.split('\n\n').map((paragraph) => translations.get(paragraph) ?? paragraph).join('\n\n');
  assert.equal(await page.locator('.kct-translated').textContent(), expected);
  assert(expected.includes(retained), 'The Chinese paragraph must be retained.');
  assert.deepEqual(requests.flatMap((request) => request.texts).map((text) => text.trim()),
    [...translations.keys()], 'Only the English paragraphs may enter the Bing mock.');
  assert.equal(await page.locator('#demo-source').textContent(), source);
  assert.equal(await page.locator('#demo-source').isVisible(), false);
  await page.getByRole('button', { name: '查看原文', exact: true }).click();
  assert(await page.locator('#demo-source').isVisible());
  await page.getByRole('button', { name: '查看译文', exact: true }).click();
  assert(await page.locator('.kct-translated').isVisible());
  await page.mouse.move(10, 10);
  const translated = await page.screenshot({ animations: 'disabled' });

  assert.deepEqual(blocked, [], 'Unexpected network requests were blocked.');
  assert.deepEqual(errors, [], 'The demo must run without browser errors.');
  await mkdir(output, { recursive: true });
  await writeFile(new URL('language-choice.png', output), choice);
  await writeFile(new URL('embedded-translation.png', output), translated);
  console.log(JSON.stringify({
    files: ['language-choice.png', 'embedded-translation.png'].map((name) => fileURLToPath(new URL(name, output))),
    viewport: { width: 1200, height: 900 },
    kctSHA256: createHash('sha256').update(script).digest('hex'),
    network: {
      externalRequestsForwarded: 0,
      fixtureResponses: 1,
      mockedBingRequests: requests,
      blockedRequests: blocked,
      policy: 'All page requests fulfilled locally or aborted; browser uses a closed loopback proxy.',
    },
    checks: 'First-use dialog, no request before confirmation, English-only mock, retained Chinese, original toggle, clean console.',
  }, null, 2));
} finally {
  await browser.close();
}
