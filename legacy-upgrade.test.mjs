// Upgrade tests that run the real v0.2.11 code as the entry point.
//
// The fixture in test-fixtures/legacy-v0.2.11/ is the byte-for-byte content of
// that release, so the old updater and the old deploy path decide what happens
// to an existing install — not a stand-in written to make the new code pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEGACY = join(HERE, 'test-fixtures/legacy-v0.2.11');
const LEGACY_FILES = ['runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs',
  'supported-runtimes.json', 'kct.js'];
const BUNDLE_FILES = [...LEGACY_FILES.slice(0, 3), 'runtime-launcher.mjs', ...LEGACY_FILES.slice(3)];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

const legacy = await import('./test-fixtures/legacy-v0.2.11/runtime.mjs');
const launcher = await import('./runtime-launcher.mjs');
const current = await import('./runtime.mjs');

const agent = (initial = true) => {
  let loaded = initial;
  const calls = [];
  const run = async (command, args) => {
    if (command === '/usr/bin/plutil') return JSON.stringify({ Label: 'test.runtime',
      ProgramArguments: [process.execPath, '', '--once'], RunAtLoad: true });
    calls.push(args[0]);
    if (args[0] === 'print') {
      if (!loaded) throw new Error('Could not find service test.runtime');
      return '';
    }
    if (args[0] === 'bootout') loaded = false;
    if (args[0] === 'bootstrap') loaded = true;
    return '';
  };
  return { calls, run, loaded: () => loaded };
};

// A v0.2.11 install on disk: five loose files, runtime-state.json, and the plist
// that release wrote — no versions/, no deployment.json, no launcher.
async function legacyInstall(t) {
  const root = await mkdtemp(join(tmpdir(), 'kct-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const plistPath = join(root, 'Library/LaunchAgents/test.runtime.plist');
  await mkdir(dataDir, { recursive: true });
  await mkdir(dirname(plistPath), { recursive: true });
  for (const name of LEGACY_FILES) {
    await writeFile(join(dataDir, name), await readFile(join(LEGACY, name)));
  }
  await writeFile(join(dataDir, 'runtime-state.json'),
    JSON.stringify({ status: 'active', loaded: 1, revision: 'old' }));
  await writeFile(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>test.runtime</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${join(dataDir, 'runtime.mjs')}</string><string>--once</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>\n`);
  return { root, dataDir, plistPath };
}

// The bundle a v0.3.0 release publishes, as the old updater would download it:
// the five names it knows, carrying the new bytes.
async function newBundle() {
  const files = new Map();
  for (const name of LEGACY_FILES) {
    files.set(name, await readFile(join(HERE, name)));
  }
  files.set('runtime-launcher.mjs', await readFile(join(HERE, 'runtime-launcher.mjs')));
  return files;
}

const legacyDeployDeps = (fixture, agentRun, files) => ({
  files, dataDir: fixture.dataDir, plistPath: fixture.plistPath, label: 'test.runtime',
  platformCheck: () => {}, verify: async () => {}, run: agentRun,
  acquire: async () => ({ release: async () => {} }), retryDelayMs: 0,
});

test('the v0.2.11 updater deploys only its five files and leaves no launcher', async (t) => {
  const fixture = await legacyInstall(t);
  const files = await newBundle();
  const legacyFiles = new Map(LEGACY_FILES.map((name) => [name, files.get(name)]));
  const a = agent();

  // Exactly what that release does when it sees a newer manifest.
  await legacy.deploy(legacyDeployDeps(fixture, a.run, legacyFiles));

  assert.equal(await readFile(join(fixture.dataDir, 'runtime-update.mjs'), 'utf8'),
    await readFile(join(HERE, 'runtime-update.mjs'), 'utf8'), 'the five files were replaced');
  assert.equal(existsSync(join(fixture.dataDir, 'runtime-launcher.mjs')), false,
    'the old updater never knew about the launcher');
  assert.equal(existsSync(join(fixture.dataDir, 'deployment.json')), false,
    'and never wrote a version pointer');
  assert.equal(existsSync(join(fixture.dataDir, 'versions')), false);
  const installed = await import(`./test-fixtures/legacy-v0.2.11/runtime-update.mjs?probe=${Date.now()}`);
  assert.equal(installed.RUNTIME_VERSION, '0.2.11');
  await assert.rejects(readFile(join(fixture.dataDir, 'runtime-launcher.mjs')), { code: 'ENOENT' });
  assert.deepEqual(a.calls, ['print', 'bootout', 'bootstrap'],
    'the old deploy path re-registers without confirming the registration');
  assert.equal(a.loaded(), true);
});

test('the half-migrated install is detected and repaired without touching launchd', async (t) => {
  const fixture = await legacyInstall(t);
  const files = await newBundle();
  const legacyFiles = new Map(LEGACY_FILES.map((name) => [name, files.get(name)]));
  await legacy.deploy(legacyDeployDeps(fixture, agent().run, legacyFiles));

  const detected = await launcher.detectLegacyInstall(fixture.dataDir);
  assert.ok(detected, 'five loose files without a pointer are a legacy layout');
  assert.equal(detected.isLauncher, false, 'the entry is the runtime, not a launcher');

  const manifest = { version: '0.3.0',
    base: 'https://raw.githubusercontent.com/wssz527/kimi-cot-translate/v0.3.0',
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])) };
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => manifest,
    arrayBuffer: async () => {
      const name = String(url).split('/').pop();
      if (name !== 'runtime-launcher.mjs') throw new Error(`unexpected download: ${url}`);
      return files.get(name).buffer.slice(files.get(name).byteOffset,
        files.get(name).byteOffset + files.get(name).byteLength);
    },
  });
  const migrated = await current.migrateLegacyInPlace({ dataDir: fixture.dataDir, fetchImpl });
  assert.equal(migrated.version, '0.3.0');

  const state = await launcher.readDeployment(fixture.dataDir);
  assert.equal(state.current, migrated.current);
  assert.equal(state.candidate, true, 'the new version is confirmed by the next launcher run');
  assert.equal(state.migratedFrom, 'legacy');
  await launcher.verifyVersion(fixture.dataDir, state.current);
  assert.equal(state.previous, null,
    'the old updater had already replaced every file, so there is no older code to roll back to');

  const entry = await readFile(join(fixture.dataDir, 'runtime.mjs'), 'utf8');
  assert.ok(entry.includes(launcher.ENTRY_MARKER), 'the stable entry is now the launcher');
  assert.equal(entry, files.get('runtime-launcher.mjs').toString(), 'and it is the new launcher');

  const installed = await readFile(join(fixture.dataDir, 'versions', state.current, 'runtime.mjs'), 'utf8');
  assert.equal(installed, (await readFile(join(HERE, 'runtime.mjs'))).toString(),
    'the stored bundle is the runtime the new manifest described');
});

test('a genuine v0.2.11 install is migrated with its old files kept for rollback', async (t) => {
  const fixture = await legacyInstall(t);
  const files = await newBundle();
  const a = agent(true);
  a.calls.length = 0;

  const before = await readFile(join(fixture.dataDir, 'runtime.mjs'));
  assert.equal(before.toString(), (await readFile(join(LEGACY, 'runtime.mjs'))).toString());

  const result = await launcher.stageLegacyMigration(fixture.dataDir, files);

  assert.notEqual(result.current, result.previous, 'the old bundle is kept as its own version');
  assert.equal((await readFile(join(fixture.dataDir, 'versions', result.previous, 'runtime.mjs'))).toString(),
    before.toString(), 'rollback lands on the code that was really installed');
  await launcher.verifyVersion(fixture.dataDir, result.current);
  await launcher.verifyVersion(fixture.dataDir, result.previous);

  const state = await launcher.readDeployment(fixture.dataDir);
  assert.equal(state.previous, result.previous);
  assert.equal(state.candidate, true);
  assert.deepEqual(a.calls, [], 'staging never runs launchctl, so a live job cannot unload itself');
});

test('the automatic update path stages a legacy install instead of booting the job out', async (t) => {
  const fixture = await legacyInstall(t);
  const files = await newBundle();
  const a = agent(true);
  a.calls.length = 0;

  await current.deploy({ files, dataDir: fixture.dataDir, plistPath: fixture.plistPath,
    label: 'test.runtime', platformCheck: () => {}, verify: async () => {}, run: a.run,
    allowMigration: false, acquire: async () => ({ release: async () => {} }) });

  assert.deepEqual(a.calls, ['print'], 'only a status probe; the running job is never unloaded');
  assert.equal(a.loaded(), true);

  const state = await launcher.readDeployment(fixture.dataDir);
  assert.equal(state.candidate, true);
  assert.ok(state.previous, 'a rollback target exists');
  await launcher.verifyVersion(fixture.dataDir, state.current);
  assert.ok((await readFile(join(fixture.dataDir, 'runtime.mjs'), 'utf8'))
    .includes(launcher.ENTRY_MARKER), 'the entry launchd already invokes becomes the launcher');

  const plist = await readFile(fixture.plistPath, 'utf8');
  assert.match(plist, /<key>StartInterval<\/key><integer>60<\/integer>/,
    'the upgraded plist gains the periodic fallback the old one lacked');
});

test('an explicit install migrates a legacy layout and re-registers the job', async (t) => {
  const fixture = await legacyInstall(t);
  const files = await newBundle();
  const a = agent(true);
  a.calls.length = 0;

  await current.deploy({ files, dataDir: fixture.dataDir, plistPath: fixture.plistPath,
    label: 'test.runtime', platformCheck: () => {}, verify: async () => {}, run: a.run,
    allowMigration: true, retryDelayMs: 0, acquire: async () => ({ release: async () => {} }) });

  assert.deepEqual(a.calls, ['print', 'bootout', 'bootstrap', 'print']);
  assert.equal(a.loaded(), true, 'the job is registered again after the migration');
  const state = await launcher.readDeployment(fixture.dataDir);
  assert.equal(state.candidate, true);
  assert.equal(existsSync(join(fixture.dataDir, '.migration.json')), false, 'the journal is cleared');
});

test('a failed explicit migration restores the v0.2.11 install and keeps it running', async (t) => {
  const fixture = await legacyInstall(t);
  const files = await newBundle();
  const before = {
    entry: await readFile(join(fixture.dataDir, 'runtime.mjs')),
    plist: await readFile(fixture.plistPath),
  };
  const a = agent(true);
  let bootstraps = 0;
  const run = async (command, args) => {
    if (args[0] === 'bootstrap' && ++bootstraps <= 2) throw new Error('bootstrap failed');
    return a.run(command, args);
  };
  a.calls.length = 0;

  await assert.rejects(current.deploy({ files, dataDir: fixture.dataDir, plistPath: fixture.plistPath,
    label: 'test.runtime', platformCheck: () => {}, verify: async () => {}, run,
    allowMigration: true, retryDelayMs: 0, acquire: async () => ({ release: async () => {} }) }),
  /bootstrap failed/);

  assert.deepEqual(await readFile(join(fixture.dataDir, 'runtime.mjs')), before.entry,
    'the old entry is back');
  assert.deepEqual(await readFile(fixture.plistPath), before.plist, 'the old plist is back');
  assert.equal(existsSync(join(fixture.dataDir, 'deployment.json')), false,
    'no pointer is left claiming a version that never started');
  assert.equal(a.loaded(), true, 'the v0.2.11 job is registered again');
});

test('diagnostics read a migrated install and report the pointer truthfully', async (t) => {
  const fixture = await legacyInstall(t);
  const files = await newBundle();
  await launcher.stageLegacyMigration(fixture.dataDir, files);
  const a = agent(true);
  await writeFile(fixture.plistPath, (await import('./runtime.mjs')).default
    ? await readFile(fixture.plistPath) : await readFile(fixture.plistPath));
  await current.deploy({ files, dataDir: fixture.dataDir, plistPath: fixture.plistPath,
    label: 'test.runtime', platformCheck: () => {}, verify: async () => {}, run: a.run,
    allowMigration: false, acquire: async () => ({ release: async () => {} }) }).catch(() => {});

  const state = await launcher.readDeployment(fixture.dataDir);
  const report = await current.doctor({ dataDir: fixture.dataDir, plistPath: fixture.plistPath,
    label: 'test.runtime', run: a.run, find: async () => [], stateReader: async () => ({}) });

  assert.equal(report.installation.status, 'complete');
  assert.equal(report.installation.current, state.current);
  assert.equal(report.installation.candidate, true,
    'a migrated install reports its pending confirmation instead of claiming health');
  assert.equal(report.process.status, 'not-running');
  assert.equal(report.page.status, 'unknown', 'no live page was read, so nothing is claimed');
});

test('a launcher entry with a missing pointer is adopted from its own files', async (t) => {
  const fixture = await legacyInstall(t);
  const files = await newBundle();
  // The interrupted shape: the entry was swapped and the launcher was written,
  // but the pointer write never landed.
  for (const name of LEGACY_FILES) await writeFile(join(fixture.dataDir, name), files.get(name));
  await writeFile(join(fixture.dataDir, 'runtime-launcher.mjs'), files.get('runtime-launcher.mjs'));
  await writeFile(join(fixture.dataDir, 'runtime.mjs'), files.get('runtime-launcher.mjs'));

  const detected = await launcher.detectLegacyInstall(fixture.dataDir);
  assert.equal(detected.isLauncher, true);

  const adopted = await current.migrateLegacyInPlace({ dataDir: fixture.dataDir });
  assert.equal(adopted.adopted, true);
  const state = await launcher.readDeployment(fixture.dataDir);
  await launcher.verifyVersion(fixture.dataDir, state.current);
  assert.ok((await readFile(join(fixture.dataDir, 'runtime.mjs'), 'utf8'))
    .includes(launcher.ENTRY_MARKER));
});

test('a migrated candidate that fails its first start falls back to v0.2.11', async (t) => {
  const fixture = await legacyInstall(t);
  const files = await newBundle();
  const legacyBytes = await readFile(join(LEGACY, 'runtime.mjs'));
  // The bundle that gets staged is the one whose start fails.
  files.set('runtime.mjs', Buffer.from('process.exitCode = 19;\n'));
  const result = await launcher.stageLegacyMigration(fixture.dataDir, files);
  assert.equal((await readFile(join(fixture.dataDir, 'versions', result.previous, 'runtime.mjs'))).toString(),
    legacyBytes.toString(), 'the v0.2.11 runtime is the rollback target');

  assert.equal(await launcher.launch(fixture.dataDir, ['--once']), 19);

  const rolledBack = await launcher.readDeployment(fixture.dataDir);
  assert.equal(rolledBack.current, result.previous);
  assert.equal(rolledBack.candidate, false);
  assert.equal(rolledBack.blocked.id, result.current);
  assert.equal((await readFile(join(fixture.dataDir, 'versions', rolledBack.current, 'runtime.mjs'))).toString(),
    legacyBytes.toString(), 'the v0.2.11 runtime is what the install falls back to');
  await launcher.verifyVersion(fixture.dataDir, rolledBack.current);
  const entry = await readFile(join(fixture.dataDir, 'runtime.mjs'), 'utf8');
  assert.ok(entry.includes(launcher.ENTRY_MARKER),
    'the stable entry stays the launcher so the rollback target keeps being launched');
});

test('a failed candidate with no older bundle runs the current one instead of stranding the install', async (t) => {
  const fixture = await legacyInstall(t);
  const files = await newBundle();
  files.set('runtime.mjs', Buffer.from('process.exitCode = 19;\n'));
  await launcher.stageLegacyMigration(fixture.dataDir, files);
  // Drop the rollback target: this is the shape the old updater leaves behind.
  const state = await launcher.readDeployment(fixture.dataDir);
  await launcher.atomicJSON(join(fixture.dataDir, 'deployment.json'),
    { ...state, previous: null });

  assert.equal(await launcher.launch(fixture.dataDir, ['--once']), 19);
  const after = await launcher.readDeployment(fixture.dataDir);
  assert.equal(after.candidate, false);
  assert.equal(after.degraded, true, 'the install is marked degraded instead of claiming health');
  assert.match(after.blocked.detail, /exited with code 19/);
  assert.equal(await readFile(join(fixture.dataDir, 'runtime.mjs'), 'utf8'),
    'process.exitCode = 19;\n', 'the stable entry runs the bundle directly, with no launcher in between');
});

test('the installed bundle still matches the published manifest after the repair', async (t) => {
  const fixture = await legacyInstall(t);
  const files = await newBundle();
  const legacyFiles = new Map(LEGACY_FILES.map((name) => [name, files.get(name)]));
  await legacy.deploy(legacyDeployDeps(fixture, agent().run, legacyFiles));
  const manifest = { version: '0.3.0',
    base: 'https://raw.githubusercontent.com/wssz527/kimi-cot-translate/v0.3.0',
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])) };
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => manifest,
    arrayBuffer: async () => {
      const bytes = files.get(String(url).split('/').pop());
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  });
  await current.migrateLegacyInPlace({ dataDir: fixture.dataDir, fetchImpl });

  const state = await launcher.readDeployment(fixture.dataDir);
  const dir = join(fixture.dataDir, 'versions', state.current);
  for (const name of BUNDLE_FILES) {
    assert.equal(hash(await readFile(join(dir, name))), manifest.files[name], name);
  }
  assert.ok(await stat(dir));
});

test('a candidate whose only page runs the old renderer is confirmed as stale, not healthy', async (t) => {
  const fixture = await legacyInstall(t);
  const files = await newBundle();
  // The new runtime attaches and installs the hook, but the open window still
  // runs the previous kct.js: it answers loaded while reporting another revision.
  files.set('runtime.mjs', Buffer.from(candidateScript({
    outcome: 'transient', status: 'active', liveVerified: true, loaded: 0,
    inspectorClosed: true, renderer: 'stale', pagesStale: 1, staleRevisions: ['old-rev'],
  })));
  const staged = await launcher.stageLegacyMigration(fixture.dataDir, files);
  let code = 0;
  for (let start = 1; start <= launcher.CANDIDATE_RENDERER_GRACE; start++) {
    code = await launcher.launch(fixture.dataDir, ['--once']);
    assert.equal(code, 0);
    const state = await launcher.readDeployment(fixture.dataDir);
    if (start < launcher.CANDIDATE_RENDERER_GRACE) {
      assert.equal(state.candidate, true, `start ${start} keeps waiting for the window`);
      assert.equal(state.healthyAt, undefined, 'a stale renderer never writes healthyAt');
    } else {
      assert.equal(state.candidate, false);
      assert.equal(state.rendererStale, true);
      assert.deepEqual(state.rendererRevisions, ['old-rev']);
      assert.ok(state.healthyAt, 'the runtime itself is confirmed, the renderer is recorded as stale');
      assert.match(state.detail, /--refresh/);
    }
  }
  assert.equal(staged.current, (await launcher.readDeployment(fixture.dataDir)).current);
});

test('a candidate that never verifies live is rolled back instead of confirmed', async (t) => {
  const fixture = await legacyInstall(t);
  const files = await newBundle();
  const legacyBytes = await readFile(join(LEGACY, 'runtime.mjs'));
  files.set('runtime.mjs', Buffer.from(candidateScript({
    outcome: 'transient', status: 'active', loaded: 1, inspectorClosed: true,
    liveVerified: false, detail: 'historical active record reused',
  })));
  const staged = await launcher.stageLegacyMigration(fixture.dataDir, files);
  await launcher.launch(fixture.dataDir, ['--once']);
  const after = await launcher.readDeployment(fixture.dataDir);
  assert.equal(after.current, staged.previous, 'the install falls back to what ran before');
  assert.equal(after.candidate, false);
  assert.equal(after.blocked.id, staged.current);
  assert.equal((await readFile(join(fixture.dataDir, 'versions', after.current, 'runtime.mjs'))).toString(),
    legacyBytes.toString());
});

test('a waiting candidate is never confirmed and never consumes a failure', async (t) => {
  const fixture = await legacyInstall(t);
  const files = await newBundle();
  files.set('runtime.mjs', Buffer.from(candidateScript({
    outcome: 'waiting', status: 'waiting', detail: 'Kimi Code is not running',
  })));
  const staged = await launcher.stageLegacyMigration(fixture.dataDir, files);
  for (let start = 0; start < 4; start++) {
    assert.equal(await launcher.launch(fixture.dataDir, ['--once']), 0);
    const state = await launcher.readDeployment(fixture.dataDir);
    assert.equal(state.current, staged.current);
    assert.equal(state.candidate, true);
    assert.equal(state.healthyAt, undefined);
    assert.equal(state.startAttempts, undefined, 'waiting is not a failed start');
  }
});

function candidateScript(result) {
  const fields = Object.entries(result)
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',');
  return `import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
await writeFile(join(here, '../../.last-run.json'),
  JSON.stringify({ id: process.env.KCT_LAUNCH_ID ?? null, ${fields} }));
`;
}
