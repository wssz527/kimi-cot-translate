import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, win32 } from 'node:path';
import {
  acquireLock, assertPlatform, bridgeRequest, commandLineArgs, disable, findProcesses,
  install, readState, selectProcesses, taskRequest, tick,
  verifyApp, verifyBinary, watch, windowsPaths,
} from './runtime-windows.mjs';

const localAppData = "C:\\Users\\Test O'Brien\\AppData\\Local";
const PATHS = windowsPaths({ localAppData });
const SID = 'S-1-5-21-100-200-300-1001';
const SIGNATURE = { status: 'Valid', thumbprint: '5603104F31C1236A07A3A2E79FA285A11C2B3997' };
const INFO = {
  pid: 42, started: '2026-10-22T00:00:00.000Z', ownerSid: SID,
  executable: PATHS.executable, commandLine: `"${PATHS.executable}"`,
};
const FILES = ['runtime-windows.mjs', 'runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs',
  'windows-bridge.ps1', 'supported-windows-runtimes.json', 'supported-runtimes.json', 'kct.js'];
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
    debugPortOpen: async () => true,
    installIntoRenderers: async (_source, _revision, _options) => {
      installs++;
      return { loaded: 1, renderers: [] };
    },
  };
  return { options, sources, setFound: (value) => { found = value; },
    state: () => previous, installs: () => installs };
}

test('paths follow the real installation and keep LOCALAPPDATA as the default', () => {
  assert.equal(PATHS.appDir, win32.join(localAppData, 'Programs', 'Kimi Code'));
  assert.equal(PATHS.dataDir, win32.join(localAppData, 'kimi-cot-translate', 'windows'));
  assert.equal(windowsPaths({ localAppData, dataDir: '/test-data' }).dataDir, '/test-data');
  // The installer can be pointed at another drive, so an explicit directory is
  // honoured instead of being rejected for not matching the default.
  const custom = windowsPaths({ localAppData, appDir: 'D:\\Apps\\KimiCode' });
  assert.equal(custom.appDir, win32.resolve('D:\\Apps\\KimiCode'));
  assert.equal(custom.executable, win32.join(win32.resolve('D:\\Apps\\KimiCode'), 'Kimi Code.exe'));
  assert.throws(() => windowsPaths({ localAppData, appDir: 'D:\\' }), /drive root/);
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
    '--remote-debugging-port=9333', '--user-data-dir=C:\\tmp', '--profile-directory=Other',
    '--ins"pect"=9229', '"--user-data-dir=C:\\Other Profile"',
    '--unused=C:\\tmp\\ --user-data-dir=C:\\alternate',
    '--unused=C:\\tmp\\\t--remote-debugging-port=9333']) {
    assert.throws(() => selectProcesses({ sid: SID,
      processes: [{ ...INFO, commandLine: `${INFO.commandLine} ${arg}` }] }, { localAppData }), /debugging|profile/);
  }
  // This tool attaches through the debugging port, so its own exact argument is
  // the expected state rather than a reason to refuse.
  assert.deepEqual(selectProcesses({ sid: SID,
    processes: [{ ...INFO, commandLine: `${INFO.commandLine} --remote-debugging-port=9222` }] },
  { localAppData }).map((p2) => p2.pid), [INFO.pid]);
  for (const changed of [{ executable: 'C:\\Other\\Kimi Code.exe' }, { ownerSid: '' },
    { started: 'invalid' }, { pid: 0 }, { commandLine: null },
    { commandLine: '"C:\\Other\\Kimi Code.exe"' }]) {
    assert.throws(() => selectProcesses({ sid: SID, processes: [{ ...INFO, ...changed }] }, { localAppData }));
  }
  assert.equal(selectProcesses({ sid: SID, processes: [INFO, { ...INFO, pid: 45 }] }, { localAppData }).length, 2);
  // Kimi Code launches helper scripts through its own executable. They are not
  // a second main process and must not make attachment refuse as ambiguous.
  const helper = { ...INFO, pid: 46,
    commandLine: `"${INFO.executable}" ./bin/kimi-datasource.mjs` };
  assert.deepEqual(selectProcesses({ sid: SID, processes: [INFO, helper] }, { localAppData }).map((p) => p.pid),
    [INFO.pid]);
});

test('binary verification needs PE x64 and fuse, reports the signature, and never requires it', () => {
  const { binary, allow } = binaryFixture();
  assert.equal(verifyBinary(binary, SIGNATURE, allow()).electron, '43.1.1');
  assert.equal(verifyBinary(binary, SIGNATURE, allow()).verified, 'exact');
  // The signature is informational. This is a free third-party translator, so
  // an unsigned, expired or rotated-certificate host must still work; gating on
  // it is what used to break Windows whenever the vendor rotated its certificate.
  const rotated = { status: 'Valid', thumbprint: '187C364D836FF69A95A57E07C7B9A864BC00362A',
    subject: 'CN=NOVASCENT PRIVATE LIMITED, O=NOVASCENT PRIVATE LIMITED, L=Singapore, C=SG' };
  for (const signature of [rotated, { status: 'UnknownError' }, { status: 'NotTrusted' },
    { status: 'Valid', thumbprint: 'A'.repeat(40) }, undefined]) {
    const result = verifyBinary(binary, signature, allow());
    assert.equal(result.verified, 'exact');
    assert.equal(result.signature.signed, signature?.status === 'Valid');
  }
  assert.equal(verifyBinary(binary, SIGNATURE, allow()).signature.thumbprint,
    '5603104F31C1236A07A3A2E79FA285A11C2B3997');
  // A build this project has never seen is not a refusal: the capability checks
  // below are what decide attachment, exactly as on macOS.
  const known = allow();
  binary[1000] = 1;
  const unseen = verifyBinary(binary, SIGNATURE, known);
  assert.equal(unseen.verified, 'contract');
  assert.equal(unseen.electron, 'unknown');
  binary.writeUInt16LE(0xaa64, 68);
  assert.throws(() => verifyBinary(binary, SIGNATURE, allow()), /PE x64/);
  binary.writeUInt16LE(0x8664, 68);
  const fuseAt = binary.indexOf(Buffer.from('101100001'));
  binary[fuseAt + 3] = 48;
  assert.throws(() => verifyBinary(binary, SIGNATURE, allow()), /disabled/);
  binary[fuseAt + 3] = 49;
  assert.throws(() => verifyBinary(binary, SIGNATURE, [
    { ...known[0], electron: 43 }, ...known.slice(1)]), /Invalid Windows runtime allowlist/);
});

test('application verification checks the renderer contract and detects a concurrent update', async () => {
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
  // An unsigned host still verifies: the signature is reported, not required.
  signature = { ...SIGNATURE, status: 'NotTrusted' };
  assert.equal((await verifyApp(options)).signature.signed, false);
  signature = SIGNATURE;
  style = '.unrelated{}';
  await assert.rejects(verifyApp(options), /reasoning UI changed/);
  style = CSS; changed = true; reads = 0;
  await assert.rejects(verifyApp(options), /changed during verification/);
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

test('an unsigned host still attaches, while a changed renderer contract stops it', async () => {
  const f = tickFixture();
  const { binary, allow } = binaryFixture();
  const known = allow();
  let style = CSS;
  f.options.verifyApp = async () => verifyApp({
    localAppData, fingerprint: async () => 'file',
    bridge: async () => ({ ...SIGNATURE, status: 'NotTrusted' }),
    readFile: async (file) => {
      if (String(file).endsWith('.json')) return JSON.stringify(known);
      if (String(file).endsWith('index.html')) return '<link href="/assets/main.css">';
      if (file === PATHS.executable) return binary;
      return style;
    },
  });
  const state = await tick(f.options);
  assert.equal(state.status, 'active');
  // The reasoning DOM is the real contract: when it changes, nothing attaches.
  style = '.unrelated{}';
  const blocked = tickFixture();
  blocked.options.verifyApp = f.options.verifyApp;
  const failed = await tick(blocked.options);
  assert.equal(failed.status, 'error');
  assert.equal(failed.failureKind, 'permanent');
  assert.equal(blocked.installs(), 0);
});

test('a closed debugging port is a retryable failure and nothing is injected', async () => {
  const f = tickFixture();
  f.options.debugPortOpen = async () => false;
  const closed = await tick(f.options);
  assert.match(closed.detail, /debugging port/);
  assert.equal(closed.status, 'error');
  assert.equal(f.installs(), 0);
  // A later tick after the port is up attaches normally.
  f.options.now = () => Date.parse('2026-10-22T00:00:40Z');
  f.options.debugPortOpen = async () => true;
  assert.equal((await tick(f.options)).status, 'active');
  assert.equal(f.installs(), 1);
});

test('a failed attach backs off and reattaches once the renderer is reachable', async () => {
  const f = tickFixture();
  let calls = 0;
  f.options.installIntoRenderers = async () => {
    calls++;
    if (calls === 1) throw new Error('No Kimi renderer page is available for translation yet');
    return { loaded: 1, renderers: [] };
  };
  const failed = await tick(f.options);
  assert.equal(failed.status, 'error');
  assert.ok(failed.nextRetryAt, 'a failure must schedule a retry rather than stop for good');
  // Before the backoff elapses the attach is not attempted again.
  f.options.now = () => Date.parse('2026-10-22T00:00:20Z');
  await tick(f.options);
  assert.equal(calls, 1);
  // After it elapses, the page is reachable and the tick succeeds.
  f.options.now = () => Date.parse('2026-10-22T03:00:00Z');
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
  g.options.installIntoRenderers = async () => { throw new Error('still transient'); };
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
    f.options.installIntoRenderers = async () => { throw new Error('transient'); };
    await tick(f.options);
    f.setFound([changed]);
    f.options.installIntoRenderers = async () => ({ loaded: 1, renderers: [] });
    const state = await tick(f.options);
    assert.equal(state.status, 'active');
    assert.equal(state.attempts, 1);
  }
});

test('an interrupted attempt retries after backoff instead of attaching immediately', async () => {
  const f = tickFixture();
  await tick(f.options);
  const interrupted = { ...f.state(), status: 'checking' };
  const read = f.options.readState;
  f.options.readState = async () => interrupted;
  const blocked = await tick(f.options);
  // A previous attempt whose outcome is unknown is not retried on the spot.
  assert.equal(blocked.status, 'blocked-inspector');
  assert.equal(blocked.failureKind, 'inspector-uncertain');
  assert.equal(f.installs(), 1);
  f.options.readState = read;
  f.options.now = () => Date.parse('2026-10-22T00:00:20Z');
  assert.deepEqual(await tick(f.options), blocked);
  f.options.now = () => Date.parse('2026-10-22T03:00:00Z');
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
  // With the debugging port closed there is nothing to attach to, so the tick
  // reports an error instead of pretending the translation is live.
  const closed = tickFixture();
  delete closed.options.readState;
  closed.options.debugPortOpen = async () => false;
  assert.equal((await tick({ ...closed.options, dataDir,
    logError: (message) => errors.push(message) })).status, 'error');
  assert.equal(closed.installs(), 0, 'safe defaults must still require the port before attaching');
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
