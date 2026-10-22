import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { AcpClient } from './cli-acp.mjs';

const AGENT = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const update = (text) => send({ jsonrpc: '2.0', method: 'session/update', params: {
  sessionId: 's', update: { sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text } },
} });
const permissions = [];
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    if (message.id === 'unknown-1') update('unknown:' + message.error.code);
    if (message.id?.startsWith('permission-')) {
      permissions.push(message.id);
      update('permission:' + permissions.join(',') + ':'
        + (message.result?.outcome?.outcome ?? 'missing'));
    }
    return;
  }
  if (message.method === 'session/prompt') {
    update(message.params.prompt);
    send({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {
      sessionId: 's', toolCall: {}, options: [],
    } });
    send({ jsonrpc: '2.0', id: 'permission-2', method: 'session/request_permission', params: {
      sessionId: 's', toolCall: {}, options: [],
    } });
    send({ jsonrpc: '2.0', id: 'unknown-1', method: 'terminal/create', params: {} });
    send({ jsonrpc: '2.0', id: message.id, result: { echoed: message.params.prompt } });
  } else if (message.method === 'slow') {
    setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result: 'late' }), 1000);
  } else if (message.method === 'bad') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'bad request', data: 7 } });
  } else if (message.method === 'malformed') {
    process.stdout.write('{"jsonrpc":"2.0","result":{"secret":"do-not-leak"' + '\n');
  } else if (message.method === 'oversize') {
    process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));
  } else if (message.method === 'quit') {
    process.exit(3);
  }
});
rl.on('close', () => process.exit(0));
`;

const transport = (options = {}) => new AcpClient({
  command: process.execPath,
  args: ['-e', AGENT],
  stderr: null,
  ...options,
});

test('matches request IDs, isolates updates, and keeps permissions concurrent', async (t) => {
  const updates = [];
  let permissionCalls = 0;
  const waitFor = async (predicate) => {
    for (let i = 0; i < 50; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('timed out waiting for updates');
  };
  const client = transport({
    onUpdate: ({ update }) => {
      updates.push(update.content.text);
    },
    onPermission: async () => {
      const index = permissionCalls++;
      if (index === 0) await new Promise((resolve) => setTimeout(resolve, 80));
      return { outcome: { outcome: 'selected', optionId: `option-${index}` } };
    },
  });
  t.after(() => client.close().catch(() => {}));
  client.start();

  const result = await client.request('session/prompt', { prompt: 'hello' });
  assert.deepEqual(result, { echoed: 'hello' });
  assert.equal(updates[0], 'hello', 'session/update must not be awaited');
  await waitFor(() => updates.includes('permission:permission-2,permission-1:selected'));
  assert.ok(updates.includes('unknown:-32601'));
  assert.ok(updates.indexOf('permission:permission-2:selected')
    < updates.indexOf('permission:permission-2,permission-1:selected'));
});

test('default permission response is cancelled', async (t) => {
  let update;
  const seen = new Promise((resolve) => { update = resolve; });
  const client = transport({
    onUpdate: ({ update: value }) => {
      if (value.content.text === 'permission:permission-1,permission-2:cancelled') {
        update(value.content.text);
      }
    },
  });
  t.after(() => client.close().catch(() => {}));
  client.start();
  void client.request('session/prompt', { prompt: 'permission' }).catch(() => {});
  assert.equal(await seen, 'permission:permission-1,permission-2:cancelled');
});

test('splits UTF-8 across chunks and preserves emoji', async (t) => {
  const script = String.raw`
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 's', update: { sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'a😀b' } },
    } }) + '\n';
    const bytes = Buffer.from(line);
    const split = bytes.indexOf(Buffer.from('😀')) + 2;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
  `;
  let text;
  const seen = new Promise((resolve) => { text = resolve; });
  const client = new AcpClient({
    command: process.execPath,
    args: ['-e', script],
    stderr: null,
    onUpdate: ({ update }) => text(update.content.text),
  });
  t.after(() => client.close().catch(() => {}));
  client.start();
  assert.equal(await seen, 'a😀b');
});

test('rejects malformed JSON and oversize lines without echoing them', async (t) => {
  for (const method of ['malformed', 'oversize']) {
    const client = transport();
    t.after(() => client.close().catch(() => {}));
    client.start();
    const error = await client.request(method, {}).catch((value) => value);
    assert.match(error.message, /ACP/);
    assert.doesNotMatch(error.message, /do-not-leak/);
    await assert.rejects(client.closed);
  }
});

test('rejects incomplete JSON at EOF without echoing it', async (t) => {
  const script = String.raw`
    process.stdout.write('{"jsonrpc":"2.0","result":{"secret":"do-not-leak"');
    process.stdout.end();
  `;
  const client = new AcpClient({
    command: process.execPath, args: ['-e', script], stderr: null,
  });
  t.after(() => client.close().catch(() => {}));
  client.start();
  const error = await client.closed.catch((value) => value);
  assert.match(error.message, /ACP/);
  assert.doesNotMatch(error.message, /do-not-leak/);
});

test('timeoutMs: 0 waits, request errors retain JSON-RPC fields', async (t) => {
  const client = transport();
  t.after(() => client.close().catch(() => {}));
  client.start();
  assert.equal((await client.request('slow', {}, { timeoutMs: 0 })).valueOf(), 'late');
  const error = await client.request('bad', {}).catch((value) => value);
  assert.equal(error.message, 'bad request');
  assert.equal(error.code, -32000);
  assert.equal(error.data, 7);
  await assert.rejects(client.request('slow', {}, { timeoutMs: 10 }), /timed out/);
});

test('exit rejects pending requests and resolves closed with code', async (t) => {
  const client = transport();
  t.after(() => client.close().catch(() => {}));
  client.start();
  const pending = client.request('quit', {}).catch((value) => value);
  assert.match((await pending).message, /exited/);
  assert.deepEqual(await client.closed, { code: 3, signal: null });
});

test('close is idempotent, completes after stdin.end, and rejects pending', async (t) => {
  const client = transport();
  t.after(() => client.close().catch(() => {}));
  client.start();
  const pending = client.request('slow', {}).catch((value) => value);
  const closed = client.closed;
  assert.equal(client.close(), closed);
  await assert.rejects(client.request('slow', {}), /closed/);
  assert.equal(client.close(), closed);
  assert.match((await pending).message, /closed/);
  assert.deepEqual(await closed, { code: 0, signal: null });
});

test('close lets the owned agent flush stdout and stderr after stdin EOF without EPIPE', async (t) => {
  const stderr = new PassThrough();
  let diagnostics = '';
  stderr.on('data', (chunk) => { diagnostics += chunk; });
  const script = String.raw`
    process.stdout.on('error', () => process.exit(42));
    process.stderr.on('error', () => process.exit(43));
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', line => {
      const message = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: 'ready' }) + '\n');
    });
    rl.on('close', () => {
      process.stdout.write('final output\n');
      process.stderr.write('diagnostic tail\n');
      setTimeout(() => process.exit(0), 50);
    });
  `;
  const client = new AcpClient({ command: process.execPath, args: ['-e', script], stderr });
  t.after(() => client.close().catch(() => {}));
  t.after(() => stderr.destroy());
  client.start();
  await client.request('ready', {});
  assert.deepEqual(await client.close(), { code: 0, signal: null });
  assert.match(diagnostics, /diagnostic tail/);
});
