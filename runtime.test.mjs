import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { assertIdentity, assertRendererContract, attachInspector, deploy, inspectorDeadlineExpression,
  inspectFuses, launchOutcome, pageHealth, parseProcess, permanentError, portOpen, rendererBootstrap,
  readBundle, saveState, stageBundle, tick, verifyApp } from './runtime.mjs';

const startedUTC = (text) => {
  const [, month, day, time, year] = /\w{3} (\w{3}) (\d+) (\d{2}:\d{2}:\d{2}) (\d{4})/.exec(text);
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const [h, m, sec] = time.split(':').map(Number);
  return Date.UTC(Number(year), months[month], Number(day), h, m, sec);
};
const INFO = parseProcess(
  `85123 ${process.getuid()} Wed Oct 21 13:58:18 2026 /Applications/Kimi Code.app/Contents/MacOS/Kimi Code`,
  startedUTC,
);
const CORE_FILES = ['runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs', 'runtime-launcher.mjs',
  'supported-runtimes.json', 'kct.js'];

function tickFixture() {
  let previous = {}, found = [INFO], installed = 0, verified = 0, saves = 0;
  let time = Date.UTC(2026, 9, 21, 13, 58, 30);
  const deps = {
    saveState: async (state) => { previous = structuredClone(state); saves++; },
    readState: async () => structuredClone(previous),
    findProcesses: async () => found,
    readFile: async () => 'source',
    fingerprint: async () => 'executable-fingerprint',
    portOpen: async () => false,
    output: async () => '',
    verifyApp: async () => { verified++; return { version: '1.1.1', electron: '43.1.1' }; },
    installIntoProcess: async () => { installed++; return { loaded: 1 }; },
    now: () => time,
  };
  return { deps, state: () => previous, installed: () => installed, verified: () => verified,
    saves: () => saves, advance: (ms) => { time += ms; }, setFound: (value) => { found = value; } };
}

test('only an unchanged main process owned by this user is eligible for a signal', () => {
  const info = parseProcess(`85123 ${process.getuid()} Wed Oct 21 13:58:18 2026 /Applications/Kimi Code.app/Contents/MacOS/Kimi Code`, startedUTC);
  assert.equal(info.pid, 85123);
  assert.equal(info.started, 'Wed Oct 21 13:58:18 2026');
  assertIdentity(info);
  for (const changed of [
    { ...info, pid: info.pid + 1 }, { ...info, started: 'Wed Oct 21 13:58:19 2026' },
    { ...info, uid: info.uid + 1 },
    { ...info, executable: '/Applications/Kimi Code.app/Contents/MacOS/Kimi Code Helper' },
  ]) assert.throws(() => assertIdentity(changed, info));
  assert.throws(() => parseProcess('PID not found'));
});

test('missing, unknown or disabled inspect fuses fail closed', () => {
  const fuse = (version, flags) => Buffer.concat([
    Buffer.from('prefixdL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
    Buffer.from([version, flags.length]), Buffer.from(flags),
  ]);
  assert.doesNotThrow(() => inspectFuses(fuse(1, '101100001')));
  for (const binary of [Buffer.from('unrelated'), fuse(2, '101100001'),
    fuse(1, '101000001'), fuse(1, '101')]) {
    assert.throws(() => inspectFuses(binary));
  }
});

test('renderer bootstrap is scoped and idempotent without replacing stored settings', () => {
  const settings = new Map([['kct:settings:v1', '{"autoTranslate":false}']]);
  const window = {};
  const context = vm.createContext({ window, localStorage: settings, console });
  const code = rendererBootstrap('window.__kct = {boots: (window.boots = (window.boots || 0)+1)};', 'test-revision');
  vm.runInContext(code, context);
  vm.runInContext(code, context);
  assert.equal(window.boots, 1);
  assert.equal(window.__kctRuntimeRevision, 'test-revision');
  assert.equal(settings.get('kct:settings:v1'), '{"autoTranslate":false}');
});

test('launch outcomes separate success, waiting, retry and incompatibility', () => {
  assert.equal(launchOutcome({ status: 'active', loaded: 1, inspectorClosed: true,
    liveVerified: true }), 'success');
  assert.equal(launchOutcome({ status: 'active', loaded: 0, inspectorClosed: true,
    liveVerified: true }), 'failed');
  assert.equal(launchOutcome({ status: 'waiting' }), 'waiting');
  assert.equal(launchOutcome({ status: 'checking' }), 'transient');
  assert.equal(launchOutcome({ status: 'error', failureKind: 'transient' }), 'transient');
  assert.equal(launchOutcome({ status: 'error', failureKind: 'inspector-uncertain' }), 'failed');
  assert.equal(launchOutcome({ status: 'error', failureKind: 'permanent' }), 'incompatible');
  assert.equal(launchOutcome({ status: 'blocked-inspector', failureKind: 'transient' }), 'transient');
  assert.equal(launchOutcome(null, Object.assign(new Error('x'), { failureKind: 'permanent' })), 'incompatible');
  assert.equal(launchOutcome(null, new Error('x')), 'failed');
});

test('a historical active record can never confirm a candidate', () => {
  const historical = { status: 'active', loaded: 1, inspectorClosed: true,
    revision: 'same-revision', identity: 'same-identity', checkedAt: '2026-11-01T00:00:00.000Z' };
  assert.equal(launchOutcome(historical), 'transient',
    'without a live verification this run the outcome is not a success');
  assert.equal(launchOutcome({ ...historical, liveVerified: false }), 'transient');
  assert.equal(launchOutcome({ ...historical, liveVerified: true }), 'success');
});

test('renderer bootstrap never claims the new revision for an older mounted page', () => {
  const window = { __kct: { old: true }, __kctRuntimeRevision: 'old' };
  const context = vm.createContext({ window, localStorage: new Map(), console });
  vm.runInContext(rendererBootstrap('window.__kct = { replaced: true };', 'new'), context);
  assert.equal(window.__kct.old, true);
  assert.equal(window.__kct.replaced, undefined);
  assert.equal(window.__kctRuntimeRevision, 'old');
});

test('a changed reasoning UI is rejected even with a compatible Electron runtime', () => {
  const selectors = ['think', 'think-head', 'think-body', 'think-body-inner', 'think-text'];
  assert.doesNotThrow(() => assertRendererContract(selectors.map((name) => `.${name}[data-v-abcd]{}`).join('')));
  assert.throws(() => assertRendererContract(selectors.slice(1).map((name) => `.${name}{}`).join('')));
  assert.throws(() => assertRendererContract('.thought{}.think-head-renamed{}'));
});

test('the first inspector expression arms in-app cleanup before returning identity', () => {
  let cleanup;
  let closed = false;
  const context = vm.createContext({
    process: { pid: 42, type: 'browser', versions: { electron: '43.1.1' },
      mainModule: { require: () => ({ close: () => { closed = true; } }) } },
    clearTimeout: () => {},
    setTimeout: (callback, delay) => { assert.equal(delay, 12000); cleanup = callback; return 1; },
  });
  const identity = vm.runInContext(inspectorDeadlineExpression(42), context);
  assert.equal(identity.pid, 42);
  assert.equal(typeof cleanup, 'function');
  cleanup();
  assert.equal(closed, true);
  cleanup = undefined;
  assert.throws(() => vm.runInContext(inspectorDeadlineExpression(999), context));
  assert.equal(cleanup, undefined);
});

test('a settled attempt survives the multi-instance round trip without a second install', async () => {
  const { tick } = await import('./runtime.mjs');
  const saved = [];
  let installed = 0;
  let previous = {};
  const base = {
    saveState: async (state) => { previous = structuredClone(state); saved.push(previous); },
    readState: async () => structuredClone(previous),
    readFile: async () => 'renderer source',
    fingerprint: async () => 'executable-fingerprint',
    portOpen: async () => false,
    verifyApp: async () => ({ version: '1.1.1', electron: '43.1.1', executable: 'app-fingerprint' }),
    installIntoProcess: async () => { installed += 1; return { loaded: 1 }; },
    now: () => Date.UTC(2026, 9, 21, 13, 58, 30),
  };
  const second = { ...INFO, pid: INFO.pid + 1 };

  let state = await tick({ ...base, findProcesses: async () => [INFO], output: async () => '' });
  assert.equal(state.status, 'active');
  assert.equal(installed, 1);
  const settledRevision = state.revision;
  const firstIdentity = state.identity;

  state = await tick({ ...base, findProcesses: async () => [INFO, second], output: async () => '' });
  assert.equal(state.status, 'waiting');
  assert.equal(state.attempt.status, 'active');
  assert.equal(state.attempt.revision, settledRevision);
  assert.equal(state.attempt.identity, firstIdentity);

  state = await tick({ ...base, findProcesses: async () => [INFO], output: async () => '' });
  assert.equal(state.status, 'active');
  assert.equal(installed, 1, 'same PID and revision must not be installed twice');
  assert.equal(state.identity, firstIdentity);
  assert.equal(state.attempt, undefined);
  assert.deepEqual(previous, state, 'the saved and returned settled state must match');
});

test('a supported-runtime allowlist change retries the same process', async () => {
  const { tick } = await import('./runtime.mjs');
  let supported = '[{"electron":"43.1.1"}]';
  let installed = 0;
  let previous = {};
  const base = {
    saveState: async (state) => { previous = structuredClone(state); },
    readState: async () => structuredClone(previous),
    readFile: async (path) => String(path).endsWith('supported-runtimes.json') ? supported : 'source',
    fingerprint: async () => 'executable-fingerprint',
    portOpen: async () => false,
    verifyApp: async () => ({ version: '1.1.1', electron: '43.1.1', executable: 'app-fingerprint' }),
    installIntoProcess: async () => { installed += 1; return { loaded: 1 }; },
    now: () => Date.UTC(2026, 9, 21, 13, 58, 30),
  };
  await tick({ ...base, findProcesses: async () => [INFO], output: async () => '' });
  const firstRevision = previous.revision;
  supported = '[{"electron":"43.1.2"}]';
  const state = await tick({ ...base, findProcesses: async () => [INFO], output: async () => '' });
  assert.equal(installed, 2);
  assert.notEqual(state.revision, firstRevision);
});

test('transient verification errors retry only after their backoff expires', async () => {
  const f = tickFixture();
  let calls = 0;
  const verify = f.deps.verifyApp;
  f.deps.verifyApp = async () => {
    if (++calls === 1) throw Object.assign(new Error('codesign timed out'), { killed: true });
    return verify();
  };
  const failed = await tick(f.deps);
  assert.equal(failed.status, 'error');
  assert.equal(failed.failureKind, 'transient');
  assert.equal(failed.attempts, 1);
  assert.equal(Date.parse(failed.nextRetryAt) - Date.parse(failed.lastAttemptAt), 30000);
  const saves = f.saves();
  f.advance(29999);
  assert.deepEqual(await tick(f.deps), failed);
  assert.equal(calls, 1);
  assert.equal(f.saves(), saves);
  f.advance(1);
  const active = await tick(f.deps);
  assert.equal(active.status, 'active');
  assert.equal(active.attempts, 2);
  assert.equal(active.failureKind, null);
  assert.equal(active.nextRetryAt, null);
  assert.equal(f.installed(), 1);
});

test('unsigned and untrusted hosts fail closed before attachment', async () => {
  const binary = Buffer.concat([Buffer.from('prefixdL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
    Buffer.from([1, 9]), Buffer.from('101100001')]);
  let calls = 0;
  const verification = {
    fingerprint: async () => 'file',
    output: async () => '45.1.0',
    run: async (_command, args) => {
      calls++;
      assert.ok(args.includes('--verify'));
      assert.ok(args.includes('--deep'));
      assert.ok(args.some((arg) => arg.includes('anchor apple generic') && arg.includes('com.kimi.code.desktop')));
      return {};
    },
    readFile: async (file) => {
      if (String(file).endsWith('supported-runtimes.json')) return '[]';
      if (String(file).endsWith('Electron Framework')) return binary;
      return '';
    },
  };
  const identity = await verifyApp(verification);
  assert.equal(identity.signature.status, 'valid');
  assert.equal(identity.verified, 'capabilities');
  assert.equal(calls, 1);
  await assert.rejects(verifyApp({ ...verification, run: async () => { throw new Error('invalid'); } }),
    { failureKind: 'permanent' });
  await assert.rejects(verifyApp({ ...verification, run: async () => { throw Object.assign(new Error('timeout'), { killed: true }); } }),
    { message: 'timeout' });
  assert.throws(() => inspectFuses(Buffer.from('unknown layout')), { failureKind: 'permanent' });
});

test('a fresh official Desktop process after upgrade gets a new verified injection attempt', async () => {
  const fixture = tickFixture();
  const first = await tick(fixture.deps);
  assert.equal(first.status, 'active');
  const restarted = { ...INFO, pid: INFO.pid + 1, started: 'Wed Oct 21 14:08:18 2026',
    startedAt: INFO.startedAt - 10000 };
  fixture.setFound([restarted]);
  const second = await tick(fixture.deps);
  assert.equal(second.status, 'active');
  assert.equal(second.pid, restarted.pid);
  assert.equal(fixture.installed(), 2);
});

test('PID and process start changes each reset the retry budget', async () => {
  for (const changed of [{ ...INFO, pid: INFO.pid + 1 },
    { ...INFO, started: 'Wed Oct 21 13:58:19 2026' }]) {
    const f = tickFixture();
    f.deps.verifyApp = async () => { throw new Error('temporary IO failure'); };
    assert.equal((await tick(f.deps)).attempts, 1);
    f.setFound([changed]);
    const retried = await tick(f.deps);
    assert.equal(retried.attempts, 1);
    assert.equal(retried.pid, changed.pid);
    assert.equal(retried.started, changed.started);
  }
});

test('retry delays grow to thirty minutes and stop after eight attempts per process', async () => {
  const f = tickFixture();
  let calls = 0;
  f.deps.verifyApp = async () => { calls++; throw new Error('temporary IO failure'); };
  const delays = [30000, 120000, 600000, 1800000, 1800000, 1800000, 1800000];
  for (let attempt = 1; attempt <= 8; attempt++) {
    const failed = await tick(f.deps);
    assert.equal(failed.attempts, attempt);
    if (attempt === 8) {
      assert.equal(failed.nextRetryAt, null);
      assert.match(failed.detail, /retry limit reached; waiting for Kimi to restart/);
    } else {
      assert.equal(Date.parse(failed.nextRetryAt) - Date.parse(failed.lastAttemptAt), delays[attempt - 1]);
      f.advance(delays[attempt - 1]);
    }
  }
  f.advance(86400000);
  await tick(f.deps);
  assert.equal(calls, 8);
  f.deps.readFile = async () => 'new source revision';
  await tick(f.deps);
  assert.equal(calls, 8, 'source revisions must not reset the same process budget');
});

test('blocked inspectors are probed every tick and retry after release and backoff', async () => {
  const f = tickFixture();
  let calls = 0, probes = 0, open = false;
  f.deps.portOpen = async () => { probes++; return open; };
  f.deps.installIntoProcess = async () => {
    if (++calls === 1) throw Object.assign(new Error('Inspector command timeout'),
      { failureKind: 'inspector-uncertain' });
    return { loaded: 1 };
  };
  const failed = await tick(f.deps);
  assert.equal(failed.status, 'blocked-inspector');
  open = true;
  f.advance(10000);
  const before = probes;
  await tick(f.deps);
  assert.equal(probes, before + 1);
  f.advance(20000);
  f.deps.readFile = async () => 'new revision while inspector is occupied';
  await tick(f.deps);
  assert.equal(calls, 1);
  open = false;
  const active = await tick(f.deps);
  assert.equal(active.status, 'active');
  assert.equal(active.attempts, 2);
  assert.equal(calls, 2);
});

test('busy ports and preflight IO failures observe the same backoff before any signal', async () => {
  for (const failure of ['port', 'read']) {
    const f = tickFixture();
    const read = f.deps.readFile;
    f.deps.portOpen = async () => failure === 'port';
    if (failure === 'read') f.deps.readFile = async () => { throw new Error('temporary IO failure'); };
    assert.equal((await tick(f.deps)).failureKind, 'transient');
    f.deps.readFile = read;
    f.deps.portOpen = async () => false;
    await tick(f.deps);
    assert.equal(f.installed(), 0);
    f.advance(30000);
    assert.equal((await tick(f.deps)).status, 'active');
    assert.equal(f.installed(), 1);
  }
});

test('an interrupted checking attempt waits for port release before recovery', async () => {
  const f = tickFixture();
  await tick(f.deps);
  const interrupted = { ...f.state(), status: 'checking' };
  const read = f.deps.readState;
  f.deps.readState = async () => interrupted;
  f.deps.portOpen = async () => true;
  const blocked = await tick(f.deps);
  assert.equal(blocked.status, 'blocked-inspector');
  assert.equal(blocked.failureKind, 'inspector-uncertain');
  assert.equal(f.installed(), 1);
  f.deps.readState = read;
  f.deps.portOpen = async () => false;
  f.advance(29999);
  assert.deepEqual(await tick(f.deps), blocked);
  f.advance(1);
  assert.equal((await tick(f.deps)).status, 'active');
  assert.equal(f.installed(), 2);
});

test('legacy errors with an unknown trigger stage migrate to guarded recovery', async () => {
  const f = tickFixture();
  f.deps.readState = async () => ({
    identity: `${INFO.pid}:${INFO.started}:executable-fingerprint`, revision: 'old-loader',
    pid: INFO.pid, status: 'error', detail: 'old failure',
    checkedAt: new Date(f.deps.now()).toISOString(),
  });
  const blocked = await tick(f.deps);
  assert.equal(blocked.status, 'blocked-inspector');
  assert.equal(blocked.attempts, 1);
  assert.equal(blocked.lastAttemptAt, '2026-10-21T13:58:30.000Z');
  assert.equal(blocked.nextRetryAt, '2026-10-21T13:59:00.000Z');
  assert.equal(f.installed(), 0);
});

test('inspector failures distinguish errors before and after a successful trigger', async () => {
  let signals = 0;
  const operations = {
    verifyLiveProcess: async () => {},
    portOpen: async () => false,
    triggerInspector: async () => { signals++; },
    checkIdentity: async () => { throw new Error('process check failed'); },
  };
  await assert.rejects(attachInspector(INFO, {}, { ...operations, triggerInspector: async () => {
    throw Object.assign(new Error('process already exited'), { code: 'ESRCH' });
  } }), (error) => error.failureKind === undefined);
  assert.equal(signals, 0);
  await assert.rejects(attachInspector(INFO, {}, operations), { failureKind: 'inspector-uncertain' });
  assert.equal(signals, 1);
});

test('only a refused local connection confirms that the inspector port is free', async () => {
  for (const code of ['ECONNREFUSED', 'EACCES', 'ENETUNREACH']) {
    const open = await portOpen(() => {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      socket.setTimeout = () => {};
      queueMicrotask(() => socket.emit('error', { code }));
      return socket;
    });
    assert.equal(open, code !== 'ECONNREFUSED');
  }
});

test('unchanged active, waiting and failed states keep checkedAt and do not rewrite the state file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kct-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const status of ['active', 'waiting', 'error']) {
    const f = tickFixture();
    const file = join(dir, `${status}.json`);
    if (status === 'waiting') f.setFound([]);
    if (status === 'error') f.deps.verifyApp = async () => { throw new Error('temporary failure'); };
    const save = f.deps.saveState;
    f.deps.saveState = async (state) => { await save(state); await saveState(state, file); };
    const first = await tick(f.deps);
    const before = await stat(file, { bigint: true });
    const contents = await readFile(file, 'utf8');
    const saves = f.saves();
    f.advance(10000);
    assert.deepEqual(await tick(f.deps), first);
    assert.equal(f.saves(), saves);
    const after = await stat(file, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(await readFile(file, 'utf8'), contents);
  }
});

test('the bundle reader rejects invalid allowlist data before staging', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kct-read-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map(CORE_FILES.map((name) => [name, Buffer.from(`# ${name}`)]));
  files.set('supported-runtimes.json', Buffer.from('[]'));
  for (const [name, bytes] of files) await writeFile(join(root, name), bytes);
  await assert.rejects(readBundle(root), /invalid runtime entry/);
});

async function deployFixture() {
  const root = await mkdtemp(join(tmpdir(), 'kct-deploy-plist-'));
  const dataDir = join(root, 'data');
  const plistPath = join(root, 'runtime.plist');
  await mkdir(dataDir);
  const files = new Map(CORE_FILES.map((name) => [name, Buffer.from('export {};\n')]));
  files.set('runtime.mjs', Buffer.from('process.exitCode = 0;\n'));
  files.set('runtime-launcher.mjs', await readFile(new URL('./runtime-launcher.mjs', import.meta.url)));
  files.set('supported-runtimes.json', Buffer.from(JSON.stringify([
    { electron: '99.0.0', sha256: 'a'.repeat(64), validatedWithApp: '1.0.0' },
  ])));
  return { root, dataDir, plistPath, files };
}

function candidateRuntime(outcome, extra = {}) {
  const fields = Object.entries({ outcome, ...extra })
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',');
  return `import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
await writeFile(join(here, '../../.last-run.json'), JSON.stringify({ id: process.env.KCT_LAUNCH_ID ?? null, ${fields} }));
`;
}

async function switchCandidate(fixture, script) {
  const { switchVersion, readDeployment } = await import('./runtime-launcher.mjs');
  const next = new Map(fixture.files);
  next.set('runtime.mjs', Buffer.from(script));
  await switchVersion(fixture.dataDir, next);
  return readDeployment(fixture.dataDir);
}

function agentFixture(fixture, initial = false) {
  let loaded = initial;
  const calls = [];
  let bootstrapFailures = 0;
  const run = async (command, args) => {
    if (command === '/usr/bin/plutil') return JSON.stringify({ Label: 'test.runtime',
      ProgramArguments: [process.execPath, join(fixture.dataDir, 'runtime.mjs'), '--once'],
      RunAtLoad: true, StartInterval: 60 });
    calls.push(args[0]);
    if (args[0] === 'print') {
      if (!loaded) throw new Error('Could not find service test.runtime');
      return `${process.execPath}\n${join(fixture.dataDir, 'runtime.mjs')}`;
    }
    if (args[0] === 'bootout') loaded = false;
    if (args[0] === 'bootstrap') {
      if (bootstrapFailures > 0) { bootstrapFailures--; throw new Error('bootstrap failed'); }
      loaded = true;
    }
    return '';
  };
  return { calls, run, failBootstrap: (count) => { bootstrapFailures = count; }, loaded: () => loaded };
}

const deployDeps = (fixture, agent) => ({ files: fixture.files, dataDir: fixture.dataDir,
  plistPath: fixture.plistPath, label: 'test.runtime', platformCheck: () => {},
  verify: async () => {}, run: agent.run, retryDelayMs: 0, allowMigration: true });

test('migration failure restores the legacy entry and plist and restarts the old job', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.dataDir, 'runtime.mjs'), 'old loader');
  await writeFile(fixture.plistPath, 'old plist');
  const agent = agentFixture(fixture, true);
  agent.failBootstrap(2);
  await assert.rejects(deploy(deployDeps(fixture, agent)), /bootstrap failed/);
  assert.equal(await readFile(join(fixture.dataDir, 'runtime.mjs'), 'utf8'), 'old loader');
  assert.equal(await readFile(fixture.plistPath, 'utf8'), 'old plist');
  assert.equal(agent.loaded(), true);
  assert.deepEqual(agent.calls, ['print', 'bootout', 'bootstrap', 'bootstrap', 'bootstrap', 'print']);
});

test('a migration journal restores the previous entry and registration after interruption', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const entry = join(fixture.dataDir, 'runtime.mjs');
  const journal = join(fixture.dataDir, '.migration.json');
  await writeFile(entry, 'legacy runtime');
  await writeFile(fixture.plistPath, 'legacy plist');
  await writeFile(join(fixture.dataDir, 'deployment.json'), '{"current":"' + 'a'.repeat(64) + '"}');
  await writeFile(journal, JSON.stringify({ entry: Buffer.from('legacy runtime').toString('base64'),
    plist: Buffer.from('legacy plist').toString('base64'), pointer: null, wasLoaded: true }));
  const agent = agentFixture(fixture, true);
  const broken = new Map(fixture.files);
  broken.delete('runtime-launcher.mjs');
  await assert.rejects(deploy({ ...deployDeps(fixture, agent), files: broken }),
    /missing runtime-launcher/);
  assert.equal(await readFile(entry, 'utf8'), 'legacy runtime');
  assert.equal(await readFile(fixture.plistPath, 'utf8'), 'legacy plist');
  assert.equal(existsSync(join(fixture.dataDir, 'deployment.json')), false);
  assert.equal(agent.loaded(), true);
  assert.equal(existsSync(journal), false);
});

test('an unloaded agent is registered and ordinary bundle updates never bootout or bootstrap', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture);
  await deploy(deployDeps(fixture, agent));
  const before = await readFile(join(fixture.dataDir, 'runtime.mjs'));
  const plist = await readFile(fixture.plistPath, 'utf8');
  assert.match(plist, /<key>StartInterval<\/key><integer>60<\/integer>/);
  assert.match(plist, /<key>WatchPaths<\/key>/);
  const { switchVersion, readDeployment } = await import('./runtime-launcher.mjs');
  const next = new Map(fixture.files);
  next.set('runtime.mjs', Buffer.from('process.exitCode = 0;\nconst changed = true;\n'));
  agent.calls.length = 0;
  await switchVersion(fixture.dataDir, next);
  assert.deepEqual(agent.calls, []);
  assert.deepEqual(await readFile(join(fixture.dataDir, 'runtime.mjs')), before);
  assert.equal((await readDeployment(fixture.dataDir)).candidate, true);
});

test('a runtime-only update from inside the service switches the pointer without unloading it', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture);
  await deploy(deployDeps(fixture, agent));
  const { atomicJSON, readDeployment } = await import('./runtime-launcher.mjs');
  const healthy = await readDeployment(fixture.dataDir);
  await atomicJSON(join(fixture.dataDir, 'deployment.json'), { ...healthy, candidate: false });
  const entry = await readFile(join(fixture.dataDir, 'runtime.mjs'));
  const next = new Map(fixture.files);
  next.set('runtime.mjs', Buffer.from('process.exitCode = 0;\nconst changed = true;\n'));
  const old = process.env.XPC_SERVICE_NAME;
  process.env.XPC_SERVICE_NAME = 'test.runtime';
  t.after(() => { if (old === undefined) delete process.env.XPC_SERVICE_NAME; else process.env.XPC_SERVICE_NAME = old; });
  agent.calls.length = 0;
  await deploy({ ...deployDeps(fixture, agent), files: next });
  assert.deepEqual(agent.calls, ['print']);
  assert.deepEqual(await readFile(join(fixture.dataDir, 'runtime.mjs')), entry);
  assert.equal((await readDeployment(fixture.dataDir)).candidate, true);
});

test('a failed bootout does not modify an existing entry or plist', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.dataDir, 'runtime.mjs'), 'old loader');
  await writeFile(fixture.plistPath, 'old plist');
  const agent = agentFixture(fixture, true);
  const run = async (command, args) => {
    if (args[0] === 'bootout') throw new Error('bootout failed');
    return agent.run(command, args);
  };
  await assert.rejects(deploy({ ...deployDeps(fixture, agent), run }), /bootout failed/);
  assert.equal(await readFile(join(fixture.dataDir, 'runtime.mjs'), 'utf8'), 'old loader');
  assert.equal(await readFile(fixture.plistPath, 'utf8'), 'old plist');
});

test('a running service cannot migrate or unload itself', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture, true);
  const old = process.env.XPC_SERVICE_NAME;
  process.env.XPC_SERVICE_NAME = 'test.runtime';
  t.after(() => { if (old === undefined) delete process.env.XPC_SERVICE_NAME; else process.env.XPC_SERVICE_NAME = old; });
  await assert.rejects(deploy(deployDeps(fixture, agent)), /outside the running service/);
  assert.deepEqual(agent.calls, []);
});

test('automatic deployment cannot migrate without an explicit --install, whatever the env marker says', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture);
  const old = process.env.XPC_SERVICE_NAME;
  t.after(() => {
    if (old === undefined) delete process.env.XPC_SERVICE_NAME;
    else process.env.XPC_SERVICE_NAME = old;
  });
  const attempt = async (value, pattern) => {
    if (value === undefined) delete process.env.XPC_SERVICE_NAME;
    else process.env.XPC_SERVICE_NAME = value;
    agent.calls.length = 0;
    await assert.rejects(deploy({ ...deployDeps(fixture, agent), allowMigration: false }), pattern);
    assert.deepEqual(agent.calls, [], `no launchctl command for env=${String(value)}`);
  };
  await attempt(undefined, /explicit --install/);
  await attempt('other.service', /explicit --install/);
  await attempt('test.runtime', /outside the running service/);

  delete process.env.XPC_SERVICE_NAME;
  await writeFile(join(fixture.dataDir, '.migration.json'), '{}');
  agent.calls.length = 0;
  await assert.rejects(deploy({ ...deployDeps(fixture, agent), allowMigration: false }),
    /requires --install/);
  assert.deepEqual(agent.calls, [], 'an interrupted migration is not recovered by the automatic path');
  await rm(join(fixture.dataDir, '.migration.json'), { force: true });
});

test('installation refuses a busy live lock and releases a lock after invalid staging', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture);
  const lock = join(fixture.dataDir, '.runtime-lock');
  await mkdir(lock);
  await writeFile(join(lock, 'pid'), String(process.pid));
  await assert.rejects(deploy(deployDeps(fixture, agent)), /another runtime operation/);
  const stale = new Date(Date.now() - 120000);
  await utimes(lock, stale, stale);
  await assert.rejects(deploy(deployDeps(fixture, agent)), /another runtime operation/);
  assert.equal(await readFile(join(lock, 'pid'), 'utf8'), String(process.pid));
  await rm(lock, { recursive: true });
  const broken = new Map(fixture.files);
  broken.set('supported-runtimes.json', Buffer.from('[]'));
  await assert.rejects(deploy({ ...deployDeps(fixture, agent), files: broken }), /invalid runtime entry/);
  assert.equal(existsSync(lock), false);
});

test('runtime locks verify owner start time so a reused PID cannot keep them forever', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kct-lock-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await mkdir(dataDir);
  const lock = join(dataDir, '.runtime-lock');
  const { acquireLock } = await import('./runtime-launcher.mjs');
  const startedAt = 1000;
  const identity = async () => startedAt;

  const first = await acquireLock(dataDir, { startedAt: identity });
  assert.ok(first);
  assert.equal(await acquireLock(dataDir, { startedAt: identity }), null);
  await first.release();

  await mkdir(lock);
  await writeFile(join(lock, 'pid'), String(process.pid));
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt }));
  const reused = await acquireLock(dataDir, { startedAt: async () => 5000 });
  assert.ok(reused, 'a different start time means the PID was reused');
  await reused.release();

  await mkdir(lock);
  await writeFile(join(lock, 'pid'), String(process.pid));
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt }));
  assert.equal(await acquireLock(dataDir, { startedAt: async () => null }), null,
    'an unverifiable live owner must not be stolen');
  await rm(lock, { recursive: true, force: true });

  await mkdir(lock);
  await writeFile(join(lock, 'pid'), '999999');
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 999999, startedAt }));
  const dead = await acquireLock(dataDir, { startedAt: async () => null });
  assert.ok(dead, 'a dead owner is reclaimed');
  await dead.release();

  await mkdir(lock);
  await writeFile(join(lock, 'pid'), String(process.pid));
  assert.equal(await acquireLock(dataDir, { startedAt: identity }), null,
    'an old-format lock with a live PID is respected');
  await rm(lock, { recursive: true, force: true });

  const [a, b] = await Promise.all([
    acquireLock(dataDir, { startedAt: identity }),
    acquireLock(dataDir, { startedAt: identity }),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1, 'concurrent callers never both acquire');
  await (a ?? b).release();
});

test('a failed candidate rolls back the pointer and the stable entry keeps working', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture);
  await deploy(deployDeps(fixture, agent));
  const launcher = await readFile(join(fixture.dataDir, 'runtime.mjs'));
  const { launch, switchVersion, readDeployment, verifyVersion } = await import('./runtime-launcher.mjs');
  const old = await readDeployment(fixture.dataDir);
  const broken = new Map(fixture.files);
  broken.set('runtime.mjs', Buffer.from('process.exitCode = 17;\n'));
  await switchVersion(fixture.dataDir, broken);
  assert.equal(await launch(fixture.dataDir, ['--once']), 17);
  const rolledBack = await readDeployment(fixture.dataDir);
  assert.equal(rolledBack.current, old.current);
  assert.equal(rolledBack.candidate, false);
  assert.match(rolledBack.blocked.detail, /exited with code 17/);
  await verifyVersion(fixture.dataDir, rolledBack.current);
  assert.deepEqual(await readFile(join(fixture.dataDir, 'runtime.mjs')), launcher);
  assert.equal(await launch(fixture.dataDir, ['--once']), 0);
  await assert.rejects(switchVersion(fixture.dataDir, broken), /previously rolled back/);
});

test('a candidate is healthy only after a structured success result', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture);
  await deploy(deployDeps(fixture, agent));
  const { launch, readDeployment } = await import('./runtime-launcher.mjs');
  const original = await readDeployment(fixture.dataDir);
  const candidate = await switchCandidate(fixture, candidateRuntime('success', {
    status: 'active', loaded: 1, inspectorClosed: true, revision: 'rev-1',
  }));
  assert.equal(await launch(fixture.dataDir, ['--once']), 0);
  const healthy = await readDeployment(fixture.dataDir);
  assert.equal(healthy.current, candidate.current);
  assert.equal(healthy.candidate, false);
  assert.equal(healthy.previous, original.current);
  assert.ok(healthy.healthyAt);
});

test('a candidate that reports an injection error is rolled back even though it exits zero', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture);
  await deploy(deployDeps(fixture, agent));
  const { launch, readDeployment } = await import('./runtime-launcher.mjs');
  const original = await readDeployment(fixture.dataDir);
  const candidate = await switchCandidate(fixture, candidateRuntime('failed', {
    status: 'error', detail: 'renderer rejected injection',
  }));
  assert.equal(await launch(fixture.dataDir, ['--once']), 0);
  const after = await readDeployment(fixture.dataDir);
  assert.equal(after.current, original.current);
  assert.equal(after.candidate, false);
  assert.equal(after.blocked.id, candidate.current);
  assert.match(after.blocked.detail, /renderer rejected injection/);
});

test('a waiting candidate stays pending without being marked healthy or failed', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture);
  await deploy(deployDeps(fixture, agent));
  const { launch, readDeployment } = await import('./runtime-launcher.mjs');
  const candidate = await switchCandidate(fixture, candidateRuntime('waiting', {
    status: 'waiting', detail: 'Kimi Code is not running',
  }));
  assert.equal(await launch(fixture.dataDir, ['--once']), 0);
  const waiting = await readDeployment(fixture.dataDir);
  assert.equal(waiting.current, candidate.current);
  assert.equal(waiting.candidate, true);
  assert.equal(waiting.healthyAt, undefined);
  assert.equal(waiting.startAttempts, undefined);
  assert.equal(await launch(fixture.dataDir, ['--once']), 0);
  assert.equal((await readDeployment(fixture.dataDir)).candidate, true);
});

test('a transient candidate failure is retried without rollback', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture);
  await deploy(deployDeps(fixture, agent));
  const { launch, readDeployment } = await import('./runtime-launcher.mjs');
  const candidate = await switchCandidate(fixture, candidateRuntime('transient', {
    status: 'error', failureKind: 'transient', detail: 'Inspector port busy',
  }));
  assert.equal(await launch(fixture.dataDir, ['--once']), 0);
  const after = await readDeployment(fixture.dataDir);
  assert.equal(after.current, candidate.current);
  assert.equal(after.candidate, true);
  assert.equal(after.blocked, undefined);
});

test('a candidate with no confirmation result is rolled back', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture);
  await deploy(deployDeps(fixture, agent));
  const { launch, readDeployment } = await import('./runtime-launcher.mjs');
  const original = await readDeployment(fixture.dataDir);
  const candidate = await switchCandidate(fixture, 'process.exitCode = 0;\nconst unconfirmed = true;\n');
  assert.notEqual(candidate.current, original.current);
  assert.equal(await launch(fixture.dataDir, ['--once']), 0);
  const after = await readDeployment(fixture.dataDir);
  assert.equal(after.current, original.current);
  assert.equal(after.blocked.id, candidate.current);
  assert.match(after.blocked.detail, /did not confirm injection/);
});

test('an incompatible candidate is rolled back with its diagnostic', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture);
  await deploy(deployDeps(fixture, agent));
  const { launch, readDeployment } = await import('./runtime-launcher.mjs');
  const original = await readDeployment(fixture.dataDir);
  const candidate = await switchCandidate(fixture, candidateRuntime('incompatible', {
    status: 'error', failureKind: 'permanent', detail: 'inspector fuse disabled',
  }));
  assert.equal(await launch(fixture.dataDir, ['--once']), 0);
  const after = await readDeployment(fixture.dataDir);
  assert.equal(after.current, original.current);
  assert.equal(after.blocked.id, candidate.current);
  assert.match(after.blocked.detail, /inspector fuse disabled/);
});

test('interrupted candidate starts recover to the last complete bundle', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture);
  await deploy(deployDeps(fixture, agent));
  const { launch, switchVersion, readDeployment, atomicJSON } = await import('./runtime-launcher.mjs');
  const original = await readDeployment(fixture.dataDir);
  const next = new Map(fixture.files);
  next.set('runtime.mjs', Buffer.from('process.exitCode = 0;\nconst candidate = true;\n'));
  await switchVersion(fixture.dataDir, next);
  const pending = await readDeployment(fixture.dataDir);
  await atomicJSON(join(fixture.dataDir, 'deployment.json'), { ...pending, startAttempts: 2 });
  assert.equal(await launch(fixture.dataDir, ['--once']), 0);
  assert.equal((await readDeployment(fixture.dataDir)).current, original.current);
});

test('recovery prefers the recorded previous version over a newer orphan', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture);
  await deploy(deployDeps(fixture, agent));
  const { launch, switchVersion, storeVersion, readDeployment, atomicJSON } =
    await import('./runtime-launcher.mjs');
  const original = await readDeployment(fixture.dataDir);
  const next = new Map(fixture.files);
  next.set('runtime.mjs', Buffer.from('process.exitCode = 0;\nconst v = 2;\n'));
  await switchVersion(fixture.dataDir, next);
  const candidate = await readDeployment(fixture.dataDir);
  await atomicJSON(join(fixture.dataDir, 'deployment.json'), { ...candidate, candidate: false });
  const orphan = new Map(fixture.files);
  orphan.set('runtime.mjs', Buffer.from('process.exitCode = 0;\nconst orphan = true;\n'));
  await storeVersion(fixture.dataDir, orphan);
  await writeFile(join(fixture.dataDir, 'versions', candidate.current, 'kct.js'), 'corrupt');
  assert.equal(await launch(fixture.dataDir, ['--once']), 0);
  const recovered = await readDeployment(fixture.dataDir);
  assert.equal(recovered.current, original.current);
  assert.equal(recovered.previous, null);
  assert.ok(recovered.recoveredAt);
});

test('missing LaunchAgent registration can be repaired without booting out a live job', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture);
  await deploy(deployDeps(fixture, agent));
  await agent.run('/bin/launchctl', ['bootout']);
  agent.calls.length = 0;
  const { repairAgent } = await import('./runtime.mjs');
  assert.deepEqual(await repairAgent({ dataDir: fixture.dataDir, plistPath: fixture.plistPath,
    label: 'test.runtime', run: agent.run, retryDelayMs: 0 }), { registered: true, repaired: true });
  assert.deepEqual(agent.calls, ['print', 'bootstrap', 'print']);
});

test('a historical active record never stands in for a live injection check', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture, true);
  await deploy(deployDeps(fixture, agent));
  const { doctor } = await import('./runtime.mjs');
  const report = await doctor({
    dataDir: fixture.dataDir, plistPath: fixture.plistPath, label: 'test.runtime', run: agent.run,
    find: async () => [{ pid: 4242, started: 'now' }],
    verify: async () => ({}),
    attach: async () => { throw new Error('inspector port 9229 is in use'); },
    stateReader: async () => ({ status: 'active', checkedAt: '2026-11-01T00:00:00.000Z',
      updateStatus: 'staged', updateVersion: '0.2.12' }),
  });
  assert.equal(report.installation.status, 'complete');
  assert.equal(report.launchAgent.status, 'registered');
  assert.equal(report.process.status, 'found');
  assert.equal(report.injection.status, 'unknown');
  assert.equal(report.page.status, 'unknown');
  assert.equal(report.translation.status, 'unknown');
  assert.equal(report.lastAttempt.evidence, 'history');
  assert.equal(report.lastAttempt.status, 'active');
});

test('diagnostics confirm the live hook, page and translation state', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture, true);
  await deploy(deployDeps(fixture, agent));
  const { doctor } = await import('./runtime.mjs');
  let closed = 0;
  const report = await doctor({
    dataDir: fixture.dataDir, plistPath: fixture.plistPath, label: 'test.runtime', run: agent.run,
    find: async () => [{ pid: 4242, started: 'now' }],
    verify: async () => ({}),
    attach: async () => ({
      evaluate: async () => ({ present: true, revision: 'rev-1', health: { pages: [
        { loaded: true, revision: 'rev-1', stale: false,
          health: { ready: true, enabled: true, blocks: 2, mounted: 2,
            unsupported: 0, translated: 1, failed: 0 } },
      ] } }),
      close: async () => { closed += 1; },
    }),
    stateReader: async () => ({ status: 'active' }),
  });
  assert.equal(report.injection.status, 'loaded');
  assert.equal(report.injection.revision, 'rev-1');
  assert.equal(report.page.status, 'mounted');
  assert.equal(report.page.blocks, 2);
  assert.equal(report.translation.status, 'working');
  assert.equal(report.translation.translated, 1);
  assert.equal(closed, 1);
});

// ---------------------------------------------------------------------------
// self-update
// ---------------------------------------------------------------------------

test('diagnostics report a stale renderer instead of claiming the new hook is current', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agent = agentFixture(fixture, true);
  await deploy(deployDeps(fixture, agent));
  const { doctor } = await import('./runtime.mjs');
  const report = await doctor({
    dataDir: fixture.dataDir, plistPath: fixture.plistPath, label: 'test.runtime', run: agent.run,
    find: async () => [{ pid: 4242, started: 'now' }],
    verify: async () => ({}),
    attach: async () => ({
      evaluate: async () => ({ present: true, revision: 'rev-2', health: { pages: [
        { loaded: true, revision: 'rev-1', stale: true, health: { ready: true, enabled: true,
          blocks: 1, mounted: 1, unsupported: 0, translated: 1, failed: 0 } },
      ] } }),
      close: async () => {},
    }),
    stateReader: async () => ({ status: 'active' }),
  });
  assert.equal(report.page.status, 'stale-renderer');
  assert.equal(report.page.stale, 1);
  assert.equal(report.page.revisions.includes('rev-1'), true);
  assert.equal(report.injection.staleRenderers, 1);
});

test('the refresh entry asks the hook to reload stale pages and closes the inspector', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  let closed = 0;
  const { reloadStalePages } = await import('./runtime.mjs');
  const result = await reloadStalePages({
    dataDir: fixture.dataDir,
    find: async () => [{ pid: 4242, started: 'now' }],
    verify: async () => ({}),
    attach: async () => ({
      evaluate: async () => ({ present: true, revision: 'rev-2', reloaded: 1, stale: ['rev-1'] }),
      close: async () => { closed += 1; },
    }),
  });
  assert.deepEqual(result, { present: true, revision: 'rev-2', reloaded: 1, stale: ['rev-1'] });
  assert.equal(closed, 1);
});

test('update manifest validation rejects malformed descriptors', async () => {
  const { validateManifest, isNewer, parseVersion } = await import('./runtime-update.mjs');
  const good = {
    version: '0.2.0', base: 'https://example.test',
    files: Object.fromEntries(CORE_FILES.map((name) => [name, 'a'.repeat(64)])),
  };
  assert.doesNotThrow(() => validateManifest(good));
  assert.throws(() => validateManifest({ ...good, version: 'latest' }), /valid version/);
  assert.throws(() => validateManifest({ ...good, base: 'http://insecure.test' }), /https/);
  assert.throws(() => validateManifest({ ...good, files: { 'runtime.mjs': 'nope' } }), /valid hash/);
  assert.throws(() => validateManifest(null), /not an object/);
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(isNewer('0.2.0', '0.1.0'), true);
  assert.equal(isNewer('0.1.0', '0.2.0'), false);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
});

test('an up-to-date client ignores an older manifest schema, a newer one is validated', async () => {
  const { resolveUpdate } = await import('./runtime-update.mjs');
  const manifest = { version: '0.2.11', base: 'https://example.test', files: {} };
  const fetchImpl = async () => ({ ok: true, json: async () => structuredClone(manifest) });
  const current = await resolveUpdate({ current: '0.2.11', fetchImpl });
  assert.equal(current.available, false);
  assert.equal(current.remote, '0.2.11');
  manifest.version = '0.2.12';
  await assert.rejects(resolveUpdate({ current: '0.2.11', fetchImpl }), /valid hash/);
});

test('a download whose bytes do not match the manifest hash is refused', async () => {
  const { downloadBundle } = await import('./runtime-update.mjs');
  const manifest = {
    version: '0.2.0', base: 'https://example.test',
    files: Object.fromEntries(CORE_FILES.map((name) => [name, 'b'.repeat(64)])),
  };
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('tampered') });
  await assert.rejects(() => downloadBundle(manifest, { fetchImpl }), /hash mismatch/);
});

test('a retried update reuses only hash-verified cached files', async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'kct-update-cache-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const { downloadBundle } = await import('./runtime-update.mjs');
  const bodies = Object.fromEntries(CORE_FILES.map((name) => [name, `content of ${name}`]));
  const manifest = {
    version: '0.2.0', base: 'https://example.test',
    files: Object.fromEntries(Object.entries(bodies)
      .map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')])),
  };
  let fetches = 0;
  const fetchImpl = async (url) => {
    fetches += 1;
    return { ok: true, arrayBuffer: async () => Buffer.from(bodies[url.split('/').pop()]) };
  };
  const first = await downloadBundle(manifest, { fetchImpl, cacheDir });
  assert.equal(fetches, CORE_FILES.length);
  const cached = await downloadBundle(manifest,
    { cacheDir, fetchImpl: async () => { throw new Error('cache miss'); } });
  assert.equal(fetches, CORE_FILES.length);
  assert.deepEqual([...cached.keys()], CORE_FILES);
  assert.equal(cached.get('kct.js').toString(), bodies['kct.js']);
  assert.equal(first.get('kct.js').toString(), bodies['kct.js']);
  const changed = { ...manifest, files: { ...manifest.files, 'kct.js': 'd'.repeat(64) } };
  await assert.rejects(downloadBundle(changed, { fetchImpl, cacheDir }), /hash mismatch/);
  assert.ok(fetches > CORE_FILES.length, 'a changed manifest clears the old cache');
});

test('a newer published version is fetched and handed to the atomic deploy path', async () => {
  const { selfUpdate } = await import('./runtime.mjs');
  const { createHash } = await import('node:crypto');
  const bodies = Object.fromEntries(CORE_FILES.map((name) => [name, `content of ${name}`]));
  const files = Object.fromEntries(Object.entries(bodies)
    .map(([name, text]) => [name, createHash('sha256').update(Buffer.from(text)).digest('hex')]));
  const seen = [];
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => ({ version: '0.2.0', base: 'https://example.test', files }),
    arrayBuffer: async () => Buffer.from(bodies[url.split('/').pop()]),
  });
  const result = await selfUpdate({
    currentVersion: '0.1.0',
    fetchImpl,
    deployFn: async ({ files: downloaded }) => { seen.push(downloaded.size); },
  });
  assert.equal(result.updated, true);
  assert.equal(result.from, '0.1.0');
  assert.equal(result.to, '0.2.0');
  assert.deepEqual(seen, [6]);
});

test('an up-to-date install performs no download and no deployment', async () => {
  const { selfUpdate } = await import('./runtime.mjs');
  let deployed = 0;
  const files = Object.fromEntries(CORE_FILES.map((name) => [name, 'c'.repeat(64)]));
  const result = await selfUpdate({
    currentVersion: '0.2.0',
    fetchImpl: async () => ({ ok: true, json: async () => ({
      version: '0.2.0', base: 'https://example.test', files }) }),
    deployFn: async () => { deployed += 1; },
  });
  assert.equal(result.updated, false);
  assert.equal(result.reason, 'up-to-date');
  assert.equal(deployed, 0);
});

test('an unknown runtime hash is accepted when signature, fuses and the renderer contract hold', async () => {
  const css = ['.think', '.think-head', '.think-body', '.think-body-inner', '.think-text']
    .map((name) => `${name}{}`).join('');
  const binary = Buffer.concat([Buffer.from('prefixdL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
    Buffer.from([1, 9]), Buffer.from('101100001')]);
  const deps = {
    fingerprint: async () => 'file',
    output: async (_cmd, args) => {
      const electron = args?.some((a) => a.includes(':CFBundleVersion'));
      return electron ? '43.1.1\n' : '1.1.3\n';
    },
    run: async () => ({ stderr: 'Identifier=com.kimi.code.desktop\nTeamIdentifier=2J9472RW75\n' }),
    readFile: async (file) => {
      if (String(file).endsWith('supported-runtimes.json')) return JSON.stringify([
        { electron: '43.1.1', sha256: 'a'.repeat(64), validatedWithApp: '1.1.1' }]);
      if (String(file).endsWith('Electron Framework')) return binary;
      if (String(file).endsWith('index.html')) return '<link href="/assets/main.css">';
      return css;
    },
  };
  const result = await verifyApp(deps);
  assert.equal(result.verified, 'capabilities');
  assert.equal(result.electron, '43.1.1');
  assert.equal(result.version, '1.1.3');
});

test('an unseen Electron major is allowed and missing stylesheet evidence stays unknown', async () => {
  const css = ['.think', '.think-head', '.think-body', '.think-body-inner', '.think-text']
    .map((name) => `${name}{}`).join('');
  const binary = Buffer.concat([Buffer.from('prefixdL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
    Buffer.from([1, 9]), Buffer.from('101100001')]);
  const make = (electron, style) => ({
    fingerprint: async () => 'file',
    output: async (_cmd, args) => args?.some((a) => a.includes(':CFBundleVersion')) ? electron : '1.1.3',
    run: async () => ({}),
    readFile: async (file) => {
      if (String(file).endsWith('supported-runtimes.json')) return '[]';
      if (String(file).endsWith('Electron Framework')) return binary;
      if (String(file).endsWith('index.html')) return "<link href='/assets/main.css'>";
      return style;
    },
  });
  const unseen = await verifyApp(make('99.0.0', css));
  assert.equal(unseen.verified, 'capabilities');
  assert.equal(unseen.electron, '99.0.0');
  assert.equal(unseen.rendererContract, 'present-in-styles');
  assert.equal((await verifyApp(make('99.0.0', '.renamed{}'))).rendererContract, 'unknown');
});

test('process discovery matches the executable path despite spaces in the name', async () => {
  const { findProcesses } = await import('./runtime.mjs');
  const listing = [
    '  100 /Applications/Kimi Code.app/Contents/MacOS/Kimi Code',
    '  101 /Applications/Kimi Code.app/Contents/Frameworks/Kimi Code Helper.app/Contents/MacOS/Kimi Code Helper',
    '  102 /Applications/Other.app/Contents/MacOS/Kimi Code',
    '  not-a-pid whatever',
  ].join('\n');
  const seen = [];
  const found = await findProcesses({
    listProcesses: async () => listing,
    identify: async (pid) => {
      seen.push(pid);
      return { pid, uid: process.getuid(),
        executable: pid === 100 ? '/Applications/Kimi Code.app/Contents/MacOS/Kimi Code' : '/elsewhere' };
    },
  });
  assert.deepEqual(found.map((item) => item.pid), [100]);
  assert.deepEqual(seen, [100], 'only the exact main executable is identified');
});

test('a helper process whose identity does not match stays excluded', async () => {
  const { findProcesses } = await import('./runtime.mjs');
  const found = await findProcesses({
    listProcesses: async () => '  100 /Applications/Kimi Code.app/Contents/MacOS/Kimi Code',
    identify: async (pid) => ({ pid, uid: process.getuid(), executable: '/Applications/Kimi Code.app/Contents/MacOS/Kimi Code Helper' }),
  });
  assert.deepEqual(found, []);
});

test('no network access happens while Kimi is not running', async () => {
  const { tick } = await import('./runtime.mjs');
  let resolved = 0;
  const deps = {
    findProcesses: async () => [],
    readState: async () => ({}),
    saveState: async () => {},
    readFile: async () => 'source',
    fingerprint: async () => 'fp',
    portOpen: async () => false,
    output: async () => '',
    installIntoProcess: async () => ({ loaded: 1 }),
    now: () => Date.UTC(2026, 9, 24, 12, 0, 0),
    update: {
      version: '0.2.0', dataDir: '/tmp/kct-update-test', updateCheck: true,
      resolveUpdateFn: async () => { resolved += 1; return { available: false, current: '0.2.0', remote: '0.2.0' }; },
      applyUpdate: async () => true,
    },
  };
  const state = await tick(deps);
  assert.equal(state.status, 'waiting');
  assert.equal(resolved, 0, 'a stopped Kimi must never trigger an update check');
});

test('a failed update check is retried with bounded backoff and only commits success', async () => {
  const { tick } = await import('./runtime.mjs');
  let previous = {};
  let attempts = 0;
  let now = Date.UTC(2026, 9, 24, 12, 0, 0);
  const deps = {
    findProcesses: async () => [INFO],
    readState: async () => structuredClone(previous),
    saveState: async (state) => { previous = structuredClone(state); },
    readFile: async () => 'source', fingerprint: async () => 'fp', portOpen: async () => false,
    output: async () => '', verifyApp: async () => ({ version: '1.1.2', electron: '43.1.1' }),
    installIntoProcess: async () => ({ loaded: 1 }), now: () => now,
    update: { version: '0.2.0', dataDir: '/tmp/kct-update-retry-test', updateCheck: true,
      resolveUpdateFn: async () => {
        attempts++;
        if (attempts < 3) throw new Error('offline');
        return { available: false, current: '0.2.0', remote: '0.2.0' };
      }, applyUpdate: async () => true },
  };
  let state = await tick(deps);
  assert.equal(state.updateStatus, 'failed');
  assert.equal(state.updateCheckedFor, undefined);
  assert.equal(attempts, 1);
  now += 59999;
  state = await tick(deps);
  assert.equal(attempts, 1);
  now += 1;
  state = await tick(deps);
  assert.equal(attempts, 2);
  now += 300000;
  state = await tick(deps);
  assert.equal(attempts, 3);
  assert.equal(state.updateStatus, 'up-to-date');
  assert.equal(state.updateCheckedFor, `${INFO.pid}:${INFO.started}`);
});

test('a migration that cannot run inside the service stops update retries', async () => {
  const { tick } = await import('./runtime.mjs');
  let previous = {};
  let attempts = 0;
  const deps = {
    findProcesses: async () => [INFO],
    readState: async () => structuredClone(previous),
    saveState: async (state) => { previous = structuredClone(state); },
    readFile: async () => 'source', fingerprint: async () => 'fp', portOpen: async () => false,
    output: async () => '', verifyApp: async () => ({ version: '1.1.2', electron: '43.1.1' }),
    installIntoProcess: async () => ({ loaded: 1 }),
    now: () => Date.UTC(2026, 9, 24, 12, 0, 0),
    update: { version: '0.2.0', dataDir: '/tmp/kct-update-migration-test', updateCheck: true,
      resolveUpdateFn: async () => {
        attempts++;
        return { available: true, current: '0.2.0', remote: '0.2.1', manifest: {} };
      }, applyUpdate: async () => {
        throw new Error('LaunchAgent migration requires an explicit --install from a terminal session');
      } },
  };
  const state = await tick(deps);
  assert.equal(state.updateStatus, 'failed');
  assert.equal(state.updateAttempts, 4);
  assert.equal(state.updateNextRetryAt, null);
  await tick(deps);
  assert.equal(attempts, 1);
});

test('one Kimi launch checks for updates once, not on every tick', async () => {
  const { tick } = await import('./runtime.mjs');
  let resolved = 0;
  let previous = {};
  const deps = {
    findProcesses: async () => [INFO],
    readState: async () => structuredClone(previous),
    saveState: async (state) => { previous = structuredClone(state); },
    readFile: async () => 'source',
    fingerprint: async () => 'fp',
    portOpen: async () => false,
    output: async () => '',
    verifyApp: async () => ({ version: '1.1.2', electron: '43.1.1', executable: 'fp' }),
    installIntoProcess: async () => ({ loaded: 1 }),
    now: () => Date.UTC(2026, 9, 24, 12, 0, 0),
    update: {
      version: '0.2.0', dataDir: '/tmp/kct-update-test', updateCheck: true,
      resolveUpdateFn: async () => { resolved += 1;
        return { available: false, current: '0.2.0', remote: '0.2.0' }; },
      applyUpdate: async () => true,
    },
  };
  await tick(deps);
  await tick(deps);
  await tick(deps);
  assert.equal(resolved, 1, 'the same process must not re-check on later ticks');

  const restarted = { ...INFO, pid: INFO.pid + 1, started: 'Sat Oct 24 12:05:00 2026' };
  await tick({ ...deps, findProcesses: async () => [restarted] });
  assert.equal(resolved, 2, 'a fresh Kimi launch checks again');
});

test('an unreachable canonical host falls back to the CDN mirror', async () => {
  const { downloadBundle, fetchManifest, mirrorUrl, MANIFEST_MIRRORS } = await import('./runtime-update.mjs');
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('raw.githubusercontent.com')) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    return { ok: true, arrayBuffer: async () => Buffer.from(`mirrored ${url.split('/').pop()}`) };
  };
  const files = Object.fromEntries(CORE_FILES.map((name) => [name,
    createHash('sha256').update(Buffer.from(`mirrored ${name}`)).digest('hex')]));
  const fetched = await fetchManifest('https://raw.githubusercontent.com/wssz527/kimi-cot-translate/main/runtime-manifest.json', {
    fetchImpl, files,
  }).catch(() => null);
  assert.equal(fetched, null, 'the fixture returns file bytes, not JSON');
  assert.deepEqual(seen.slice(0, 2), [
    'https://raw.githubusercontent.com/wssz527/kimi-cot-translate/main/runtime-manifest.json',
    MANIFEST_MIRRORS['https://raw.githubusercontent.com/wssz527/kimi-cot-translate/main/runtime-manifest.json'][0],
  ], 'the canonical host is tried first, then the mirror');
  // jsDelivr caches branch refs and can keep serving a stale manifest, whose
  // hashes then no longer match the files it points at.
  assert.ok(!JSON.stringify(MANIFEST_MIRRORS).includes('jsdelivr'),
    'a stale mirror is worse than none: it makes every update fail its hash check');
  const bundle = await downloadBundle({
    version: '0.2.8', base: 'https://raw.githubusercontent.com/wssz527/kimi-cot-translate/v0.2.8', files,
  }, { fetchImpl });
  assert.equal(bundle.size, 6);
  assert.ok([...bundle.values()].every((bytes) => bytes.toString().startsWith('mirrored')));
  assert.equal(mirrorUrl('https://raw.githubusercontent.com/wssz527/kimi-cot-translate/v0.2.8/kct.js'),
    'https://cdn.statically.io/gh/wssz527/kimi-cot-translate/v0.2.8/kct.js');
  assert.equal(mirrorUrl('https://example.test/kct.js'), null);
});

// ---------------------------------------------------------------------------
// candidate confirmation: live evidence only
// ---------------------------------------------------------------------------

function candidateFixture({ state = {}, installed = 1, health = null, verifyError } = {}) {
  let previous = state;
  let installedCount = 0;
  let verifyCount = 0;
  const deps = {
    saveState: async (next) => { previous = structuredClone(next); },
    readState: async () => structuredClone(previous),
    findProcesses: async () => [INFO],
    readFile: async (path) => String(path).endsWith('supported-runtimes.json') ? '[]' : 'source',
    fingerprint: async () => 'executable-fingerprint',
    portOpen: async () => false,
    output: async () => '',
    verifyApp: async () => {
      verifyCount += 1;
      if (verifyError) throw verifyError;
      return { version: '1.1.1', electron: '43.1.1' };
    },
    installIntoProcess: async () => {
      installedCount += 1;
      // The real function rejects when neither a current nor a stale page
      // accepted the script, so the fixture does the same.
      if (!installed && !(health?.stale ?? 0)) {
        throw Object.assign(new Error('No main Kimi renderer accepted the translation script'),
          { failureKind: 'inspector-uncertain' });
      }
      return { loaded: installed, stale: 0, health };
    },
    now: () => Date.UTC(2026, 9, 21, 13, 58, 30),
    candidate: true,
  };
  return { deps, state: () => previous, installed: () => installedCount, verified: () => verifyCount };
}

test('a historical active record with an identical revision still forces a live install', async (t) => {
  const historical = {
    identity: `${INFO.pid}:${INFO.started}:executable-fingerprint`,
    revision: 'same-revision', pid: INFO.pid, started: INFO.started,
    status: 'active', loaded: 1, inspectorClosed: true, attempts: 1,
  };
  const f = candidateFixture({ state: historical });
  const saved = await tick(f.deps);
  assert.equal(f.installed(), 1, 'a candidate never reuses a historical active record');
  assert.equal(f.verified(), 1);
  assert.equal(saved.status, 'active');
  assert.equal(saved.liveVerified, true);
  assert.notEqual(saved.revision, 'same-revision', 'the revision is recomputed from the bundle');
  assert.equal(launchOutcome(saved), 'success');
});

test('a candidate whose hook is missing is not reported healthy', async (t) => {
  const f = candidateFixture({ installed: 0 });
  const saved = await tick(f.deps);
  assert.equal(saved.status, 'blocked-inspector');
  assert.notEqual(saved.liveVerified, true);
  assert.equal(launchOutcome(saved), 'failed');
  assert.match(saved.detail, /No main Kimi renderer accepted/);
});

test('a candidate that cannot attach leaves the run unverified instead of successful', async (t) => {
  const f = candidateFixture({ verifyError: Object.assign(new Error('codesign timed out'), { killed: true }) });
  const saved = await tick(f.deps);
  assert.equal(saved.status, 'error');
  assert.equal(saved.liveVerified, undefined);
  assert.equal(launchOutcome(saved), 'transient');
});

test('a candidate with no page mounted is not a translation failure but is still unverified', async (t) => {
  const f = candidateFixture({ health: { revision: 'rev', pages: [], current: 0, stale: 0,
    unresponsive: 0, pending: 1, currentHealth: [], staleRevisions: [] } });
  const saved = await tick(f.deps);
  assert.equal(saved.renderer, 'none');
  assert.equal(saved.pagesPending, 1);
  assert.equal(saved.blocks, 0);
  assert.equal(saved.translation, 'no-thinking-blocks');
  assert.equal(saved.status, 'active');
  assert.equal(launchOutcome(saved), 'success', 'the hook is installed; only the page has not loaded yet');
});

test('an installed hook with only stale pages is transient, not a failed injection', async (t) => {
  const f = candidateFixture({ installed: 0, health: { revision: 'rev', pages: [], current: 0,
    stale: 1, unresponsive: 0, pending: 0, currentHealth: [], staleRevisions: ['old'] } });
  f.deps.installIntoProcess = async () => ({ loaded: 0, stale: 1, health: { revision: 'rev',
    pages: [], current: 0, stale: 1, unresponsive: 0, pending: 0,
    currentHealth: [], staleRevisions: ['old'] } });
  const saved = await tick(f.deps);
  assert.equal(saved.status, 'active');
  assert.equal(saved.loaded, 0);
  assert.equal(saved.renderer, 'stale');
  assert.equal(launchOutcome(saved), 'transient',
    'the new bundle must not be rolled back because a window still runs the old renderer');
});

test('a candidate whose pages are all stale is reported as a stale renderer', async (t) => {
  const f = candidateFixture({ health: { revision: 'rev', pages: [], current: 0, stale: 2,
    unresponsive: 0, pending: 0, currentHealth: [], staleRevisions: ['old-1', 'old-2'] } });
  const saved = await tick(f.deps);
  assert.equal(saved.renderer, 'stale');
  assert.equal(saved.pagesStale, 2);
  assert.deepEqual(saved.staleRevisions, ['old-1', 'old-2']);
  assert.equal(saved.liveVerified, true);
});

test('a candidate with current pages and no thinking blocks is a confirmed healthy start', async (t) => {
  const f = candidateFixture({ health: { revision: 'rev', pages: [], current: 1, stale: 0,
    unresponsive: 0, pending: 0, staleRevisions: [],
    currentHealth: [{ ready: true, enabled: true, blocks: 0, mounted: 0,
      unsupported: 0, translated: 0, failed: 0 }] } });
  const saved = await tick(f.deps);
  assert.equal(saved.renderer, 'current');
  assert.equal(saved.pagesCurrent, 1);
  assert.equal(saved.blocks, 0);
  assert.equal(saved.translation, 'no-thinking-blocks');
  assert.equal(launchOutcome(saved), 'success');
});

test('an unavailable inspector never writes a healthy candidate', async (t) => {
  const f = candidateFixture();
  f.deps.installIntoProcess = async () => {
    throw Object.assign(new Error('Kimi did not open its inspector'), { failureKind: 'inspector-uncertain' });
  };
  const saved = await tick(f.deps);
  assert.equal(saved.status, 'blocked-inspector');
  assert.equal(saved.liveVerified, undefined);
  assert.equal(launchOutcome(saved), 'failed');
});

test('a retried candidate waits for its backoff instead of injecting again', async (t) => {
  const f = candidateFixture();
  f.deps.installIntoProcess = async () => {
    throw Object.assign(new Error('Inspector port 9229 is in use'), { failureKind: 'transient' });
  };
  const first = await tick(f.deps);
  assert.equal(first.status, 'error');
  assert.equal(f.installed(), 0);
  const second = await tick(f.deps);
  assert.equal(second.status, 'error');
  assert.equal(second.detail, first.detail, 'the second tick reuses the recorded failure');
  assert.equal(launchOutcome(second), 'transient');
});

test('page health separates current, stale, pending and unresponsive pages', async () => {
  assert.deepEqual(pageHealth({ current: 1, stale: 2, pending: 1, unresponsive: 1,
    staleRevisions: ['a'], currentHealth: [{ blocks: 3, mounted: 3 }] }), {
    renderer: 'stale', pagesCurrent: 1, pagesStale: 2, pagesPending: 1, pagesUnresponsive: 1,
    staleRevisions: ['a'], blocks: 3, mounted: 3, translation: 'unconfirmed',
  });
  assert.deepEqual(pageHealth(null), {});
  assert.equal(pageHealth({ current: 0, stale: 0, pending: 0, unresponsive: 0,
    currentHealth: [] }).renderer, 'none');
  assert.equal(pageHealth({ current: 1, stale: 0, pending: 0, unresponsive: 0,
    currentHealth: [{ blocks: 2, mounted: 0 }] }).translation, 'unmounted');
});
