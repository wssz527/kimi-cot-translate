#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { assertRendererContract, inspectFuses, installIntoProcess, portOpen, stageBundle } from './runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SIGNER = 'F754CEE9121450C6CD50EE89D1CD9E692FE1CA40';
const TASK = 'KimiCoTTranslate-Windows';
const FILES = ['runtime-windows.mjs', 'runtime.mjs', 'runtime-hook.mjs',
  'windows-bridge.ps1', 'supported-windows-runtimes.json', 'kct.js'];
const BUNDLE_MARKER = '.kct-windows-bundle.json';
const normalized = (value) => win32.resolve(value).toLowerCase();
const fingerprint = async (file) => {
  const s = await stat(file, { bigint: true });
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
};

export function windowsPaths({
  localAppData = process.env.LOCALAPPDATA, appDir, dataDir = process.env.KCT_WINDOWS_DATA_DIR,
} = {}) {
  if (!localAppData || !win32.isAbsolute(localAppData)) throw new Error('LOCALAPPDATA must be absolute');
  const standard = win32.join(localAppData, 'Programs', 'Kimi Code');
  if (appDir && normalized(appDir) !== normalized(standard)) {
    throw new Error('Only LOCALAPPDATA\\Programs\\Kimi Code is supported');
  }
  return {
    appDir: standard, executable: win32.join(standard, 'Kimi Code.exe'),
    dataDir: dataDir ?? win32.join(localAppData, 'kimi-cot-translate', 'windows'),
  };
}

export function assertPlatform({
  platform = process.platform, arch = process.arch, nodeVersion = process.versions.node,
  electronVersion = process.versions.electron,
} = {}) {
  if (platform !== 'win32' || arch !== 'x64' || !/^24\./.test(nodeVersion) || electronVersion) {
    throw new Error('Windows runtime requires Windows x64 and standalone Node 24 x64');
  }
}

export function bridgeRequest(action, request = {}, options = {}) {
  return {
    command: win32.join(process.env.SystemRoot ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(options.bundleDir ?? HERE, 'windows-bridge.ps1'), '-Action', action],
    options: {
      encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024,
      env: { ...process.env, ...(options.localAppData ? { LOCALAPPDATA: options.localAppData } : {}),
        KCT_WINDOWS_REQUEST: JSON.stringify(request) },
    },
  };
}

export async function bridge(action, request = {}, options = {}) {
  const command = bridgeRequest(action, request, options);
  const { stdout } = await (options.execFile ?? run)(command.command, command.args, command.options);
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

function callBridge(options, action, request = {}) {
  return (options.bridge ?? bridge)(action, request, options);
}

// Windows command lines quote backslashes differently from a shell.
export function commandLineArgs(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Missing process command line');
  const args = [];
  let word = '', quoted = false, started = false;
  for (let i = 0; i < text.length; i++) {
    if (!quoted && /\s/.test(text[i])) {
      if (started) args.push(word);
      word = ''; started = false;
      continue;
    }
    started = true;
    let slashes = 0;
    while (text[i] === '\\') { slashes++; i++; }
    if (text[i] === '"') {
      word += '\\'.repeat(Math.floor(slashes / 2));
      if (slashes % 2) word += '"';
      else if (quoted && text[i + 1] === '"') { word += '"'; i++; }
      else quoted = !quoted;
    } else {
      word += '\\'.repeat(slashes);
      if (i < text.length && !quoted && /\s/.test(text[i])) {
        args.push(word);
        word = '';
        started = false;
      } else if (i < text.length) word += text[i];
    }
  }
  if (quoted) throw new Error('Unterminated process command line');
  if (started) args.push(word);
  return args;
}

export function selectProcesses(snapshot, options = {}) {
  const { executable } = windowsPaths(options);
  if (!/^S-1-\d+(?:-\d+)+$/.test(snapshot?.sid ?? '') || !Array.isArray(snapshot.processes)) {
    throw new Error('Cannot establish the current Windows user');
  }
  const found = [];
  for (const info of snapshot.processes) {
    if (!info.ownerSid) throw new Error('Cannot establish Kimi process ownership');
    if (info.ownerSid !== snapshot.sid) continue;
    const args = commandLineArgs(info.commandLine);
    if (args.slice(1).some((arg) => /^--?type(?:=|$)/i.test(arg))) continue;
    if (!Number.isSafeInteger(info.pid) || info.pid <= 0
      || !Number.isFinite(Date.parse(info.started))
      || !info.executable || normalized(info.executable) !== normalized(executable)
      || normalized(args[0]) !== normalized(executable)) {
      throw new Error('Kimi main process is not the standard current-user installation');
    }
    if (args.slice(1).some((arg) =>
      /^--?(?:inspect|debug|remote-debugging|user-data-dir|user-data-path|session-data-dir|profile|guest|incognito)(?:[-=]|$)/i.test(arg))) {
      throw new Error('A debugging or alternate-profile Kimi instance is running');
    }
    found.push({ pid: info.pid, started: info.started, ownerSid: info.ownerSid,
      executable: info.executable, commandLine: info.commandLine });
  }
  return found;
}

export async function findProcesses(options = {}) {
  return selectProcesses(await callBridge(options, 'Discover'), options);
}

export function assertIdentity(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Kimi process identity changed; no trigger sent');
  }
}

export function verifyBinary(binary, signature, supported) {
  if (signature?.status !== 'Valid' || signature.thumbprint?.toUpperCase() !== SIGNER) {
    throw new Error('Kimi does not have the expected valid official Authenticode signature');
  }
  if (!Array.isArray(supported) || !supported.length || supported.some((entry) =>
    !/^[a-f0-9]{64}$/.test(entry?.sha256 ?? '') || !Number.isSafeInteger(entry.size)
      || entry.electron !== '43.1.1' || entry.appVersion !== '1.1.1'
      || entry.signerThumbprint !== SIGNER)) {
    throw new Error('Invalid Windows runtime allowlist');
  }
  const sha256 = hash(binary);
  const runtime = supported.find((entry) => entry.sha256 === sha256 && entry.size === binary.length);
  if (!runtime) throw new Error('Unknown Windows EXE hash; Kimi is left untouched');
  const pe = binary.length >= 64 ? binary.readUInt32LE(0x3c) : -1;
  if (binary.toString('ascii', 0, 2) !== 'MZ' || pe < 0 || pe + 6 > binary.length
    || binary.toString('ascii', pe, pe + 4) !== 'PE\0\0' || binary.readUInt16LE(pe + 4) !== 0x8664) {
    throw new Error('Expected a Windows PE x64 executable');
  }
  inspectFuses(binary);
  const version = Buffer.from(`Electron/${runtime.electron}`);
  const at = binary.indexOf(version);
  if (at < 0 || /[0-9.]/.test(String.fromCharCode(binary[at + version.length] ?? 0))) {
    throw new Error('Expected Electron/43.1.1 in the verified executable');
  }
  return { ...runtime, sha256 };
}

export async function verifyApp(options = {}) {
  const { appDir, executable } = windowsPaths(options);
  const read = options.readFile ?? readFile;
  const identifyFile = options.fingerprint ?? fingerprint;
  const before = await identifyFile(executable);
  const signature = await callBridge(options, 'Signature', { executable });
  const supported = JSON.parse(await read(join(options.bundleDir ?? HERE, 'supported-windows-runtimes.json'), 'utf8'));
  const runtime = verifyBinary(await read(executable), signature, supported);
  const dist = win32.join(appDir, 'resources', 'desktop-dist');
  const index = await read(win32.join(dist, 'index.html'), 'utf8');
  const assets = [...index.matchAll(/href="(\/assets\/[A-Za-z0-9_-]+\.css)"/g)].map((item) => item[1]);
  if (!assets.length) throw new Error('Cannot find Kimi renderer styles');
  assertRendererContract((await Promise.all(assets.map((name) =>
    read(win32.join(dist, ...name.slice(1).split('/')), 'utf8')))).join('\n'));
  if (before !== await identifyFile(executable)) throw new Error('Kimi changed during verification');
  return { version: runtime.appVersion, electron: runtime.electron, sha256: runtime.sha256, executable: before };
}

export async function triggerInspector(info, {
  execFile = run, timeout = 5000, platformCheck = assertPlatform,
} = {}) {
  if (!Number.isSafeInteger(info.pid) || info.pid <= 0) throw new Error('Invalid target PID');
  platformCheck();
  try {
    await execFile(process.execPath, ['--input-type=commonjs', '-e',
      'const pid=Number(process.argv[1]);if(!Number.isSafeInteger(pid)||pid<=0)throw Error("Invalid PID");process._debugProcess(pid);',
      String(info.pid)], { timeout, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 65536,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
  } catch (error) {
    if (error.killed || error.code === 'ETIMEDOUT') {
      throw new Error('Windows inspector helper timed out; no automatic retry', { cause: error });
    }
    throw error;
  }
}

export function inspectorOperations(options = {}) {
  const checkIdentity = async (expected) => {
    const found = await (options.findProcesses ?? findProcesses)(options);
    if (found.length !== 1) throw new Error('Kimi main process is no longer unique');
    assertIdentity(found[0], expected);
  };
  return {
    checkIdentity,
    verifyLiveProcess: async (info, app) => {
      await checkIdentity(info);
      if (await (options.fingerprint ?? fingerprint)(windowsPaths(options).executable) !== app.executable) {
        throw new Error('Kimi executable changed during attachment');
      }
    },
    triggerInspector: async (info) => {
      await checkIdentity(info);
      await (options.triggerInspector ?? triggerInspector)(info, options);
    },
    verifyPortOwner: async (info) => {
      await checkIdentity(info);
      const listeners = await callBridge(options, 'PortOwner', { port: 9229 });
      if (!Array.isArray(listeners) || !listeners.length || listeners.some((listener) =>
        listener.pid !== info.pid || listener.address !== '127.0.0.1')) {
        throw new Error('Inspector socket is not owned exclusively by the expected Kimi process');
      }
    },
  };
}

async function readJSON(file, missing = {}) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return missing; throw error; }
}

async function atomicJSON(file, value) {
  const next = `${file}.${randomUUID()}.next`;
  try {
    await writeFile(next, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(next, file);
  } finally { await rm(next, { force: true }); }
}

export async function readState(options = {}) {
  return readJSON(join(windowsPaths(options).dataDir, 'runtime-state.json'));
}

export async function tick(options = {}) {
  const paths = windowsPaths(options);
  const read = options.readFile ?? readFile;
  const save = options.saveState ?? (async (state) => {
    await mkdir(paths.dataDir, { recursive: true });
    await atomicJSON(join(paths.dataDir, 'runtime-state.json'), state);
  });
  const previous = await (options.readState ?? readState)(options);
  const attempt = previous.identity ? previous : previous.attempt;
  const checkedAt = new Date((options.now ?? Date.now)()).toISOString();
  const waiting = async (detail) => {
    const state = { status: 'waiting', detail, checkedAt, ...(attempt ? { attempt } : {}) };
    await save(state);
    return state;
  };
  let info, revision, identity;
  try {
    const found = await (options.findProcesses ?? findProcesses)(options);
    if (!found.length) return waiting('Kimi Code is not running');
    if (found.length !== 1) return waiting('Multiple Kimi main processes; waiting for one');
    info = found[0];
    const bundle = options.bundleDir ?? HERE;
    const bytes = await Promise.all(FILES.map((name) => read(join(bundle, name))));
    revision = hash(Buffer.concat(bytes.map((value, i) =>
      Buffer.concat([Buffer.from(`${FILES[i]}\0${Buffer.byteLength(value)}\0`), Buffer.from(value)]))));
    const source = Buffer.from(bytes[FILES.indexOf('kct.js')]).toString('utf8');
    identity = `${info.pid}:${info.started}`;
    if (attempt?.identity === identity && attempt.revision === revision) {
      const state = { ...attempt, checkedAt };
      if (state.status === 'checking') {
        state.status = 'error';
        state.detail = 'Previous attempt was interrupted; no automatic retry for this process and revision';
      }
      await save(state);
      return state;
    }
    if ((options.now ?? Date.now)() - Date.parse(info.started) < 5000) return waiting('Kimi is starting');
    const app = await (options.verifyApp ?? verifyApp)(options);
    if (await (options.portOpen ?? portOpen)()) return waiting('Inspector port 9229 is occupied; no trigger sent');
    const state = { identity, revision, pid: info.pid, status: 'checking', checkedAt, appVersion: app.version };
    // Persist before the trigger: a crash or helper timeout must not cause a second signal.
    await save(state);
    try {
      const result = await (options.installIntoProcess ?? installIntoProcess)(
        info, app, source, revision, inspectorOperations(options));
      state.status = 'active';
      state.loaded = result.loaded;
      state.inspectorClosed = true;
    } catch (error) {
      state.status = error.inspectorOpen ? 'blocked-inspector' : 'error';
      state.detail = error.message;
    }
    await save(state);
    return state;
  } catch (error) {
    const state = { status: 'error', detail: error.message, checkedAt,
      ...(identity && revision ? { identity, revision, pid: info.pid } : {}),
      ...(attempt ? { attempt } : {}) };
    await save(state);
    return state;
  }
}

export async function acquireLock(dataDir, name = '.runtime-lock') {
  const lock = join(dataDir, name);
  await mkdir(dataDir, { recursive: true });
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const reclaim = `${lock}.reclaim`;
    try { await mkdir(reclaim); }
    catch (failure) { if (failure.code === 'EEXIST') return null; throw failure; }
    try {
      const owner = await readJSON(join(lock, 'owner.json'), null);
      if (owner?.pid) {
        try { process.kill(owner.pid, 0); return null; }
        catch (failure) {
          if (failure.code === 'EPERM') return null;
          if (failure.code !== 'ESRCH') throw failure;
        }
      } else {
        try { if (Date.now() - (await stat(lock)).mtimeMs < 60000) return null; }
        catch (failure) { if (failure.code === 'ENOENT') return null; throw failure; }
      }
      await rm(lock, { recursive: true });
      try { await mkdir(lock); }
      catch (failure) { if (failure.code === 'EEXIST') return null; throw failure; }
    } finally { await rm(reclaim, { recursive: true, force: true }); }
  }
  try { await atomicJSON(join(lock, 'owner.json'), { pid: process.pid }); }
  catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
  return { release: () => rm(lock, { recursive: true, force: true }) };
}

async function stopped(dataDir) {
  return stat(join(dataDir, 'stop')).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

export async function watch(options = {}) {
  const { dataDir } = windowsPaths(options);
  const lock = await acquireLock(dataDir);
  if (!lock) return { status: 'busy' };
  const entry = join(options.bundleDir ?? HERE, 'runtime-windows.mjs');
  try {
    if (await stopped(dataDir)) return { status: 'disabled' };
    let enabled = await readJSON(join(dataDir, 'enabled.json'), null);
    if (!enabled) {
      enabled = { entry, generation: randomUUID() };
      await atomicJSON(join(dataDir, 'enabled.json'), enabled);
    }
    if (enabled.entry !== entry) return { status: 'disabled' };
    let nextTick = 0;
    while (!await stopped(dataDir)) {
      const current = await readJSON(join(dataDir, 'enabled.json'), null);
      if (current?.generation !== enabled.generation || current.entry !== entry) break;
      if (Date.now() >= nextTick) {
        await (options.tick ?? tick)(options);
        nextTick = Date.now() + 10000;
      }
      await (options.sleep ?? sleep)(1000);
    }
    return { status: 'disabled' };
  } finally { await lock.release(); }
}

function taskName(options) {
  return `${TASK}-${hash(normalized(windowsPaths(options).dataDir)).slice(0, 12)}`;
}

export function taskRequest(bundleDir, nodePath = process.execPath, dataDir, name = TASK) {
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const script = `& ${quote(join(bundleDir, 'windows-bridge.ps1'))} -Action Watch -NodePath ${quote(nodePath)} -RuntimePath ${quote(join(bundleDir, 'runtime-windows.mjs'))}${dataDir ? ` -DataDir ${quote(dataDir)}` : ''}; exit $LASTEXITCODE`;
  return { taskName: name,
    arguments: `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}` };
}

async function pruneBundles(dataDir, current, previousEntry) {
  const owned = [];
  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^bundle-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry.name)) continue;
    const dir = join(dataDir, entry.name);
    let marker;
    try { marker = await readJSON(join(dir, BUNDLE_MARKER), null); }
    catch { continue; }
    if (marker?.owner !== 'kimi-cot-translate/windows' || marker.bundle !== entry.name
      || typeof marker.dataDir !== 'string' || normalized(marker.dataDir) !== normalized(resolve(dataDir))) continue;
    let complete = true;
    for (const file of FILES) {
      try {
        if (!/^[a-f0-9]{64}$/.test(marker.files?.[file] ?? '')
          || hash(await readFile(join(dir, file))) !== marker.files[file]) complete = false;
      } catch { complete = false; }
    }
    owned.push({ dir, complete, modified: (await stat(dir)).mtimeMs });
  }
  const prior = previousEntry && dirname(previousEntry);
  const previous = owned.find((item) => item.dir === prior && item.dir !== current && item.complete)
    ?? owned.filter((item) => item.dir !== current && item.complete).sort((a, b) => b.modified - a.modified)[0];
  for (const item of owned) {
    if (item.dir !== current && item.dir !== previous?.dir) await rm(item.dir, { recursive: true });
  }
}

export async function install(options = {}) {
  (options.platformCheck ?? assertPlatform)();
  const { dataDir } = windowsPaths(options);
  await (options.verifyApp ?? verifyApp)(options);
  const lifecycle = await acquireLock(dataDir, '.lifecycle-lock');
  if (!lifecycle) throw new Error('Another install or disable operation is running');
  let staged, deployed, lock, committed = false, oldEnabled, oldStop, controlChanged = false;
  try {
    const bundleDir = options.bundleDir ?? HERE;
    const files = new Map(await Promise.all(FILES.map(async (name) => [name, await readFile(join(bundleDir, name))])));
    if ([...files.values()].some((value) => !value.length)) throw new Error('Empty Windows runtime bundle file');
    staged = await stageBundle(dataDir, files);
    oldEnabled = await readJSON(join(dataDir, 'enabled.json'), null);
    oldStop = await stopped(dataDir);
    await writeFile(join(dataDir, 'stop'), '');
    controlChanged = true;
    for (let n = 0; n < 60 && !lock; n++) {
      lock = await acquireLock(dataDir);
      if (!lock) await (options.sleep ?? sleep)(1000);
    }
    if (!lock) throw new Error('Runtime is still finishing its current attachment; retry installation later');
    deployed = join(dataDir, `bundle-${randomUUID()}`);
    await atomicJSON(join(staged, BUNDLE_MARKER), {
      owner: 'kimi-cot-translate/windows', bundle: basename(deployed), dataDir: resolve(dataDir),
      files: Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])),
    });
    await rename(staged, deployed);
    staged = undefined;
    await atomicJSON(join(dataDir, 'enabled.json'),
      { entry: join(deployed, 'runtime-windows.mjs'), generation: randomUUID() });
    await rm(join(dataDir, 'stop'), { force: true });
    await callBridge(options, 'Install', taskRequest(deployed, process.execPath, dataDir, taskName(options)));
    committed = true;
    await pruneBundles(dataDir, deployed, oldEnabled?.entry).catch((error) => {
      console.warn(`[kct-windows] Old bundle cleanup failed: ${error.message}`);
    });
  } catch (error) {
    if (controlChanged) {
      if (oldEnabled) await atomicJSON(join(dataDir, 'enabled.json'), oldEnabled);
      else await rm(join(dataDir, 'enabled.json'), { force: true });
      if (oldStop) await writeFile(join(dataDir, 'stop'), '');
      else await rm(join(dataDir, 'stop'), { force: true });
    }
    if (deployed) await rm(deployed, { recursive: true, force: true });
    throw error;
  } finally {
    if (staged) await rm(staged, { recursive: true, force: true });
    if (lock) await lock.release();
    await lifecycle.release();
    if (!committed && controlChanged && oldEnabled && !oldStop) {
      await callBridge(options, 'Start', { taskName: taskName(options) }).catch(() => {});
    }
  }
  try { await callBridge(options, 'Start', { taskName: taskName(options) }); }
  catch (error) {
    throw new Error('Runtime installed, but the scheduled watcher could not start; retry at next logon', { cause: error });
  }
  return { status: 'installed', dataDir };
}

export async function disable(options = {}) {
  const { dataDir } = windowsPaths(options);
  const lock = await acquireLock(dataDir, '.lifecycle-lock');
  if (!lock) throw new Error('Another install or disable operation is running');
  try {
    await writeFile(join(dataDir, 'stop'), '');
    await rm(join(dataDir, 'enabled.json'), { force: true });
    await callBridge(options, 'Disable', { taskName: taskName(options) });
    return { status: 'disabled', detail: 'Watcher exits after its current attachment; Kimi is left running' };
  } finally { await lock.release(); }
}

async function main() {
  assertPlatform();
  const command = process.argv[2];
  if (process.argv.length !== 3 || !['--once', '--check', '--watch', '--install', '--disable'].includes(command)) {
    throw new Error('Use --once, --check, --watch, --install or --disable');
  }
  let result;
  if (command === '--check') result = await readState();
  if (command === '--install') result = await install();
  if (command === '--disable') result = await disable();
  if (command === '--watch') result = await watch();
  if (command === '--once') {
    const { dataDir } = windowsPaths();
    const lock = await acquireLock(dataDir);
    if (!lock) throw new Error('Another Windows runtime operation is in progress');
    try { result = await tick(); } finally { await lock.release(); }
  }
  console.log(JSON.stringify(result));
  if (['error', 'blocked-inspector'].includes(result?.status)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[kct-windows] ${error.message}`); process.exitCode = 1; });
}
