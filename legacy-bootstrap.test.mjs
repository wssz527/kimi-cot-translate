// The real entry point for a v0.2.11 -> v0.3.0 upgrade.
//
// A legacy install has five loose files and no runtime-launcher.mjs. The v0.2.x
// updater never fetched the launcher, so the new runtime.mjs can end up as the
// entry of a directory where its own dependency does not exist. This test copies
// exactly that shape into an isolated directory and starts the migration from
// the copy inside it, so module resolution is the one a real user hits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
// The five names the v0.2.x updater deploys. The launcher is deliberately absent.
const LEGACY_FILES = ['runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs',
  'supported-runtimes.json', 'kct.js'];

async function isolatedInstall(t) {
  const root = await mkdtemp(join(tmpdir(), 'kct-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const files = new Map();
  for (const name of LEGACY_FILES) {
    const bytes = await readFile(join(HERE, name));
    await writeFile(join(dataDir, name), bytes);
    files.set(name, bytes);
  }
  files.set('runtime-launcher.mjs', await readFile(join(HERE, 'runtime-launcher.mjs')));
  return { root, dataDir, files };
}

function manifestFor(files) {
  return {
    version: '0.3.0',
    base: 'https://raw.githubusercontent.com/wssz527/kimi-cot-translate/v0.3.0',
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])),
  };
}

// Serves the manifest and the launcher from memory. Any other name is a test bug.
function localFetch(files, { onLauncher } = {}) {
  const manifest = manifestFor(files);
  const requested = [];
  const fetchImpl = async (url) => {
    const name = String(url).split('/').pop();
    requested.push(name);
    if (name === 'runtime-manifest.json') {
      return { ok: true, json: async () => manifest };
    }
    if (name !== 'runtime-launcher.mjs') throw new Error(`unexpected download: ${name}`);
    // A non-ok response is what fetchWithMirrors retries on; throwing from inside
    // the stub would be swallowed by the mirror fallback instead.
    if (onLauncher?.()) return { ok: false, status: 503 };
    const bytes = files.get(name);
    return {
      ok: true,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  return { fetchImpl, requested };
}

test('a five-file install boots its own migration with no launcher on disk', async (t) => {
  const { dataDir, files } = await isolatedInstall(t);

  // The shape a real user is left with after the v0.2.x updater ran.
  assert.equal(existsSync(join(dataDir, 'runtime-launcher.mjs')), false, 'no launcher yet');
  assert.equal(existsSync(join(dataDir, 'deployment.json')), false, 'no pointer yet');
  assert.equal(existsSync(join(dataDir, 'versions')), false, 'no version tree yet');

  // Import the copy inside the isolated directory: its own relative import of
  // ./runtime-launcher.mjs is the one that used to fail.
  const entry = pathToFileURL(join(dataDir, 'runtime.mjs')).href;
  const runtime = await import(entry);
  assert.equal(typeof runtime.migrateLegacyInPlace, 'function');

  const { fetchImpl, requested } = localFetch(files);
  const result = await runtime.migrateLegacyInPlace({ dataDir, fetchImpl });

  assert.ok(result, 'the legacy layout is recognised without importing the launcher');
  assert.equal(result.version, '0.3.0');
  assert.deepEqual(requested, ['runtime-manifest.json', 'runtime-launcher.mjs'],
    'only the manifest and the missing launcher are fetched');

  // The launcher landed and matches the published hash.
  const installed = await readFile(join(dataDir, 'runtime-launcher.mjs'));
  assert.equal(hash(installed), manifestFor(files).files['runtime-launcher.mjs']);

  // Pointer and version tree agree with the bytes on disk.
  const { readDeployment, verifyVersion } = await import('./runtime-launcher.mjs');
  const state = await readDeployment(dataDir);
  assert.equal(state.current, result.current);
  assert.equal(state.candidate, true, 'the next launcher run confirms the version');
  assert.equal(state.migratedFrom, 'legacy');
  await verifyVersion(dataDir, state.current);
  const versions = await readdir(join(dataDir, 'versions'));
  assert.ok(versions.includes(state.current));
  for (const name of ['runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs',
    'runtime-launcher.mjs', 'supported-runtimes.json', 'kct.js']) {
    assert.equal(hash(await readFile(join(dataDir, 'versions', state.current, name))),
      manifestFor(files).files[name], name);
  }

  // The stable entry the LaunchAgent already invokes is now the launcher. A
  // fresh process is what a job trigger gets, so the check is on the file.
  const entrySource = await readFile(join(dataDir, 'runtime.mjs'), 'utf8');
  assert.equal(entrySource, files.get('runtime-launcher.mjs').toString(),
    'the next start runs the launcher, not the runtime');
  assert.match(entrySource, /export async function launch\(/);
});

test('a second start finds nothing to migrate', async (t) => {
  const { dataDir, files } = await isolatedInstall(t);
  const runtime = await import(pathToFileURL(join(dataDir, 'runtime.mjs')).href);
  await runtime.migrateLegacyInPlace({ dataDir, fetchImpl: localFetch(files).fetchImpl });

  // A fresh process sees the launcher as its entry, so the legacy path is gone.
  const next = await import(`./runtime-launcher.mjs?probe=${Date.now()}`);
  assert.equal(await next.detectLegacyInstall(dataDir), null,
    'a migrated install is no longer a legacy layout');
  assert.equal(typeof runtime.migrateLegacyInPlace({ dataDir }), 'object');
});

test('a failed launcher download leaves the five-file install runnable', async (t) => {
  const { dataDir } = await isolatedInstall(t);
  const runtime = await import(pathToFileURL(join(dataDir, 'runtime.mjs')).href);
  const before = new Map();
  for (const name of LEGACY_FILES) before.set(name, await readFile(join(dataDir, name)));

  const offline = async () => { throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com'); };
  await assert.rejects(runtime.migrateLegacyInPlace({ dataDir, fetchImpl: offline }), /ENOTFOUND/);

  for (const name of LEGACY_FILES) {
    assert.deepEqual(await readFile(join(dataDir, name)), before.get(name),
      `${name} is untouched, so the old entry still runs`);
  }
  assert.equal(existsSync(join(dataDir, 'runtime-launcher.mjs')), false,
    'no half-written launcher is left behind');
  assert.equal(existsSync(join(dataDir, 'deployment.json')), false,
    'no pointer claims a version that was never installed');
});

test('a retry after a transient failure completes the migration', async (t) => {
  const { dataDir, files } = await isolatedInstall(t);
  const runtime = await import(pathToFileURL(join(dataDir, 'runtime.mjs')).href);
  // downloadBundle falls back to a mirror, so an outage has to fail every
  // attempt of the first run, not just the first one.
  let offline = true;
  const flaky = localFetch(files, { onLauncher: () => offline });
  await assert.rejects(runtime.migrateLegacyInPlace({ dataDir, fetchImpl: flaky.fetchImpl }), /503/);
  assert.equal(existsSync(join(dataDir, 'deployment.json')), false);
  assert.equal(existsSync(join(dataDir, 'runtime-launcher.mjs')), false,
    'a failed download writes nothing');

  offline = false;
  const retry = await runtime.migrateLegacyInPlace({ dataDir, fetchImpl: localFetch(files).fetchImpl });
  assert.ok(retry, 'the next start retries and succeeds');
  const { readDeployment, verifyVersion } = await import('./runtime-launcher.mjs');
  const state = await readDeployment(dataDir);
  await verifyVersion(dataDir, state.current);
});

test('a tampered local file blocks the migration instead of guessing', async (t) => {
  const { dataDir, files } = await isolatedInstall(t);
  await writeFile(join(dataDir, 'kct.js'), 'window.__kct = { tampered: true };\n');
  const runtime = await import(pathToFileURL(join(dataDir, 'runtime.mjs')).href);
  await assert.rejects(runtime.migrateLegacyInPlace({ dataDir, fetchImpl: localFetch(files).fetchImpl }),
    /kct\.js does not match v0\.3\.0/);
  assert.equal(existsSync(join(dataDir, 'deployment.json')), false);
  assert.equal(existsSync(join(dataDir, 'runtime-launcher.mjs')), false,
    'the launcher is only written after every local file checks out');
});
