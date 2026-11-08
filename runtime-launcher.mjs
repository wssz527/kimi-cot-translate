#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const BUNDLE_FILES = ['runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs',
  'runtime-launcher.mjs', 'supported-runtimes.json', 'kct.js'];
// The runtime mentions this signature in its own validation strings, so the
// marker has to include the parameter list to tell a launcher from a runtime.
export const ENTRY_MARKER = 'export async function launch(dataDir';
export const LEGACY_JOURNAL = '.legacy-migration.json';
const ID = /^[a-f0-9]{64}$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);
const bundlePath = (dataDir, id) => join(dataDir, 'versions', id);

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableWrite(file, bytes) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export async function atomicJSON(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.next`;
  try {
    await durableWrite(temp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temp, file);
    await syncDirectory(dirname(file));
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}

async function processStartedAt(pid) {
  try {
    const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='],
      { encoding: 'utf8', timeout: 5000 });
    const startedAt = Date.parse(stdout.trim());
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch { return null; }
}

export async function acquireLock(dataDir, { startedAt = processStartedAt } = {}) {
  const lock = join(dataDir, '.runtime-lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readFile(join(lock, 'owner.json'), 'utf8')
      .then(JSON.parse, () => null);
    if (owner && Number.isInteger(owner.pid) && owner.pid > 0 && Number.isFinite(owner.startedAt)) {
      try { process.kill(owner.pid, 0); }
      catch (probe) {
        if (probe.code === 'EPERM') return null;
        if (probe.code !== 'ESRCH') throw probe;
        await rm(lock, { recursive: true, force: true });
        return acquireLock(dataDir, { startedAt });
      }
      const actual = await startedAt(owner.pid);
      // An unverifiable owner is kept: never steal a lock on a transient ps failure.
      if (actual === null) return null;
      if (Math.abs(actual - owner.startedAt) <= 2000) return null;
      await rm(lock, { recursive: true, force: true });
      return acquireLock(dataDir, { startedAt });
    }
    const pidText = await readFile(join(lock, 'pid'), 'utf8').catch(() => '');
    const pid = Number(pidText);
    if (pidText.trim() && Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return null; }
      catch (probe) {
        if (probe.code === 'EPERM') return null;
        if (probe.code !== 'ESRCH') throw probe;
        await rm(lock, { recursive: true, force: true });
        return acquireLock(dataDir, { startedAt });
      }
    }
    if (Date.now() - (await stat(lock)).mtimeMs < 60000) return null;
    await rm(lock, { recursive: true, force: true });
    return acquireLock(dataDir, { startedAt });
  }
  try {
    const started = await startedAt(process.pid);
    await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
    if (started !== null) {
      await writeFile(join(lock, 'owner.json'),
        JSON.stringify({ pid: process.pid, startedAt: started, acquiredAt: new Date().toISOString() }),
        { mode: 0o600 });
    }
  } catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
  return { async release() { await rm(lock, { recursive: true, force: true }); } };
}

export async function readDeployment(dataDir) {
  const state = JSON.parse(await readFile(join(dataDir, 'deployment.json'), 'utf8'));
  if (!ID.test(state.current ?? '') || (state.previous && !ID.test(state.previous))) {
    throw new Error('Invalid runtime version pointer');
  }
  return state;
}

// A v0.2.x install keeps five loose files next to runtime-state.json and has no
// versions/ tree, no deployment.json and no launcher. Detecting that layout is
// what lets the update path migrate instead of writing a pointer the running
// entry cannot honour.
export async function detectLegacyInstall(dataDir) {
  const has = (name) => stat(join(dataDir, name)).then(() => true, () => false);
  if (await has('deployment.json')) return null;
  const present = [];
  for (const name of ['runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs',
    'supported-runtimes.json', 'kct.js']) {
    if (await has(name)) present.push(name);
  }
  if (present.length !== 5) return null;
  const entry = await readFile(join(dataDir, 'runtime.mjs'), 'utf8').catch(() => '');
  return { files: present, entry, isLauncher: entry.includes(ENTRY_MARKER) };
}

// Writes the new architecture without touching launchd: the five legacy files
// are stored as their own version so a rollback still has a runnable bundle, the
// new bundle is stored beside it, and only then is the pointer and the stable
// entry replaced. A caller inside the service can run this; the running job is
// never booted out from under itself.
export async function stageLegacyMigration(dataDir, files, { checkSyntax = true } = {}) {
  const legacy = new Map();
  for (const name of BUNDLE_FILES) {
    if (name === 'runtime-launcher.mjs') continue;
    const bytes = await readFile(join(dataDir, name)).catch(() => null);
    if (!bytes?.length) throw new Error(`Legacy runtime file is missing: ${name}`);
    legacy.set(name, bytes);
  }
  const launcher = files.get('runtime-launcher.mjs');
  if (!launcher?.length) throw new Error('Runtime bundle missing runtime-launcher.mjs');
  legacy.set('runtime-launcher.mjs', launcher);
  const legacyId = await storeVersion(dataDir, legacy, { checkSyntax: false });
  const nextId = await storeVersion(dataDir, files, { checkSyntax });
  // When the previous updater had already replaced all five files there is no
  // older code left to roll back to. Recording it as `previous` would make the
  // pointer describe a bundle that never ran, and a rollback would silently
  // land on the same bytes it just rejected.
  const previous = legacyId === nextId ? null : legacyId;
  await atomicJSON(join(dataDir, 'deployment.json'), {
    current: nextId, previous, candidate: true,
    migratedFrom: 'legacy', migratedAt: new Date().toISOString(),
  });
  await replaceEntry(join(dataDir, 'runtime.mjs'), launcher);
  return { current: nextId, previous, legacy: legacyId };
}

// The stable entry must always be the current version's launcher, except in
// degraded mode where there is no rollback target and the bundle runs directly.
export async function ensureStableEntry(dataDir) {
  const state = await recoverDeployment(dataDir);
  const dir = await verifyVersion(dataDir, state.current);
  const bytes = await readFile(join(dir, state.degraded ? 'runtime.mjs' : 'runtime-launcher.mjs'));
  const entry = join(dataDir, 'runtime.mjs');
  const current = await readFile(entry).catch(() => null);
  if (!current || !current.equals(bytes)) await replaceEntry(entry, bytes);
  return state;
}

async function degradeToStandalone(dataDir, state, detail) {
  const dir = await verifyVersion(dataDir, state.current).catch(() => null);
  if (!dir) return false;
  await atomicJSON(join(dataDir, 'deployment.json'), {
    current: state.current, previous: null, candidate: false, degraded: true,
    blocked: { id: state.current, detail, at: new Date().toISOString() },
    degradedAt: new Date().toISOString(),
  });
  await replaceEntry(join(dataDir, 'runtime.mjs'), await readFile(join(dir, 'runtime.mjs')));
  console.error(`[kct] no rollback target; the stable entry runs the bundle directly: ${detail}`);
  return true;
}

async function replaceEntry(file, bytes) {
  const temp = `${file}.${process.pid}.next`;
  try {
    const handle = await open(temp, 'w', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
    const directory = await open(dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}

export async function verifyVersion(dataDir, id) {
  if (!ID.test(id ?? '')) throw new Error('Invalid runtime version identifier');
  const dir = bundlePath(dataDir, id);
  const marker = JSON.parse(await readFile(join(dir, '.bundle.json'), 'utf8'));
  const hashes = {};
  for (const name of BUNDLE_FILES) {
    const bytes = await readFile(join(dir, name));
    hashes[name] = digest(bytes);
    if (!bytes.length || hashes[name] !== marker.files?.[name]) {
      throw new Error(`Runtime bundle integrity check failed: ${name}`);
    }
  }
  if (digest(JSON.stringify(hashes)) !== id) throw new Error('Runtime bundle identifier mismatch');
  return dir;
}

export async function recoverDeployment(dataDir) {
  let original, state;
  try {
    state = await readDeployment(dataDir);
    await verifyVersion(dataDir, state.current);
    return state;
  } catch (error) { original = error; }
  const blocked = state?.blocked?.id;
  const recoveredAt = new Date().toISOString();
  // The recorded previous version is the last one that completed a start.
  // Prefer it over a newer directory, which may be an orphaned staging attempt.
  if (state?.previous && state.previous !== blocked) {
    try {
      await verifyVersion(dataDir, state.previous);
      const recovered = { current: state.previous, previous: null, candidate: false,
        ...(blocked ? { blocked: state.blocked } : {}),
        recoveredAt, recoveryDetail: original.message };
      await atomicJSON(join(dataDir, 'deployment.json'), recovered);
      return recovered;
    } catch { /* fall through to the newest complete version */ }
  }
  const root = join(dataDir, 'versions');
  const candidates = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !ID.test(entry.name) || entry.name === blocked) continue;
    try {
      await verifyVersion(dataDir, entry.name);
      candidates.push({ id: entry.name, mtime: (await stat(join(root, entry.name))).mtimeMs });
    } catch { /* incomplete versions are never selected */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) throw original;
  const recovered = { current: candidates[0].id, previous: candidates[1]?.id ?? null,
    candidate: false, ...(blocked ? { blocked: state.blocked } : {}),
    recoveredAt, recoveryDetail: original.message };
  await atomicJSON(join(dataDir, 'deployment.json'), recovered);
  return recovered;
}

export async function storeVersion(dataDir, files, { checkSyntax = true } = {}) {
  const hashes = {};
  for (const name of BUNDLE_FILES) {
    const bytes = files.get(name);
    if (!bytes?.length) throw new Error(`Runtime bundle missing ${name}`);
    hashes[name] = digest(bytes);
  }
  const id = digest(JSON.stringify(hashes));
  const root = join(dataDir, 'versions');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(root, '.stage-'));
  try {
    for (const name of BUNDLE_FILES) await durableWrite(join(stage, name), files.get(name));
    const supported = JSON.parse(await readFile(join(stage, 'supported-runtimes.json'), 'utf8'));
    if (!Array.isArray(supported) || !supported.length || supported.some((item) =>
      typeof item?.electron !== 'string' || !ID.test(item?.sha256 ?? '')
        || typeof item.validatedWithApp !== 'string')) {
      throw new Error('supported-runtimes.json has an invalid runtime entry');
    }
    if (checkSyntax) {
      for (const name of BUNDLE_FILES.filter((file) => /\.(mjs|js)$/.test(file))) {
        await exec(process.execPath, ['--check', join(stage, name)], { timeout: 10000 });
      }
    }
    await durableWrite(join(stage, '.bundle.json'), `${JSON.stringify({ files: hashes })}\n`);
    await syncDirectory(stage);
    try {
      await rename(stage, bundlePath(dataDir, id));
      await syncDirectory(root);
    }
    catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    }
    await verifyVersion(dataDir, id);
    return id;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function switchVersion(dataDir, files, options = {}) {
  const current = await readDeployment(dataDir);
  const id = await storeVersion(dataDir, files, options);
  if (id === current.current) return { id, changed: false };
  if (id === current.blocked?.id) throw new Error(`Runtime update was previously rolled back: ${current.blocked.detail}`);
  if (current.candidate) throw new Error('A runtime update is awaiting its first successful start');
  await atomicJSON(join(dataDir, 'deployment.json'), {
    current: id, previous: current.current, candidate: true,
    changedAt: new Date().toISOString(), ...(current.blocked ? { blocked: current.blocked } : {}),
  });
  return { id, changed: true };
}

async function pruneVersions(dataDir, state) {
  const root = join(dataDir, 'versions');
  const keep = new Set([state.current, state.previous, state.blocked?.id].filter(Boolean));
  for (const name of await readdir(root)) {
    if (keep.has(name)) continue;
    await rm(join(root, name), { recursive: true, force: true });
  }
  await syncDirectory(root);
}

async function rollback(dataDir, state, detail) {
  if (!state.previous) {
    // Nothing older is installed: rolling back would be a no-op that leaves the
    // pointer claiming a healthy bundle. Run the current one directly instead so
    // translation keeps working, and record why the launcher stepped aside.
    if (await degradeToStandalone(dataDir, state, detail)) {
      return { ...state, candidate: false, degraded: true };
    }
    throw new Error(`No previous runtime is available: ${detail}`);
  }
  await verifyVersion(dataDir, state.previous);
  const next = { current: state.previous, previous: null, candidate: false,
    blocked: { id: state.current, detail, at: new Date().toISOString() },
    rolledBackAt: new Date().toISOString() };
  await atomicJSON(join(dataDir, 'deployment.json'), next);
  console.error(`[kct] runtime rolled back: ${detail}`);
  return next;
}

async function readRunResult(dataDir, runId) {
  try {
    const result = JSON.parse(await readFile(join(dataDir, '.last-run.json'), 'utf8'));
    return result?.id === runId ? result : null;
  } catch { return null; }
}

function classifyLaunch(result, code) {
  if (code !== 0) return result?.failureKind === 'permanent' ? 'incompatible' : 'failed';
  if (!result) return 'failed';
  if (!['success', 'waiting', 'transient', 'failed', 'incompatible'].includes(result.outcome)) return 'failed';
  // A run that calls itself active without having verified anything this start
  // is describing history, not this bundle. Retrying would repeat the same
  // non-answer, so it counts as a failure.
  if (result.outcome === 'transient' && result.status === 'active' && result.liveVerified !== true) {
    return 'failed';
  }
  return result.outcome;
}

// A candidate is confirmed only by a run that attached to the live process and
// read the page back. `renderer: 'stale'` means the hook is installed but no
// page runs this revision yet — the new bundle works, the open window still
// carries the previous kct.js. Reloading it is the user's call (--refresh), so
// after a bounded number of starts the candidate is accepted with that fact
// recorded instead of leaving the pointer pending forever.
export const CANDIDATE_RENDERER_GRACE = 3;
// Environmental waits (Kimi not running, inspector busy) are retried, but not
// forever: a candidate that never gets a clean start must not stay pending.
export const CANDIDATE_START_LIMIT = 12;

export async function launch(dataDir, args = process.argv.slice(2)) {
  let lock = await acquireLock(dataDir);
  if (!lock) return 0;
  let state;
  try {
    state = await recoverDeployment(dataDir);
    try { await verifyVersion(dataDir, state.current); }
    catch (error) { state = await rollback(dataDir, state, error.message); }
    await ensureStableEntry(dataDir).catch((error) => {
      console.error(`[kct] stable entry could not be repaired: ${error.message}`);
    });
  } finally { await lock.release(); }
  const id = state.current;
  const runId = randomUUID();
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, [join(bundlePath(dataDir, id), 'runtime.mjs'), ...args],
      { stdio: 'inherit',
        env: { ...process.env, KCT_LAUNCH_ID: runId, ...(state.candidate ? { KCT_CANDIDATE_ID: id } : {}) } });
    child.once('error', () => done(1));
    child.once('exit', (status, signal) => done(signal ? 1 : status ?? 1));
  });
  if (args[0] !== '--once' || !state.candidate || code === 75) return code === 75 ? 0 : code;
  const result = await readRunResult(dataDir, runId);
  const outcome = classifyLaunch(result, code);
  lock = await acquireLock(dataDir);
  if (!lock) return code;
  try {
    const latest = await readDeployment(dataDir);
    if (latest.current !== id || !latest.candidate) return code;
    if (outcome === 'waiting') return code;
    if (outcome === 'transient') {
      const attempts = (latest.startAttempts ?? 0) + 1;
      if (attempts > CANDIDATE_START_LIMIT) {
        await rollback(dataDir, latest,
          result?.detail ?? `candidate did not confirm injection after ${attempts} starts`);
        return code;
      }
      if (result?.renderer === 'stale' && attempts >= CANDIDATE_RENDERER_GRACE) {
        const degraded = { ...latest, candidate: false, healthyAt: new Date().toISOString(),
          rendererStale: true, rendererRevisions: result.staleRevisions ?? [],
          detail: 'Hook installed; the open window still runs the previous renderer (run --refresh)' };
        delete degraded.startAttempts;
        await atomicJSON(join(dataDir, 'deployment.json'), degraded);
        await pruneVersions(dataDir, degraded);
        return 0;
      }
      await atomicJSON(join(dataDir, 'deployment.json'), { ...latest, startAttempts: attempts });
      return code;
    }
    if (outcome === 'success') {
      const healthy = { ...latest, candidate: false, healthyAt: new Date().toISOString(),
        ...(result?.renderer === 'stale' ? { rendererStale: true } : {}) };
      delete healthy.startAttempts;
      await atomicJSON(join(dataDir, 'deployment.json'), healthy);
      await pruneVersions(dataDir, healthy);
      return 0;
    }
    await rollback(dataDir, latest,
      result?.detail ?? (code !== 0
        ? `new runtime exited with code ${code}`
        : `candidate did not confirm injection (${outcome})`));
    return code;
  } finally { await lock.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launch(dirname(fileURLToPath(import.meta.url))).then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(`[kct] launcher: ${error.message}`); process.exitCode = 1; });
}
