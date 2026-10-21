import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { assertIdentity, assertRendererContract, deploy, inspectorDeadlineExpression,
  inspectFuses, parseProcess, rendererBootstrap, readBundle, stageBundle, switchBundle } from './runtime.mjs';

const INFO = parseProcess(
  `85123 ${process.getuid()} Wed Oct 21 21:58:18 2026 /Applications/Kimi Code.app/Contents/MacOS/Kimi Code`,
);
const CORE_FILES = ['runtime.mjs', 'runtime-hook.mjs', 'supported-runtimes.json', 'kct.js'];

test('only an unchanged main process owned by this user is eligible for a signal', () => {
  const info = parseProcess(`85123 ${process.getuid()} Wed Oct 21 21:58:18 2026 /Applications/Kimi Code.app/Contents/MacOS/Kimi Code`);
  assert.equal(info.pid, 85123);
  assert.equal(info.started, 'Wed Oct 21 21:58:18 2026');
  assertIdentity(info);
  for (const changed of [
    { ...info, pid: info.pid + 1 }, { ...info, started: 'Wed Oct 21 21:58:19 2026' },
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
    now: () => Date.parse('Wed Oct 21 21:58:30 2026'),
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
    now: () => Date.parse('Wed Oct 21 21:58:30 2026'),
  };
  await tick({ ...base, findProcesses: async () => [INFO], output: async () => '' });
  const firstRevision = previous.revision;
  supported = '[{"electron":"43.1.2"}]';
  const state = await tick({ ...base, findProcesses: async () => [INFO], output: async () => '' });
  assert.equal(installed, 2);
  assert.notEqual(state.revision, firstRevision);
});

test('a file failure during the switch restores the complete old deployment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kct-deploy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(dataDir));

  const oldFiles = new Map(CORE_FILES.map((name, index) => [name, Buffer.from(`old ${name} ${index}`)]));
  const newFiles = new Map(CORE_FILES.map((name, index) => [name, Buffer.from(`new ${name} ${index}`)]));
  for (const [name, bytes] of oldFiles) await writeFile(join(dataDir, name), bytes);
  const stage = await stageBundle(dataDir, newFiles);

  const { rename: realRename } = await import('node:fs/promises');
  let renamedIntoData = 0;
  const failOnInstalledFile = async (from, to) => {
    if (from.startsWith(stage) && to.startsWith(dataDir) && ++renamedIntoData === 3) {
      const error = new Error('simulated mid-switch failure');
      error.code = 'EIO';
      throw error;
    }
    return realRename(from, to);
  };

  await assert.rejects(
    switchBundle({ dataDir, stageDir: stage, renameFile: failOnInstalledFile }),
    /simulated mid-switch failure/,
  );
  assert.equal(renamedIntoData, 3);
  for (const [name, expected] of oldFiles) {
    assert.deepEqual(await readFile(join(dataDir, name)), expected, `${name} must be restored`);
  }

  await rm(stage, { recursive: true, force: true });
  const leftovers = await import('node:fs/promises').then(({ readdir }) => readdir(dataDir));
  assert.deepEqual(leftovers.sort(), [...CORE_FILES].sort());
  assert.deepEqual((await import('node:fs/promises')
    .then(({ readdir }) => readdir(root))).filter((name) => name.startsWith('.deploy')), []);
});

test('a failure while backing up leaves the old deployment intact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kct-backup-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const { mkdir, rename: realRename } = await import('node:fs/promises');
  await mkdir(dataDir);
  const oldFiles = new Map(CORE_FILES.map((name) => [name, Buffer.from(`old ${name}`)]));
  const newFiles = new Map(CORE_FILES.map((name) => [name, Buffer.from(`new ${name}`)]));
  for (const [name, bytes] of oldFiles) await writeFile(join(dataDir, name), bytes);
  const stage = await stageBundle(dataDir, newFiles);

  let moved = 0;
  const failDuringBackup = async (from, to) => {
    if (from.startsWith(dataDir) && to.includes('.deploy-backup-') && ++moved === 2) {
      throw new Error('backup failure');
    }
    return realRename(from, to);
  };
  await assert.rejects(
    switchBundle({ dataDir, stageDir: stage, renameFile: failDuringBackup }),
    /backup failure/,
  );
  for (const [name, expected] of oldFiles) {
    assert.deepEqual(await readFile(join(dataDir, name)), expected, `${name} must remain old`);
  }
  await rm(stage, { recursive: true, force: true });
  assert.deepEqual((await import('node:fs/promises')
    .then(({ readdir }) => readdir(root))).filter((name) => name.startsWith('.deploy')), []);
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
  await writeFile(join(dataDir, 'runtime-hook.mjs'), 'old hook');
  await writeFile(join(dataDir, 'supported-runtimes.json'), 'old runtimes');
  await writeFile(join(dataDir, 'kct.js'), 'old renderer');
  await writeFile(join(dataDir, 'runtime.mjs'), 'old loader');
  const files = new Map(CORE_FILES.map((name) => [name, Buffer.from(`new ${name}`)]));
  return { root, dataDir, plistPath, files };
}

const deployDeps = (fixture, calls, overrides = {}) => ({
  files: fixture.files,
  dataDir: fixture.dataDir,
  plistPath: fixture.plistPath,
  label: 'test.runtime',
  platformCheck: () => {},
  verify: async () => {},
  acquire: async () => ({ release: async () => {} }),
  run: async (_command, args) => {
    calls.push(args[0]);
    if (args[0] === 'print' && overrides.loadCheck) overrides.loadCheck();
    if (overrides.failWhen?.(args[0])) throw new Error(`${args[0]} failed`);
  },
});

test('a failed bootstrap restores the old plist and old bundle', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const oldPlist = '<plist>old node path</plist>';
  await writeFile(fixture.plistPath, oldPlist);
  const calls = [];
  await assert.rejects(deploy(deployDeps(fixture, calls, { failWhen: (verb) => verb === 'bootstrap' })),
    /bootstrap failed/);
  assert.equal(await readFile(fixture.plistPath, 'utf8'), oldPlist);
  assert.equal(await readFile(join(fixture.dataDir, 'runtime.mjs'), 'utf8'), 'old loader');
  assert.deepEqual(calls, ['print', 'bootout', 'bootstrap', 'bootstrap']);
});

test('a failed bootout does not switch files, and failed first install leaves no plist', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(fixture.plistPath, 'old plist');
  const calls = [];
  await assert.rejects(deploy(deployDeps(fixture, calls, { failWhen: (verb) => verb === 'bootout' })),
    /bootout failed/);
  assert.equal(await readFile(fixture.plistPath, 'utf8'), 'old plist');
  assert.equal(await readFile(join(fixture.dataDir, 'runtime.mjs'), 'utf8'), 'old loader');

  const fresh = await deployFixture();
  t.after(() => rm(fresh.root, { recursive: true, force: true }));
  const freshCalls = [];
  await assert.rejects(deploy(deployDeps(fresh, freshCalls,
    { failWhen: (verb) => verb === 'bootstrap' })), /bootstrap failed/);
  await assert.rejects(readFile(fresh.plistPath), { code: 'ENOENT' });
  assert.deepEqual(freshCalls, ['bootstrap']);
});

test('installation reports a busy shared lock instead of deploying', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kct-lock-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await mkdir(dataDir);
  const lock = join(dataDir, '.runtime-lock');
  await mkdir(lock);
  await writeFile(join(lock, 'pid'), String(process.pid));
  let commands = 0;
  const files = new Map(CORE_FILES.map((name) => [name, Buffer.from(`new ${name}`)]));
  await assert.rejects(deploy({
    files, dataDir, plistPath: join(root, 'runtime.plist'), label: 'test.runtime',
    platformCheck: () => {}, verify: async () => {},
    run: async () => { commands += 1; },
  }), /another runtime operation is in progress/);
  assert.equal(commands, 0);
});

test('a live lock PID is not reclaimed after sixty seconds', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kct-live-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await mkdir(dataDir);
  const lock = join(dataDir, '.runtime-lock');
  await mkdir(lock);
  await writeFile(join(lock, 'pid'), String(process.pid));
  const old = new Date(Date.now() - 120000);
  await import('node:fs/promises').then(({ utimes }) => utimes(lock, old, old));
  let commands = 0;
  const files = new Map(CORE_FILES.map((name) => [name, Buffer.from(`new ${name}`)]));
  await assert.rejects(deploy({
    files, dataDir, plistPath: join(root, 'runtime.plist'), label: 'test.runtime',
    platformCheck: () => {}, verify: async () => {},
    run: async () => { commands += 1; },
  }), /another runtime operation is in progress/);
  assert.equal(commands, 0);
  assert.equal(await readFile(join(lock, 'pid'), 'utf8'), String(process.pid));
});

test('a failed stage still releases the shared lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kct-stage-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await mkdir(dataDir);
  let released = 0;
  await assert.rejects(deploy({
    files: new Map([['x'.repeat(5000), Buffer.from('x')]]),
    dataDir, plistPath: join(root, 'runtime.plist'), label: 'test.runtime',
    platformCheck: () => {}, verify: async () => {},
    acquire: async () => ({ release: async () => { released += 1; } }),
  }), /name too long|ENAMETOOLONG/i);
  assert.equal(released, 1);
});

test('an existing plist with no loaded LaunchAgent job installs successfully', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(fixture.plistPath, 'old plist');
  const calls = [];
  await deploy(deployDeps(fixture, calls, {
    loadCheck: () => {
      const error = new Error('Could not find service "test.runtime" in domain for user');
      error.stderr = error.message;
      throw error;
    },
  }));
  assert.deepEqual(calls, ['print', 'bootstrap']);
  assert.match(await readFile(fixture.plistPath, 'utf8'), /new runtime\.mjs|runtime\.mjs/);
  assert.equal(await readFile(join(fixture.dataDir, 'runtime.mjs'), 'utf8'), 'new runtime.mjs');
  assert.deepEqual((await import('node:fs/promises')
    .then(({ readdir }) => readdir(fixture.dataDir))).filter((name) => name.startsWith('.deploy')), []);
});

test('a stage failure before plist handling preserves an existing plist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kct-stage-plist-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const plistPath = join(root, 'runtime.plist');
  await mkdir(dataDir);
  await writeFile(plistPath, 'existing plist');
  await assert.rejects(deploy({
    files: new Map([['x'.repeat(5000), Buffer.from('x')]]),
    dataDir, plistPath, label: 'test.runtime',
    platformCheck: () => {}, verify: async () => {},
    acquire: async () => ({ release: async () => {} }),
  }), /name too long|ENAMETOOLONG/i);
  assert.equal(await readFile(plistPath, 'utf8'), 'existing plist');
});

test('a bootout failure does not bootstrap an unchanged running job', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(fixture.plistPath, 'old plist');
  const calls = [];
  await assert.rejects(deploy(deployDeps(fixture, calls, {
    failWhen: (verb) => verb === 'bootout',
  })), /bootout failed/);
  assert.deepEqual(calls, ['print', 'bootout']);
});

test('a backup cleanup failure after bootstrap keeps the new deployment', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const calls = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  t.after(() => { console.warn = originalWarn; });
  await deploy({
    ...deployDeps(fixture, calls),
    commit: async () => { throw new Error('cleanup failed'); },
  });
  assert.equal(await readFile(join(fixture.dataDir, 'runtime.mjs'), 'utf8'), 'new runtime.mjs');
  assert.deepEqual(calls, ['bootstrap']);
  assert.match(warnings[0], /deployment backup cleanup failed/);
});

test('a failed plist restore keeps its backup and leaves the job stopped', async (t) => {
  const fixture = await deployFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(fixture.plistPath, 'original plist');
  const calls = [];
  await assert.rejects(deploy({
    ...deployDeps(fixture, calls),
    run: async (_command, args) => {
      calls.push(args[0]);
      if (args[0] === 'bootstrap') {
        await rm(fixture.plistPath);
        await mkdir(fixture.plistPath);
        throw new Error('bootstrap failed');
      }
    },
  }), (error) => error.message === 'bootstrap failed' && !!error.plistRestoreError);
  assert.equal(await readFile(join(fixture.dataDir, '.runtime-plist.backup'), 'utf8'), 'original plist');
  assert.deepEqual(calls, ['print', 'bootout', 'bootstrap']);
});
