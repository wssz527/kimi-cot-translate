// Opt in: KCT_KIMI_BIN=/path/to/kimi node --test cli-live.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import { AcpClient } from './cli-acp.mjs';
import { parseArgs, run } from './cli.mjs';

const executable = process.env.KCT_KIMI_BIN;
const engine = createRequire(import.meta.url)('./kct.js');
const source = 'First check the synthetic CLI input.\n\n先保留这段中文。';
const translated = 'KCT_TRANSLATED_FIXTURE_检查合成输入。';
const sink = (consume = () => {}) => new Writable({
  write(chunk, encoding, callback) { consume(chunk.toString()); callback(); },
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kct-cli-live-'));
  const cwd = join(root, 'workspace');
  const home = join(root, 'kimi-home');
  await mkdir(cwd);
  await mkdir(home);
  const requests = [];
  const clients = new Set();
  let chinese = false;
  let hold = false;
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'deepseek-r1' }] }));
      return;
    }
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let data = '';
    for await (const chunk of request) data += chunk;
    requests.push(JSON.parse(data));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({
      id: 'kct-fixture', object: 'chat.completion.chunk', created: 1, model: 'deepseek-r1',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
    chunk({ role: 'assistant', reasoning_content: chinese ? '先检查合成输入，再确认结果。' : source });
    if (hold) return;
    chunk({ content: 'SYNTHETIC_FINAL_42' });
    chunk({}, 'stop');
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await writeFile(join(home, 'config.toml'), `default_model = "kct-fixture"
telemetry = false
builtin_product_skills = false
[providers.fixture]
type = "openai"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "kct-local-fixture-not-a-secret"
[models.kct-fixture]
provider = "fixture"
model = "deepseek-r1"
max_context_size = 32768
capabilities = ["thinking"]
[thinking]
enabled = true
keep = "all"
`, { mode: 0o600 });
  await writeFile(join(home, 'mcp.json'), '{"mcpServers":{}}');
  const env = {
    PATH: process.env.PATH,
    KIMI_CODE_HOME: home,
    KIMI_DISABLE_TELEMETRY: '1',
    KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: '0',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const originalFetch = globalThis.fetch;
  const translatedRequests = [];
  engine.state.cache.clear();
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, 'edge.microsoft.com');
    const texts = JSON.parse(options.body);
    translatedRequests.push(...texts);
    return Response.json(texts.map(() => ({ translations: [{ text: translated }] })));
  };
  t.after(async () => {
    await Promise.all([...clients].map((client) => client.close()));
    globalThis.fetch = originalFetch;
    engine.cancelRequests();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, cwd, home, env, requests, clients, translatedRequests,
    chinese: () => { chinese = true; },
    hold: (value) => { hold = value; },
  };
}

async function journalText(root) {
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  const journals = files.filter((entry) => entry.isFile() && /\.(jsonl|json)$/.test(entry.name));
  return (await Promise.all(journals.map((entry) =>
    readFile(join(entry.parentPath, entry.name), 'utf8')))).join('\n');
}

test('real Kimi ACP: translated terminal output leaves official journal and prompt original', {
  skip: !executable, timeout: 60000,
}, async (t) => {
  const f = await fixture(t);
  let output = '';
  let diagnostics = '';
  const status = await run(parseArgs(['--target', 'zh', '--kimi', executable, '-p', 'Reply with the synthetic fixture only.']), {
    cwd: f.cwd, env: f.env, input: { isTTY: false },
    output: { write: (text) => { output += text; } },
    error: sink((text) => { diagnostics += text; }),
    configFile: join(f.root, 'cli.json'),
  });
  assert.equal(status, 0, diagnostics);
  assert.match(output, /KCT_TRANSLATED_FIXTURE/);
  assert.match(output, /先保留这段中文/);
  assert.match(output, /SYNTHETIC_FINAL_42/);
  assert.deepEqual(f.translatedRequests, ['First check the synthetic CLI input.']);
  assert.equal(f.requests.length, 1);
  const journal = await journalText(f.home);
  assert(journal.includes('First check the synthetic CLI input.'), 'official journal must retain original thought');
  assert(journal.includes('SYNTHETIC_FINAL_42'));
  assert(!journal.includes(translated), 'translated display must never enter the official journal');
});

test('real Kimi ACP: Chinese target text requires no translation request', {
  skip: !executable, timeout: 60000,
}, async (t) => {
  const f = await fixture(t);
  f.chinese();
  let output = '';
  await run(parseArgs(['--target', 'zh', '--kimi', executable, '-p', 'Reply with the synthetic fixture only.']), {
    cwd: f.cwd, env: f.env, input: { isTTY: false },
    output: { write: (text) => { output += text; } }, error: sink(),
    configFile: join(f.root, 'cli.json'),
  });
  assert.match(output, /先检查合成输入，再确认结果/);
  assert.match(output, /SYNTHETIC_FINAL_42/);
  assert.equal(f.translatedRequests.length, 0);
});

test('real Kimi ACP: cancellation settles and the same backend accepts another prompt', {
  skip: !executable, timeout: 60000,
}, async (t) => {
  const f = await fixture(t);
  f.hold(true);
  let sessionId;
  let cancelSent = false;
  const client = new AcpClient({
    command: executable, args: ['acp'], cwd: f.cwd, env: f.env, stderr: sink(),
    onUpdate: (params) => {
      if (!cancelSent && params.sessionId === sessionId && params.update.sessionUpdate === 'agent_thought_chunk') {
        cancelSent = true;
        client.notify('session/cancel', { sessionId });
      }
    },
  });
  f.clients.add(client);
  await client.start();
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'kct-smoke', version: '0.1.0' } });
  sessionId = (await client.request('session/new', { cwd: f.cwd, mcpServers: [] })).sessionId;
  const stopped = await client.request('session/prompt', {
    sessionId, prompt: [{ type: 'text', text: 'First cancellation fixture.' }],
  });
  assert(cancelSent);
  assert.equal(stopped.stopReason, 'cancelled');
  f.hold(false);
  const recovered = await client.request('session/prompt', {
    sessionId, prompt: [{ type: 'text', text: 'Second recovery fixture.' }],
  });
  assert.equal(recovered.stopReason, 'end_turn');
  assert.equal(f.requests.length, 2);
});
