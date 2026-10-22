import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { parseArgs, permissionResponse, run, settingsPath, TerminalRenderer } from './cli.mjs';

const engine = createRequire(import.meta.url)('./kct.js');
const thought = (text) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
const answer = (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const sink = () => {
  let text = '';
  return { write: (chunk) => { text += chunk; }, text: () => text };
};

async function config(t) {
  const dir = await mkdtemp(join(tmpdir(), 'kct-cli-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'cli.json');
}

async function waitFor(predicate, deadline, message) {
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function startPermissions(t, count) {
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  t.after(() => { input.destroy(); output.destroy(); });
  const answers = [];
  const titles = ['First', 'Second', 'Third'];
  class PermissionClient {
    constructor(options) {
      this.options = options;
      this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    }
    async start() {}
    async request(method) {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return { sessionId: 'permission-fixture' };
      const asked = titles.slice(0, count).map((title, index) => this.options.onPermission({
        toolCall: { title },
        options: [{ optionId: `option-${index + 1}`, name: `${title} option` }],
      }));
      answers.push(...await Promise.all(asked));
      return { stopReason: 'end_turn' };
    }
    notify() {}
    close() { this.resolveClosed({ code: 0, signal: null }); return this.closed; }
  }
  const running = run(parseArgs(['--target', 'zh', '-p', 'A synthetic prompt.']), {
    input, output, error: sink(), Client: PermissionClient, configFile: await config(t),
  });
  return { input, text: () => text, answers, running };
}

function mockBing(t, transform = (text) => `译:${text}`) {
  const requests = [];
  const original = globalThis.fetch;
  engine.state.cache.clear();
  globalThis.fetch = async (url, options) => {
    const texts = JSON.parse(options.body);
    requests.push({ url: String(url), texts, options });
    return Response.json(texts.map((text) => ({ translations: [{ text: transform(text) }] })));
  };
  t.after(() => { globalThis.fetch = original; engine.cancelRequests(); });
  return requests;
}

test('CLI arguments reject invalid languages and empty prompts without starting Kimi', () => {
  assert.equal(parseArgs(['--target', 'ja', '-p', 'Hello']).target, 'ja');
  assert.equal(parseArgs(['--kimi', 'C:\\Kimi Code\\kimi.exe']).command, 'C:\\Kimi Code\\kimi.exe');
  for (const args of [['--target', 'xx'], ['--provider', 'custom'], ['--target'], ['-p', ' '], ['--auto']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(settingsPath({}, 'linux', '/fixture').replaceAll('\\', '/'), '/fixture/.config/kimi-cot-translate/cli.json');
  assert.equal(settingsPath({ XDG_CONFIG_HOME: '/other' }, 'darwin', '/fixture').replaceAll('\\', '/'),
    '/other/kimi-cot-translate/cli.json');
  assert.equal(settingsPath({ LOCALAPPDATA: '/local' }, 'win32', '/fixture').replaceAll('\\', '/'),
    '/local/kimi-cot-translate/cli.json');
});

test('the desktop translation engine loads without a DOM and skips target-language text in Node', async (t) => {
  const requests = mockBing(t);
  const original = '先检查原文，确认结果。';
  assert.equal(await engine.translateText(original, 'zh'), original);
  assert.equal(requests.length, 0);
  assert.equal(await engine.translateText('An English paragraph.', 'zh'), '译:An English paragraph.');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.headers.authorization, undefined);
});

test('terminal output translates only thoughts and preserves answer order, tool titles and original inputs', async (t) => {
  const requests = mockBing(t);
  const output = sink();
  const renderer = new TerminalRenderer({ target: 'zh', write: output.write });
  renderer.push(thought('Inspect the '));
  renderer.push(thought('input.\n\n先保留中文。'));
  renderer.push({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read fixture.txt' });
  renderer.push(answer('The answer is '));
  renderer.push(answer('42.\n'));
  await renderer.finish();
  assert.deepEqual(requests.flatMap((request) => request.texts), ['Inspect the input.']);
  assert.match(output.text(), /译:Inspect the input\.\n\n先保留中文。/);
  assert.match(output.text(), /\[工具\] Read fixture\.txt/);
  assert.match(output.text(), /\[回答\]\nThe answer is 42\./);
  assert(output.text().indexOf('译:Inspect') < output.text().indexOf('[回答]'));
  assert.equal(renderer.pending, 0);
});

test('translation failure retains original thought and terminal escape sequences cannot execute', async () => {
  const output = sink();
  const warning = sink();
  const renderer = new TerminalRenderer({
    target: 'zh', write: output.write, warn: warning.write,
    translate: async () => { throw new Error('offline'); },
  });
  renderer.push(thought('\x1b]52;c;clipboard\x07Keep the original.\n\n'));
  renderer.push(answer('\x1b[2JVisible answer.'));
  await renderer.finish();
  assert.match(warning.text(), /翻译失败/);
  assert.match(output.text(), /Keep the original/);
  assert.match(output.text(), /Visible answer/);
  assert.doesNotMatch(output.text(), /\x1b|clipboard/);
});

test('cancellation drops late translation and releases its pending display memory', async () => {
  let release;
  const output = sink();
  const renderer = new TerminalRenderer({
    target: 'zh', write: output.write,
    translate: () => new Promise((resolve) => { release = resolve; }),
  });
  renderer.push(thought('A pending paragraph.\n\n'));
  await Promise.resolve();
  renderer.cancel();
  release('迟到译文');
  await renderer.finish();
  assert.equal(output.text(), '');
  assert.equal(renderer.pending, 0);
});

test('cancelling one renderer leaves a shared translation alive for the other renderer', { timeout: 3000 }, async (t) => {
  const signals = [];
  let release;
  const output = sink();
  const original = globalThis.fetch;
  engine.state.cache.clear();
  globalThis.fetch = async (url, options) => {
    signals.push(options.signal);
    const texts = JSON.parse(options.body);
    const response = new Promise((resolve) => {
      release = () => resolve(Response.json(texts.map((text) => ({ translations: [{ text: `译:${text}` }] }))));
    });
    return response;
  };
  t.after(() => {
    globalThis.fetch = original;
    engine.cancelRequests();
    engine.state.cache.clear();
  });
  const first = new TerminalRenderer({ target: 'zh', write: () => {} });
  const second = new TerminalRenderer({ target: 'zh', write: output.write });
  first.push(thought('Shared live paragraph.\n\n'));
  await Promise.resolve();
  second.push(thought('Shared live paragraph.\n\n'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.length, 1);
  first.cancel();
  assert.equal(signals[0].aborted, false);
  release();
  await second.finish();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  assert.match(output.text(), /译:Shared live paragraph\./);
  second.cancel();
});

test('long output has a fixed pending budget instead of an unbounded promise queue', async () => {
  const renderer = new TerminalRenderer({ target: 'zh', write: () => {} });
  assert.throws(() => renderer.push(thought('A'.repeat(128 * 1024 + 1))), /128 Ki/);
  renderer.cancel();
  assert.equal(renderer.buffer, '');
  await renderer.finish();
});

test('small answer deltas coalesce while translation is pending instead of creating a promise per token', async () => {
  let release;
  const output = sink();
  const renderer = new TerminalRenderer({
    target: 'zh', write: output.write,
    translate: () => new Promise((resolve) => { release = resolve; }),
  });
  renderer.push(thought('Pending thought.\n\n'));
  await Promise.resolve();
  for (let i = 0; i < 1000; i++) renderer.push(answer('a'));
  assert.equal(renderer.jobs, 2);
  release('合成译文');
  await renderer.finish();
  assert.equal(renderer.pending, 0);
  assert.equal(renderer.jobs, 0);
  assert(output.text().endsWith('a'.repeat(1000)));
});

test('permissions require an explicit advertised option and are denied without an interactive terminal', async () => {
  const params = { toolCall: { title: 'Write file', rawInput: { path: 'fixture.txt' } },
    options: [{ optionId: 'once', name: 'Approve once', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' }] };
  const cancelled = { outcome: { outcome: 'cancelled' } };
  assert.deepEqual(await permissionResponse(params), cancelled);
  assert.deepEqual(await permissionResponse(params, async () => ''), cancelled);
  assert.deepEqual(await permissionResponse(params, async () => '99'), cancelled);
  assert.deepEqual(await permissionResponse(params, async () => { throw new Error('input closed'); }), cancelled);
  assert.deepEqual(await permissionResponse(params, async () => '1'),
    { outcome: { outcome: 'selected', optionId: 'once' } });
  assert.deepEqual(await permissionResponse(params, async () => '2'),
    { outcome: { outcome: 'selected', optionId: 'no' } });
});

test('concurrent permissions are serialized and cancellation also ends a queued permission', { timeout: 3000 }, async (t) => {
  const { input, text, answers, running } = await startPermissions(t, 3);
  const deadline = Date.now() + 1000;
  await waitFor(() => text().includes('First'), deadline, 'First permission prompt was not shown');
  assert.doesNotMatch(text(), /Second|Third/);
  input.write('1\n');
  await waitFor(() => text().includes('Second'), deadline, 'Second permission prompt was not shown');
  assert.doesNotMatch(text(), /Third/);
  input.write('\x03');
  assert.equal(await running, 130);
  assert.doesNotMatch(text(), /Third/);
  assert.deepEqual(answers, [
    { outcome: { outcome: 'selected', optionId: 'option-1' } },
    { outcome: { outcome: 'cancelled' } },
    { outcome: { outcome: 'cancelled' } },
  ]);
});

test('two concurrent permissions both accept their own real readline answer', { timeout: 3000 }, async (t) => {
  const { input, text, answers, running } = await startPermissions(t, 2);
  const deadline = Date.now() + 1000;
  await waitFor(() => text().includes('First'), deadline, 'First permission prompt was not shown');
  assert.doesNotMatch(text(), /Second/);
  input.write('1\n');
  await waitFor(() => text().includes('Second'), deadline, 'Second permission prompt was not shown');
  input.write('1\n');
  assert.equal(await running, 0);
  assert.deepEqual(answers, [
    { outcome: { outcome: 'selected', optionId: 'option-1' } },
    { outcome: { outcome: 'selected', optionId: 'option-2' } },
  ]);
});

test('missing first-use language rejects before creating a backend or sending text', async (t) => {
  let starts = 0;
  class NeverStart { constructor() { starts++; } }
  await assert.rejects(run(parseArgs(['-p', 'Hello']), {
    input: { isTTY: false }, output: sink(), error: sink(),
    Client: NeverStart, configFile: await config(t),
  }), /First use requires --target/);
  assert.equal(starts, 0);
});

test('the ACP terminal preserves the backend prompt and saves only its own language preferences', async (t) => {
  const requests = mockBing(t);
  const output = sink();
  const errors = sink();
  const file = await config(t);
  const calls = [];
  let closed = false;
  class FakeClient {
    constructor(options) { this.options = options; }
    async start() {}
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return { sessionId: 'fixture-session' };
      if (method === 'session/prompt') {
        this.options.onUpdate({ sessionId: 'unrelated', update: thought('Never translate another session.') });
        this.options.onUpdate({ sessionId: 'fixture-session', update: thought('Think in English.\n\n') });
        assert.deepEqual(await this.options.onPermission({ options: [{ optionId: 'yes', name: 'Allow' }] }),
          { outcome: { outcome: 'cancelled' } });
        this.options.onUpdate({ sessionId: 'fixture-session', update: answer('Fixture final answer.') });
        return { stopReason: 'end_turn' };
      }
      throw new Error(method);
    }
    notify() {}
    async close() { closed = true; }
  }
  const prompt = 'Only answer the synthetic fixture.';
  assert.equal(await run(parseArgs(['--target', 'zh', '-p', prompt]), {
    input: { isTTY: false }, output, error: errors, configFile: file, Client: FakeClient, cwd: tmpdir(),
  }), 0);
  assert.deepEqual(calls.find((call) => call.method === 'session/prompt').params,
    { sessionId: 'fixture-session', prompt: [{ type: 'text', text: prompt }] });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { targetLanguage: 'zh', provider: 'bing' });
  assert.deepEqual(requests.flatMap((request) => request.texts), ['Think in English.']);
  assert.match(output.text(), /译:Think in English/);
  assert.match(output.text(), /Fixture final answer/);
  assert(closed);
});

test('interrupting an unresponsive prompt closes only the owned client and returns an interrupted status', { timeout: 6000 }, async (t) => {
  let closes = 0;
  const notifications = [];
  class UnresponsiveClient {
    constructor() {
      this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    }
    async start() {}
    request(method) {
      if (method === 'initialize') return Promise.resolve({ protocolVersion: 1 });
      if (method === 'session/new') return Promise.resolve({ sessionId: 'owned-fixture' });
      return new Promise((resolve, reject) => {
        this.rejectPrompt = reject;
        queueMicrotask(() => process.emit('SIGINT'));
      });
    }
    notify(method, params) { notifications.push({ method, params }); }
    close() {
      closes++;
      this.rejectPrompt?.(new Error('owned client closed'));
      this.resolveClosed({ code: 0, signal: null });
      return this.closed;
    }
  }
  const result = await run(parseArgs(['--target', 'zh', '-p', 'A synthetic prompt.']), {
    input: { isTTY: false }, output: sink(), error: sink(),
    Client: UnresponsiveClient, configFile: await config(t),
  });
  assert.equal(result, 130);
  assert.deepEqual(notifications, [{ method: 'session/cancel', params: { sessionId: 'owned-fixture' } }]);
  assert(closes >= 1);
});

test('Ctrl+C while waiting for terminal input aborts readline and closes the owned backend', { timeout: 3000 }, async (t) => {
  const input = new PassThrough();
  input.isTTY = true;
  let prompted = false;
  let closed = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!prompted && chunk.toString().includes('你：')) {
        prompted = true;
        queueMicrotask(() => input.write('\x03'));
      }
      done();
    },
  });
  output.isTTY = true;
  output.columns = 80;
  t.after(() => { input.destroy(); output.destroy(); });
  class IdleClient {
    constructor() { this.closed = new Promise((resolve) => { this.done = resolve; }); }
    async start() {}
    async request(method) {
      return method === 'initialize' ? { protocolVersion: 1 } : { sessionId: 'idle-fixture' };
    }
    notify() {}
    close() { closed = true; this.done({ code: 0, signal: null }); return this.closed; }
  }
  const result = await run(parseArgs(['--target', 'zh']), {
    input, output, error: sink(), Client: IdleClient, configFile: await config(t),
  });
  assert(prompted);
  assert.equal(result, 130);
  assert(closed);
});
