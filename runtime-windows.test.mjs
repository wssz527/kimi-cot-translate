import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, win32 } from 'node:path';
import {
  acquireLock, assertPlatform, bridgeRequest, commandLineArgs, disable, findProcesses,
  install, inspectorOperations, readState, selectProcesses, taskRequest, tick,
  triggerInspector, verifyApp, verifyBinary, watch, windowsPaths,
} from './runtime-windows.mjs';

const localAppData = "C:\\Users\\Test O'Brien\\AppData\\Local";
const PATHS = windowsPaths({ localAppData });
const SID = 'S-1-5-21-100-200-300-1001';
const SIGNATURE = { status: 'Valid', thumbprint: 'F754CEE9121450C6CD50EE89D1CD9E692FE1CA40' };
const INFO = {
  pid: 42, started: '2026-10-22T00:00:00.000Z', ownerSid: SID,
  executable: PATHS.executable, commandLine: `"${PATHS.executable}"`,
};
const FILES = ['runtime-windows.mjs', 'runtime.mjs', 'runtime-hook.mjs',
  'windows-bridge.ps1', 'supported-windows-runtimes.json', 'kct.js'];
const CSS = ['think', 'think-head', 'think-body', 'think-body-inner', 'think-text']
  .map((name) => `.${name}{}`).join('');

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'kct-windows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function binaryFixture() {
  const binary = Buffer.alloc(1024);
  binary.write('MZ');
  binary.writeUInt32LE(64, 0x3c);
  binary.write('PE\0\0', 64);
  binary.writeUInt16LE(0x8664, 68);
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  sentinel.copy(binary, 128);
  binary[128 + sentinel.length] = 1;
  binary[129 + sentinel.length] = 9;
  binary.write('101100001', 130 + sentinel.length);
  binary.write('Electron/43.1.1', 256);
  const allow = () => [{
    sha256: createHash('sha256').update(binary).digest('hex'), size: binary.length,
    electron: '43.1.1', appVersion: '1.1.1', signerThumbprint: SIGNATURE.thumbprint,
  }];
  return { binary, allow };
}

function tickFixture() {
  let previous = {}, found = [INFO], installs = 0;
  const sources = Object.fromEntries(FILES.map((name) => [name, `fixture:${name}`]));
  const options = {
    localAppData,
    now: () => Date.parse('2026-10-22T00:00:10Z'),
    readState: async () => structuredClone(previous),
    saveState: async (state) => { previous = structuredClone(state); },
    readFile: async (file) => Buffer.from(sources[basename(file)]),
    findProcesses: async () => found,
    fingerprint: async () => 'file-fingerprint',
    verifyApp: async () => ({ version: '1.1.1', electron: '43.1.1', executable: 'file-fingerprint' }),
    portOpen: async () => false,
    installIntoProcess: async (_info, _app, _source, _revision, operations) => {
      assert.deepEqual(Object.keys(operations).sort(),
        ['checkIdentity', 'triggerInspector', 'verifyLiveProcess', 'verifyPortOwner'].sort());
      installs++;
      return { loaded: 1 };
    },
  };
  return { options, sources, setFound: (value) => { found = value; },
    state: () => previous, installs: () => installs };
}

test('paths follow LOCALAPPDATA dynamically and reject nonstandard installations', () => {
  assert.equal(PATHS.appDir, win32.join(localAppData, 'Programs', 'Kimi Code'));
  assert.equal(PATHS.dataDir, win32.join(localAppData, 'kimi-cot-translate', 'windows'));
  assert.equal(windowsPaths({ localAppData, dataDir: '/test-data' }).dataDir, '/test-data');
  assert.throws(() => windowsPaths({ localAppData, appDir: 'C:\\Elsewhere' }), /Only LOCALAPPDATA/);
  assert.throws(() => windowsPaths({ localAppData: 'relative' }), /absolute/);
  assert.doesNotThrow(() => assertPlatform({ platform: 'win32', arch: 'x64', nodeVersion: '24.18.0' }));
  for (const overrides of [{ platform: 'darwin' }, { arch: 'arm64' }, { nodeVersion: '22.0.0' },
    { electronVersion: '43.1.1' }]) {
    assert.throws(() => assertPlatform({ platform: 'win32', arch: 'x64', nodeVersion: '24.18.0', ...overrides }));
  }
});

test('Windows argument parsing handles spaces, apostrophes, quotes and trailing slashes', () => {
  assert.deepEqual(commandLineArgs(`"${PATHS.executable}" "a b" ""`), [PATHS.executable, 'a b', '']);
  assert.deepEqual(commandLineArgs('exe "a\\\\\\\"b" c\\\\'), ['exe', 'a\\"b', 'c\\\\']);
  assert.deepEqual(commandLineArgs('exe --ins"pect"=9229'), ['exe', '--inspect=9229']);
  assert.deepEqual(commandLineArgs('exe --unused=C:\\tmp\\ --user-data-dir=C:\\alternate'),
    ['exe', '--unused=C:\\tmp\\', '--user-data-dir=C:\\alternate']);
  assert.throws(() => commandLineArgs('exe "unfinished'), /Unterminated/);
});

test('only current-user standard main processes survive discovery', async () => {
  const processes = [INFO, { ...INFO, pid: 43, commandLine: `${INFO.commandLine} --type=renderer` },
    { ...INFO, pid: 44, ownerSid: 'S-1-5-21-999' }];
  const snapshot = { sid: SID, processes };
  assert.deepEqual(selectProcesses(snapshot, { localAppData }), [INFO]);
  assert.deepEqual(await findProcesses({ localAppData, bridge: async (action) => {
    assert.equal(action, 'Discover'); return snapshot;
  } }), [INFO]);
  for (const arg of ['--inspect', '--inspect-brk=9229', '--debug-port=9229',
    '--remote-debugging-port=9222', '--user-data-dir=C:\\tmp', '--profile-directory=Other',
    '--ins"pect"=9229', '"--user-data-dir=C:\\Other Profile"',
    '--unused=C:\\tmp\\ --user-data-dir=C:\\alternate',
    '--unused=C:\\tmp\\\t--remote-debugging-port=9222']) {
    assert.throws(() => selectProcesses({ sid: SID,
      processes: [{ ...INFO, commandLine: `${INFO.commandLine} ${arg}` }] }, { localAppData }), /debugging|profile/);
  }
  for (const changed of [{ executable: 'C:\\Other\\Kimi Code.exe' }, { ownerSid: '' },
    { started: 'invalid' }, { pid: 0 }, { commandLine: null },
    { commandLine: '"C:\\Other\\Kimi Code.exe"' }]) {
    assert.throws(() => selectProcesses({ sid: SID, processes: [{ ...INFO, ...changed }] }, { localAppData }));
  }
  assert.equal(selectProcesses({ sid: SID, processes: [INFO, { ...INFO, pid: 45 }] }, { localAppData }).length, 2);
});

test('binary verification requires signature, independent hash, PE x64, fuse and exact Electron', () => {
  const { binary, allow } = binaryFixture();
  assert.equal(verifyBinary(binary, SIGNATURE, allow()).electron, '43.1.1');
  for (const signature of [{ ...SIGNATURE, status: 'UnknownError' },
    { ...SIGNATURE, thumbprint: '0'.repeat(40) }, {}]) {
    assert.throws(() => verifyBinary(binary, signature, allow()), /Authenticode/);
  }
  const known = allow();
  binary[1000] = 1;
  assert.throws(() => verifyBinary(binary, SIGNATURE, known), /Unknown Windows EXE hash/);
  binary.writeUInt16LE(0xaa64, 68);
  assert.throws(() => verifyBinary(binary, SIGNATURE, allow()), /PE x64/);
  binary.writeUInt16LE(0x8664, 68);
  const fuseAt = binary.indexOf(Buffer.from('101100001'));
  binary[fuseAt + 3] = 48;
  assert.throws(() => verifyBinary(binary, SIGNATURE, allow()), /disabled/);
  binary[fuseAt + 3] = 49;
  binary.write('Electron/43.1.10', 256);
  assert.throws(() => verifyBinary(binary, SIGNATURE, allow()), /Electron\/43.1.1/);
});

test('application verification checks signature and CSS, and detects a concurrent update', async () => {
  const { binary, allow } = binaryFixture();
  let signature = SIGNATURE, style = CSS, changed = false, reads = 0;
  const options = {
    localAppData,
    bridge: async (action, request) => {
      assert.equal(action, 'Signature'); assert.equal(request.executable, PATHS.executable);
      return signature;
    },
    fingerprint: async () => changed && reads++ ? 'new' : 'old',
    readFile: async (file) => {
      if (String(file).endsWith('supported-windows-runtimes.json')) return JSON.stringify(allow());
      if (file === PATHS.executable) return binary;
      if (String(file).endsWith('index.html')) return '<link href="/assets/main.css">';
      return style;
    },
  };
  assert.equal((await verifyApp(options)).version, '1.1.1');
  signature = { ...SIGNATURE, status: 'NotTrusted' };
  await assert.rejects(verifyApp(options), /Authenticode/);
  signature = SIGNATURE;
  style = '.unrelated{}';
  await assert.rejects(verifyApp(options), /reasoning UI changed/);
  style = CSS; changed = true; reads = 0;
  await assert.rejects(verifyApp(options), /changed during verification/);
});

test('identity and port owner operations fail before a trigger on PID changes', async () => {
  let found = [INFO], triggered = 0, listeners = [{ pid: INFO.pid, address: '127.0.0.1' }];
  const operations = inspectorOperations({
    localAppData, findProcesses: async () => found, fingerprint: async () => 'file',
    triggerInspector: async () => { triggered++; }, bridge: async () => listeners,
  });
  await operations.verifyLiveProcess(INFO, { executable: 'file' });
  await operations.verifyPortOwner(INFO);
  found = [{ ...INFO, started: '2026-10-22T00:00:01Z' }];
  await assert.rejects(operations.triggerInspector(INFO), /identity changed/);
  assert.equal(triggered, 0);
  found = [INFO, { ...INFO, pid: 43 }];
  await assert.rejects(operations.triggerInspector(INFO), /unique/);
  found = [INFO];
  for (const invalid of [[], [{ pid: 99, address: '127.0.0.1' }],
    [{ pid: INFO.pid, address: '0.0.0.0' }]]) {
    listeners = invalid;
    await assert.rejects(operations.verifyPortOwner(INFO), /owned exclusively/);
  }
});

test('one attempt survives absence and multiple processes; a new start or source revision retries', async () => {
  const f = tickFixture();
  assert.equal((await tick(f.options)).status, 'active');
  const firstRevision = f.state().revision;
  f.options.fingerprint = async () => 'changed file metadata';
  await tick(f.options);
  f.setFound([]);
  assert.equal((await tick(f.options)).status, 'waiting');
  f.setFound([INFO, { ...INFO, pid: 43 }]);
  await tick(f.options);
  f.setFound([INFO]);
  await tick(f.options);
  assert.equal(f.installs(), 1);
  f.setFound([{ ...INFO, started: '2026-10-22T00:00:01Z' }]);
  await tick(f.options);
  assert.equal(f.installs(), 2);
  f.sources['runtime-windows.mjs'] += '\nrevision change';
  await tick(f.options);
  assert.equal(f.installs(), 3);
  assert.equal(f.state().attempts, 2, 'revision changes retain the current process budget');
  assert.notEqual(f.state().revision, firstRevision);
});

test('signature and hash rejection never reach installation or the trigger', async () => {
  for (const reason of ['signature', 'hash']) {
    const f = tickFixture();
    const { binary, allow } = binaryFixture();
    const known = allow();
    if (reason === 'hash') binary[1000] = 1;
    let checks = 0;
    f.options.verifyApp = async () => {
      checks++;
      return verifyApp({
        localAppData, fingerprint: async () => 'file',
        bridge: async () => reason === 'signature' ? { ...SIGNATURE, status: 'NotTrusted' } : SIGNATURE,
        readFile: async (file) => String(file).endsWith('.json') ? JSON.stringify(known) : binary,
      });
    };
    const state = await tick(f.options);
    assert.equal(state.status, 'error');
    assert.equal(state.failureKind, 'permanent');
    assert.equal(state.nextRetryAt, null);
    assert.match(state.detail, reason === 'signature' ? /Authenticode/ : /Unknown Windows EXE hash/);
    assert.equal(f.installs(), 0);
    f.options.now = () => Date.parse('2026-10-22T03:00:00Z');
    const later = await tick(f.options);
    assert.equal(later.status, 'error');
    assert.equal(checks, 1);
    assert.equal(f.installs(), 0);
  }
});

test('occupied ports remain retryable without recording a signal attempt', async () => {
  const f = tickFixture();
  f.options.portOpen = async () => true;
  const occupied = await tick(f.options);
  assert.match(occupied.detail, /occupied/);
  assert.equal(occupied.status, 'error');
  assert.equal(f.installs(), 0);
  f.options.now = () => Date.parse('2026-10-22T00:00:40Z');
  f.options.portOpen = async () => false;
  assert.equal((await tick(f.options)).status, 'active');
  assert.equal(f.installs(), 1);
});

test('the helper uses a bounded separate Node process with an argument-safe PID', async () => {
  let calls = 0;
  const error = await triggerInspector(INFO, {
    platformCheck: () => {},
    timeout: 123,
    execFile: async (command, args, options) => {
      calls++;
      assert.equal(command, process.execPath);
      assert.equal(args.at(-1), String(INFO.pid));
      assert.match(args[2], /process\._debugProcess\(pid\)/);
      assert.equal(options.timeout, 123);
      assert.equal(options.windowsHide, true);
      assert.equal(options.env.NODE_OPTIONS, '');
      const failure = new Error('terminated'); failure.killed = true; throw failure;
    },
  }).catch((failure) => failure);
  assert.match(error.message, /helper did not complete/);
  assert.equal(error.failureKind, 'inspector-uncertain');
  assert.equal(calls, 1);
  const exited = await triggerInspector(INFO, {
    platformCheck: () => {},
    execFile: async () => { const failure = new Error('exited'); failure.code = 1; throw failure; },
  }).catch((failure) => failure);
  assert.equal(exited.failureKind, 'inspector-uncertain');
  await assert.rejects(triggerInspector(INFO, {
    platformCheck: () => {},
    execFile: async () => { const failure = new Error('missing'); failure.code = 'ENOENT'; throw failure; },
  }), { code: 'ENOENT' });
  await assert.rejects(triggerInspector({ pid: '42;bad' }, {
    execFile: async () => { throw new Error('must not execute'); },
  }), /Invalid target PID/);
});

test('helper timeout stays blocked until its port is released, then retries after backoff', async () => {
  const f = tickFixture();
  let calls = 0;
  f.options.installIntoProcess = async () => {
    calls++;
    if (calls === 1) {
      return triggerInspector(INFO, {
        platformCheck: () => {},
        execFile: async () => { const error = new Error('timeout'); error.killed = true; throw error; },
      });
    }
    return { loaded: 1 };
  };
  const failed = await tick(f.options);
  assert.equal(failed.status, 'blocked-inspector');
  assert.equal(failed.failureKind, 'inspector-uncertain');
  assert.equal(failed.nextRetryAt, '2026-10-22T00:00:40.000Z');
  f.options.portOpen = async () => true;
  f.options.now = () => Date.parse('2026-10-22T03:00:00Z');
  await tick(f.options);
  assert.equal(calls, 1);
  f.options.portOpen = async () => false;
  assert.equal((await tick(f.options)).status, 'active');
  assert.equal(calls, 2);
});

test('transient failures retry after backoff and preserve the budget across revisions', async () => {
  const f = tickFixture();
  let fail = true;
  const verify = f.options.verifyApp;
  f.options.verifyApp = async () => {
    if (fail) throw new Error('transient verification timeout');
    return verify();
  };
  const first = await tick(f.options);
  assert.equal(first.status, 'error');
  assert.equal(first.failureKind, 'transient');
  assert.equal(first.attempts, 1);
  assert.equal(first.nextRetryAt, '2026-10-22T00:00:40.000Z');
  await tick(f.options);
  assert.equal(f.state().attempts, 1, 'backoff must not consume another attempt');
  f.options.now = () => Date.parse('2026-10-22T00:00:40Z');
  fail = false;
  assert.equal((await tick(f.options)).status, 'active');
  assert.equal(f.state().attempts, 2);

  const g = tickFixture();
  g.options.installIntoProcess = async () => { throw new Error('still transient'); };
  for (let i = 0; i < 8; i++) {
    await tick(g.options);
    const next = g.state().nextRetryAt;
    if (next) g.options.now = () => Date.parse(next);
  }
  const exhausted = g.state();
  assert.equal(exhausted.attempts, 8);
  assert.equal(exhausted.nextRetryAt, null);
  g.sources['runtime-windows.mjs'] += '\nrevision changed';
  g.options.now = () => Date.parse('2026-10-30T00:00:00Z');
  await tick(g.options);
  assert.equal(g.state().attempts, 8);
  assert.equal(g.state().status, 'error');
});

test('a changed PID or start resets attempts without waiting for the old deadline', async () => {
  for (const changed of [{ ...INFO, pid: 43 }, { ...INFO, started: '2026-10-22T00:00:01Z' }]) {
    const f = tickFixture();
    f.options.installIntoProcess = async () => { throw new Error('transient'); };
    await tick(f.options);
    f.setFound([changed]);
    f.options.installIntoProcess = async () => ({ loaded: 1 });
    const state = await tick(f.options);
    assert.equal(state.status, 'active');
    assert.equal(state.attempts, 1);
  }
});

test('interrupted checking probes the port before retrying and respects backoff after release', async () => {
  const f = tickFixture();
  await tick(f.options);
  const interrupted = { ...f.state(), status: 'checking' };
  const read = f.options.readState;
  f.options.readState = async () => interrupted;
  let probes = 0;
  f.options.portOpen = async () => { probes++; return true; };
  const blocked = await tick(f.options);
  assert.equal(blocked.status, 'blocked-inspector');
  assert.equal(blocked.failureKind, 'inspector-uncertain');
  assert.equal(probes, 1);
  assert.equal(f.installs(), 1);
  f.options.readState = read;
  f.options.portOpen = async () => false;
  f.options.now = () => Date.parse('2026-10-22T00:00:39Z');
  assert.deepEqual(await tick(f.options), blocked);
  f.options.now = () => Date.parse('2026-10-22T00:00:40Z');
  assert.equal((await tick(f.options)).status, 'active');
  assert.equal(f.installs(), 2);
});

test('preflight file IO failures use backoff before any installation', async () => {
  const f = tickFixture();
  const read = f.options.readFile;
  f.options.readFile = async () => { throw Object.assign(new Error('temporarily locked'), { code: 'EACCES' }); };
  const failed = await tick(f.options);
  assert.equal(failed.failureKind, 'transient');
  assert.equal(failed.attempts, 1);
  f.options.readFile = read;
  await tick(f.options);
  assert.equal(f.installs(), 0);
  f.options.now = () => Date.parse(failed.nextRetryAt);
  assert.equal((await tick(f.options)).status, 'active');
  assert.equal(f.state().attempts, 2);
  assert.equal(f.installs(), 1);
});

test('unchanged active, waiting and error states do not rewrite the state file', async (t) => {
  const root = await temporary(t);
  for (const status of ['active', 'waiting', 'error']) {
    const f = tickFixture();
    f.options.dataDir = join(root, status);
    delete f.options.saveState;
    delete f.options.readState;
    if (status === 'waiting') f.setFound([]);
    if (status === 'error') f.options.verifyApp = async () => { throw new Error('temporary failure'); };
    const initial = await tick(f.options);
    const file = join(f.options.dataDir, 'runtime-state.json');
    const contents = await readFile(file, 'utf8');
    const before = await stat(file, { bigint: true });
    f.options.now = () => Date.parse('2026-10-22T00:00:20Z');
    assert.deepEqual(await tick(f.options), initial);
    const after = await stat(file, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(await readFile(file, 'utf8'), contents);
  }
});

test('locks exclude other watchers and once operations, then release cleanly', async (t) => {
  const dataDir = await temporary(t);
  const first = await acquireLock(dataDir);
  assert.ok(first);
  assert.equal(await acquireLock(dataDir), null);
  await first.release();
  const second = await acquireLock(dataDir);
  assert.ok(second);
  await second.release();
});

test('concurrent lock contenders never obtain two locks', async (t) => {
  const dataDir = await temporary(t);
  const locks = await Promise.all(Array.from({ length: 12 }, () => acquireLock(dataDir)));
  const winners = locks.filter(Boolean);
  assert.equal(winners.length, 1);
  await winners[0].release();
});

test('PowerShell arguments transport paths and quotes without shell interpolation', () => {
  const request = bridgeRequest('Signature', { executable: PATHS.executable }, { bundleDir: "/test O'Brien" });
  assert.equal(request.options.windowsHide, true);
  assert.equal(request.args.at(-1), 'Signature');
  assert.equal(JSON.parse(request.options.env.KCT_WINDOWS_REQUEST).executable, PATHS.executable);
  const task = taskRequest("C:\\User O'Brien\\bundle", "C:\\Node O'Brien\\node.exe", "C:\\Data O'Brien");
  assert.match(task.arguments, /-WindowStyle Hidden .* -EncodedCommand /);
  const script = Buffer.from(task.arguments.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(script, /O''Brien/);
  assert.match(script, /-Action Watch -NodePath '/);
  assert.match(script, /-RuntimePath '/);
  assert.match(script, /-DataDir 'C:\\Data O''Brien'/);
  assert.ok(!task.arguments.includes("O'Brien"));
});

test('disable unregisters without killing a watcher that is in the middle of attachment', async (t) => {
  const dataDir = await temporary(t);
  const options = { localAppData, dataDir };
  let entered, finish;
  const started = new Promise((resolve) => { entered = resolve; });
  const inflight = new Promise((resolve) => { finish = resolve; });
  const watcher = watch({ ...options, tick: async () => { entered(); await inflight; }, sleep: async () => {} });
  await started;
  const calls = [];
  assert.equal((await disable({ ...options, bridge: async (action) => { calls.push(action); return {}; } })).status, 'disabled');
  assert.deepEqual(calls, ['Disable']);
  assert.equal(await acquireLock(dataDir), null, 'disable must leave the active attachment lock alone');
  finish();
  assert.equal((await watcher).status, 'disabled');
  const lock = await acquireLock(dataDir);
  assert.ok(lock); await lock.release();
  let ticks = 0;
  await watch({ ...options, tick: async () => { ticks++; } });
  assert.equal(ticks, 0, 'a delayed scheduled start cannot re-enable a disabled watcher');
});

test('watch keeps running after tick, stop-file and enabled.json failures', async (t) => {
  const dataDir = await temporary(t);
  const enabled = { entry: join(import.meta.dirname, 'runtime-windows.mjs'), generation: 'generation' };
  await writeFile(join(dataDir, 'enabled.json'), JSON.stringify(enabled));
  let now = 0;
  let stoppedChecks = 0;
  const errors = [];
  const sleeps = [];
  const tickTimes = [];
  const options = {
    localAppData, dataDir, now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
      assert.ok(sleeps.length < 4000, 'watcher must eventually recover');
    },
    tick: async () => {
      tickTimes.push(now);
      if (tickTimes.length === 1) await writeFile(join(dataDir, 'enabled.json'), 'broken');
      if (tickTimes.length >= 2 && tickTimes.length <= 4) throw new Error('tick failed');
      if (tickTimes.length === 5) await writeFile(join(dataDir, 'stop'), '');
    },
    logError: (message) => errors.push(message),
    statFile: async () => {
      if (++stoppedChecks === 1) throw new Error('stop file unavailable');
      return stat(join(dataDir, 'stop'));
    },
  };
  const readEnabled = readFile;
  let failedRead = false;
  options.readFile = async (file, ...args) => {
    if (!failedRead && String(file).endsWith('enabled.json')) {
      failedRead = true;
      throw Object.assign(new Error('temporarily locked'), { code: 'EACCES' });
    }
    return readEnabled(file, ...args);
  };
  assert.equal((await watch(options)).status, 'disabled');
  assert.deepEqual(tickTimes, [150000, 160000, 190000, 310000, 910000]);
  assert.ok(sleeps.every((ms) => ms === 1000), 'backoff must leave stop checks responsive');
  assert.ok(errors.some((message) => /tick failed/.test(message)));
  assert.ok(errors.some((message) => /Watcher iteration failed/.test(message)));
  assert.ok(errors.some((message) => /temporarily locked/.test(message)));
  assert.ok(errors.some((message) => /enabled\.json is unreadable/.test(message)));
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'enabled.json'), 'utf8')), enabled);
  const lock = await acquireLock(dataDir);
  assert.ok(lock);
  await lock.release();
});

test('watch repairs a corrupt enabled.json and continues', async (t) => {
  const dataDir = await temporary(t);
  await writeFile(join(dataDir, 'enabled.json'), 'broken');
  let ticks = 0;
  const errors = [];
  const options = {
    localAppData, dataDir,
    sleep: async () => {},
    tick: async () => { ticks++; await writeFile(join(dataDir, 'stop'), ''); },
    logError: (message) => errors.push(message),
  };
  assert.equal((await watch(options)).status, 'disabled');
  assert.equal(ticks, 1);
  assert.ok(errors.some((message) => /enabled\.json is unreadable/.test(message)));
  const repaired = JSON.parse(await readFile(join(dataDir, 'enabled.json'), 'utf8'));
  assert.equal(repaired.entry, join(import.meta.dirname, 'runtime-windows.mjs'));
});

test('installation stages and verifies files before task registration; failure restores controls', async (t) => {
  const root = await temporary(t);
  const dataDir = join(root, 'data'), bundleDir = join(root, "source O'Brien");
  await mkdir(bundleDir);
  for (const name of FILES) await writeFile(join(bundleDir, name), `fixture:${name}`);
  const options = { localAppData, dataDir, bundleDir, platformCheck: () => {}, verifyApp: async () => {} };
  const calls = [];
  await install({ ...options, bridge: async (action, request) => {
    calls.push(action);
    if (action === 'Install') {
      const config = JSON.parse(await readFile(join(dataDir, 'enabled.json'), 'utf8'));
      for (const name of FILES) {
        assert.equal(await readFile(join(config.entry, '..', name), 'utf8'), `fixture:${name}`);
      }
      assert.match(request.arguments, /EncodedCommand/);
    }
    return {};
  } });
  assert.deepEqual(calls, ['Install', 'Start']);
  const enabled = await readFile(join(dataDir, 'enabled.json'), 'utf8');
  await assert.rejects(install({ ...options, bridge: async (action) => {
    if (action === 'Install') throw new Error('registration failed');
    return {};
  } }), /registration failed/);
  assert.equal(await readFile(join(dataDir, 'enabled.json'), 'utf8'), enabled);
  assert.equal((await readdir(dataDir)).filter((name) => name.startsWith('bundle-')).length, 1);
});

test('installation verification failure does not stage files or request a scheduled task', async (t) => {
  const root = await temporary(t);
  let commands = 0;
  await assert.rejects(install({
    localAppData, dataDir: root, platformCheck: () => {},
    verifyApp: async () => { throw new Error('unknown hash'); },
    bridge: async () => { commands++; },
  }), /unknown hash/);
  assert.equal(commands, 0);
  assert.deepEqual(await readdir(root), []);
});

test('reinstall keeps only current and previous complete owned bundles without touching user directories', async (t) => {
  const root = await temporary(t);
  const dataDir = join(root, 'data'), bundleDir = join(root, 'source');
  await mkdir(bundleDir);
  await mkdir(dataDir);
  const userDirectory = 'bundle-11111111-1111-1111-1111-111111111111';
  await mkdir(join(dataDir, userDirectory));
  await writeFile(join(dataDir, userDirectory, 'user.txt'), 'keep');
  await writeFile(join(root, 'outside.txt'), 'keep outside');
  const options = { localAppData, dataDir, bundleDir, platformCheck: () => {},
    verifyApp: async () => {}, bridge: async () => ({}) };
  let previous;
  for (let revision = 0; revision < 5; revision++) {
    for (const name of FILES) await writeFile(join(bundleDir, name), `revision ${revision}:${name}`);
    await install(options);
    const current = JSON.parse(await readFile(join(dataDir, 'enabled.json'), 'utf8')).entry;
    const owned = (await readdir(dataDir)).filter((name) => name.startsWith('bundle-') && name !== userDirectory);
    assert.equal(owned.length, Math.min(2, revision + 1));
    assert.ok(owned.includes(basename(join(current, '..'))));
    if (previous) assert.ok(owned.includes(basename(join(previous, '..'))));
    previous = current;
  }
  assert.equal(await readFile(join(dataDir, userDirectory, 'user.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), 'keep outside');
});

test('a busy lifecycle lock prevents install and disable from racing', async (t) => {
  const dataDir = await temporary(t);
  const lock = await acquireLock(dataDir, '.lifecycle-lock');
  let commands = 0;
  const options = { localAppData, dataDir, platformCheck: () => {},
    verifyApp: async () => {}, bridge: async () => { commands++; } };
  await assert.rejects(install(options), /Another install or disable/);
  await assert.rejects(disable(options), /Another install or disable/);
  assert.equal(commands, 0);
  await lock.release();
});

test('state corruption uses safe defaults and reports a diagnostic', async (t) => {
  const dataDir = await temporary(t);
  await writeFile(join(dataDir, 'runtime-state.json'), 'broken');
  const errors = [];
  assert.deepEqual(await readState({ localAppData, dataDir, logError: (message) => errors.push(message) }), {});
  assert.match(errors[0], /runtime-state\.json is unreadable/);
  await writeFile(join(dataDir, 'runtime-state.json'), 'null');
  assert.deepEqual(await readState({ localAppData, dataDir, logError: (message) => errors.push(message) }), {});
  assert.match(errors[1], /must contain an object/);
  const f = tickFixture();
  delete f.options.readState;
  const state = await tick({ ...f.options, dataDir, logError: (message) => errors.push(message) });
  assert.equal(state.status, 'active');
  assert.equal(f.installs(), 1);
  const occupied = tickFixture();
  delete occupied.options.readState;
  occupied.options.portOpen = async () => true;
  assert.equal((await tick({ ...occupied.options, dataDir,
    logError: (message) => errors.push(message) })).status, 'error');
  assert.equal(occupied.installs(), 0, 'safe defaults must still check the port before triggering');
});

test('scheduled tasks are per-user limited and never request forced termination', async () => {
  const script = await readFile(new URL('./windows-bridge.ps1', import.meta.url), 'utf8');
  assert.match(script, /-LogonType Interactive -RunLevel Limited/);
  assert.match(script, /-AtLogOn -User \$user/);
  assert.match(script, /-MultipleInstances IgnoreNew/);
  assert.match(script, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(script, /Get-AuthenticodeSignature -LiteralPath/);
  assert.doesNotMatch(script, /Stop-Process|Stop-ScheduledTask|taskkill|Invoke-Expression/);
  const allowlist = JSON.parse(await readFile(new URL('./supported-windows-runtimes.json', import.meta.url), 'utf8'));
  assert.equal(allowlist[0].sha256, '9c6aac3196d3fb2a62e3ff67e6add9f24238efddf661cfcc7088b120f7e478e9');
  assert.equal(allowlist[0].electron, '43.1.1');
});
