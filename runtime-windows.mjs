#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  assertRendererContract, inspectFuses, MAX_ATTEMPTS, permanentError, portOpen,
  recordFailure, rendererBootstrap, retryDelay, reusableAttempt, stageBundle,
} from './runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const TASK = 'KimiCoTTranslate-Windows';
// runtime.mjs imports runtime-update.mjs at module load, so the bundle has to
// carry it and the macOS allowlist it reads; a missing file only surfaced once
// the deployed copy was actually executed.
const FILES = ['runtime-windows.mjs', 'runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs',
  'windows-bridge.ps1', 'supported-windows-runtimes.json', 'supported-runtimes.json', 'kct.js'];
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
  // The installer can be pointed at another drive or folder, so the real
  // executable decides which installation is being verified. An explicit
  // appDir must still be absolute and hold a Kimi Code executable; the standard
  // location stays the default when nothing is passed.
  const resolved = appDir ? win32.resolve(appDir) : standard;
  if (!win32.isAbsolute(resolved)) throw new Error('Kimi Code app directory must be absolute');
  // A drive root has no basename; refusing it keeps the executable path from
  // collapsing to the drive itself.
  if (appDir && win32.basename(resolved) === '') {
    throw new Error('Kimi Code app directory must be a directory, not a drive root');
  }
  return {
    appDir: resolved, executable: win32.join(resolved, 'Kimi Code.exe'),
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
  // The executable path is decided by the caller's appDir. It is compared
  // exactly against the process command line, so a different installation is
  // accepted only when it is the one being verified — any other path still
  // fails below instead of being treated as ours.
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
    // Kimi Code starts its own helper scripts through the same executable, e.g.
    // `Kimi Code.exe ./bin/kimi-datasource.mjs`. Those carry a non-flag script
    // argument and are not the Electron main process, which is argv[0] only.
    if (args.slice(1).some((arg) => !arg.startsWith('-'))) continue;
    if (!Number.isSafeInteger(info.pid) || info.pid <= 0
      || !Number.isFinite(Date.parse(info.started))
      || !info.executable || normalized(info.executable) !== normalized(executable)
      || normalized(args[0]) !== normalized(executable)) {
      throw new Error('Kimi main process is not the standard current-user installation');
    }
    // The attach itself needs `--remote-debugging-port=<DEBUG_PORT>`, so that one
    // exact argument is expected. Everything else that dumps a debugging socket
    // or moves the profile still means this is not the instance to attach to.
    const expectedRemote = `--remote-debugging-port=${options.debugPort ?? DEBUG_PORT}`;
    if (args.slice(1).some((arg) => arg.toLowerCase() !== expectedRemote.toLowerCase()
      && /^--?(?:inspect|debug|remote-debugging|user-data-dir|user-data-path|session-data-dir|profile|guest|incognito)(?:[-=]|$)/i.test(arg))) {
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

// The Authenticode signature is reported, never required. This is a free
// third-party display-layer translator: whether the host binary was signed by
// its vendor has no bearing on whether translation can work, and gating on it
// only meant that an official certificate rotation disabled the extension.
// What still protects the attachment is the process identity check — pid, owner
// SID, executable path and start time all have to match the inspected process
// before any signal is sent.
export function describeSignature(signature) {
  const status = typeof signature?.status === 'string' ? signature.status : 'Unknown';
  return { status, signed: status === 'Valid',
    ...(typeof signature?.thumbprint === 'string' && signature.thumbprint
      ? { thumbprint: signature.thumbprint.toUpperCase() } : {}) };
}

export function verifyBinary(binary, signature, supported) {
  const signatureInfo = describeSignature(signature);
  // An allowlist entry only records a build this project has already looked at.
  // It is never a requirement: the fuse and the renderer contract decide whether
  // attaching can work, so a new host build that keeps them keeps translating
  // without waiting for a release.
  const entries = Array.isArray(supported) ? supported : [];
  if (entries.some((entry) => !/^[a-f0-9]{64}$/.test(entry?.sha256 ?? '')
    || !Number.isSafeInteger(entry.size) || typeof entry.electron !== 'string'
    || typeof entry.appVersion !== 'string' || typeof entry.signerThumbprint !== 'string')) {
    throw permanentError('Invalid Windows runtime allowlist');
  }
  const sha256 = hash(binary);
  const known = entries.find((entry) => entry.sha256 === sha256 && entry.size === binary.length);
  const pe = binary.length >= 64 ? binary.readUInt32LE(0x3c) : -1;
  if (binary.toString('ascii', 0, 2) !== 'MZ' || pe < 0 || pe + 6 > binary.length
    || binary.toString('ascii', pe, pe + 4) !== 'PE\0\0' || binary.readUInt16LE(pe + 4) !== 0x8664) {
    throw permanentError('Expected a Windows PE x64 executable');
  }
  inspectFuses(binary);
  // The Electron version is reported for diagnostics only. Checking that the
  // embedded string exists proves this is the Electron runtime build rather than
  // a specific version of it, which is what the injection actually depends on.
  if (binary.indexOf(Buffer.from('Electron/')) < 0) {
    throw permanentError('Expected an Electron runtime in the verified executable');
  }
  return { version: known?.appVersion ?? 'unknown', electron: known?.electron ?? 'unknown',
    sha256, signature: signatureInfo, verified: known ? 'exact' : 'contract' };
}

export async function verifyApp(options = {}) {
  const { appDir, executable } = windowsPaths(options);
  const read = options.readFile ?? readFile;
  const identifyFile = options.fingerprint ?? fingerprint;
  const before = await identifyFile(executable);
  const signature = await callBridge(options, 'Signature', { executable });
  let supported;
  try {
    supported = JSON.parse(await read(join(options.bundleDir ?? HERE, 'supported-windows-runtimes.json'), 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw permanentError('Invalid Windows runtime allowlist');
    throw error;
  }
  const runtime = verifyBinary(await read(executable), signature, supported);
  const dist = win32.join(appDir, 'resources', 'desktop-dist');
  const index = await read(win32.join(dist, 'index.html'), 'utf8');
  const assets = [...index.matchAll(/href="(\/assets\/[A-Za-z0-9_-]+\.css)"/g)].map((item) => item[1]);
  if (!assets.length) throw permanentError('Cannot find Kimi renderer styles');
  assertRendererContract((await Promise.all(assets.map((name) =>
    read(win32.join(dist, ...name.slice(1).split('/')), 'utf8')))).join('\n'));
  if (before !== await identifyFile(executable)) throw new Error('Kimi changed during verification');
  return { version: runtime.version, electron: runtime.electron, sha256: runtime.sha256,
    signature: runtime.signature, verified: runtime.verified, executable: before };
}

// Windows attaches through the Chromium DevTools Protocol rather than
// `process._debugProcess`. That Node API needs the host to register a
// `node-debug-handler` event, which a real Kimi Code 1.3.1 install does not do,
// so the old path could never fire against a running desktop app. With
// `--remote-debugging-port` the renderer pages are reachable directly, which is
// both simpler and closer to where the translation actually runs.
export const DEBUG_PORT = 9222;

export async function debugPortOpen(port = DEBUG_PORT) {
  return new Promise((resolvePort) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    const finish = (value) => { socket.destroy(); resolvePort(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(500, () => finish(true));
  });
}

export function pageTargets(list) {
  return (Array.isArray(list) ? list : []).filter((target) => target?.type === 'page'
    && typeof target.webSocketDebuggerUrl === 'string'
    && /^app:\/\/renderer\/(sessions\/[A-Za-z0-9_-]+|index\.html|)$/.test(target.url));
}

export async function openCdp(url, { timeout = 15000, WebSocketImpl = WebSocket } = {}) {
  const socket = new WebSocketImpl(url);
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  const fail = (error) => {
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  socket.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message || 'CDP command failed'));
    else entry.resolve(message.result ?? {});
  };
  socket.onclose = () => fail(new Error('CDP connection closed'));
  socket.onerror = () => fail(new Error('CDP connection failed'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timed out')), timeout);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
  });
  return {
    send(method, params = {}, commandTimeout = 15000) {
      if (closed) return Promise.reject(new Error('CDP connection closed'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, commandTimeout);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { socket.close(); } catch { /* already gone */ } fail(new Error('closed')); },
  };
}

export async function cdpList(port = DEBUG_PORT, { fetchImpl = fetch, timeout = 8000 } = {}) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`CDP target list returned ${response.status}`);
  return response.json();
}

// Injects once per document and per revision. Re-running against an already
// injected page is a no-op so a second attach cannot duplicate the toolbar.
//
// The session is deliberately kept open: `Page.addScriptToEvaluateOnNewDocument`
// belongs to the session that registered it, so closing the socket would undo the
// very reload survival that makes translation come back after a refresh. The
// caller owns the returned sessions and closes them on detach.
const sessions = new Map();

export function openRendererSessions() {
  return [...sessions.values()];
}

export function closeRendererSessions() {
  for (const entry of sessions.values()) {
    try { entry.cdp.close(); } catch { /* already gone */ }
  }
  sessions.clear();
}

export async function installIntoRenderers(source, revision, {
  port = DEBUG_PORT, cdpListImpl = cdpList, openCdpImpl = openCdp,
} = {}) {
  const targets = pageTargets(await cdpListImpl(port));
  if (!targets.length) throw new Error('No Kimi renderer page is available for translation yet');
  const bootstrap = rendererBootstrap(source, revision);
  const injected = [];
  for (const target of targets) {
    const existing = sessions.get(target.id);
    if (existing && existing.revision === revision) {
      // Already wired on this very page and revision; re-evaluating would only
      // redeclare its top-level bindings.
      const mounted = await existing.cdp.send('Runtime.evaluate',
        { expression: 'typeof window.__kct', returnByValue: true }).catch(() => null);
      injected.push({ url: target.url, loaded: mounted?.result?.value === 'object' });
      continue;
    }
    if (existing) {
      try { existing.cdp.close(); } catch { /* replaced below */ }
      sessions.delete(target.id);
    }
    const cdp = await openCdpImpl(target.webSocketDebuggerUrl);
    try {
      await cdp.send('Runtime.enable');
      await cdp.send('Page.enable');
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bootstrap });
      const result = await cdp.send('Runtime.evaluate',
        { expression: bootstrap, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error('Translation script failed in the renderer');
      const mounted = await cdp.send('Runtime.evaluate',
        { expression: 'typeof window.__kct', returnByValue: true });
      const loaded = mounted.result?.value === 'object';
      if (loaded) sessions.set(target.id, { cdp, url: target.url, revision });
      else cdp.close();
      injected.push({ url: target.url, loaded });
    } catch (error) {
      cdp.close();
      throw error;
    }
  }
  return { loaded: injected.filter((entry) => entry.loaded).length, renderers: injected };
}

async function readJSON(file, missing = {}, read = readFile) {
  try { return JSON.parse(await read(file, 'utf8')); }
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
  const file = join(windowsPaths(options).dataDir, 'runtime-state.json');
  try {
    const state = await readJSON(file);
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('runtime-state.json must contain an object');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    const log = options.logError ?? console.error;
    log(`[kct-windows] runtime-state.json is unreadable; using safe defaults: ${error.message}`);
    return {};
  }
}

export async function tick(options = {}) {
  const paths = windowsPaths(options);
  const read = options.readFile ?? readFile;
  const checkPort = options.portOpen ?? portOpen;
  const now = options.now ?? Date.now;
  const save = options.saveState ?? (async (state) => {
    await mkdir(paths.dataDir, { recursive: true });
    await atomicJSON(join(paths.dataDir, 'runtime-state.json'), state);
  });
  let previous = await (options.readState ?? readState)(options);
  const semantic = (state) => JSON.stringify({ ...state, checkedAt: undefined });
  const persist = async (state) => {
    if (semantic(state) === semantic(previous)) return previous;
    state.checkedAt = new Date(now()).toISOString();
    await save(state);
    previous = structuredClone(state);
    return state;
  };
  const attempt = previous.identity ? previous : previous.attempt;
  const waiting = async (detail) => {
    return persist({ status: 'waiting', detail, ...(attempt ? { attempt } : {}) });
  };
  const found = await (options.findProcesses ?? findProcesses)(options);
  if (!found.length) return waiting('Kimi Code is not running');
  if (found.length !== 1) return waiting('Multiple Kimi main processes; waiting for one');
  const info = found[0];
  const identity = `${info.pid}:${info.started}`;
  const sameProcess = attempt?.pid === info.pid
    && (attempt.started === info.started || attempt.identity?.startsWith(`${identity}:`)
      || attempt.identity === identity);
  if (sameProcess && attempt.status !== 'active' && attempt.failureKind !== 'permanent') {
    const reusable = await reusableAttempt(attempt, now(), checkPort);
    if (reusable) return persist(reusable);
  }
  if (now() - Date.parse(info.started) < 5000) return waiting('Kimi is starting');
  const state = {
    identity, revision: null, pid: info.pid, started: info.started, status: 'checking',
    attempts: (sameProcess ? attempt.attempts ?? 1 : 0) + 1,
    lastAttemptAt: new Date(now()).toISOString(), nextRetryAt: null, failureKind: null,
  };
  try {
    const bundle = options.bundleDir ?? HERE;
    const bytes = await Promise.all(FILES.map((name) => read(join(bundle, name))));
    const revision = hash(Buffer.concat(bytes.map((value, i) =>
      Buffer.concat([Buffer.from(`${FILES[i]}\0${Buffer.byteLength(value)}\0`), Buffer.from(value)]))));
    const source = Buffer.from(bytes[FILES.indexOf('kct.js')]).toString('utf8');
    state.revision = revision;
    const matched = attempt?.identity === identity && attempt.revision === revision ? attempt : null;
    if (matched) {
      const reusable = await reusableAttempt(matched, now(), checkPort);
      if (reusable) return persist(reusable);
    }
    if (sameProcess && state.attempts > MAX_ATTEMPTS) return persist(attempt);
    // Persist before attachment so a crash cannot blindly repeat a possible signal.
    await persist(state);
    const app = await (options.verifyApp ?? verifyApp)(options);
    state.appVersion = app.version;
    // The port has to be open for the CDP attach to work at all. Ownership is
    // established by the process check above plus the target list below, not by
    // the port being free: this tool is the component that started Kimi with it.
    const debugPort = options.debugPort ?? DEBUG_PORT;
    if (!await (options.debugPortOpen ?? debugPortOpen)(debugPort)) {
      throw new Error(`Kimi is not listening on the debugging port ${debugPort}; restart it with --remote-debugging-port=${debugPort}`);
    }
    // The renderer must already be up: attaching to a half-started app would
    // inject into the inline splash document and never reach the session page.
    const result = await (options.installIntoRenderers ?? installIntoRenderers)(source, revision,
      { port: options.debugPort ?? DEBUG_PORT, ...options.cdp });
    state.status = 'active';
    state.loaded = result.loaded;
  } catch (error) {
    recordFailure(state, error, now());
  }
  return persist(state);
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

async function stopped(dataDir, readStat = stat) {
  return readStat(join(dataDir, 'stop')).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

export async function watch(options = {}) {
  const { dataDir } = windowsPaths(options);
  const lock = await acquireLock(dataDir);
  if (!lock) return { status: 'busy' };
  const entry = join(options.bundleDir ?? HERE, 'runtime-windows.mjs');
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? sleep;
  const logError = options.logError ?? console.error;
  const read = options.readFile ?? readFile;
  const readStat = options.statFile ?? stat;
  try {
    let enabled;
    let nextTick = 0;
    let failures = 0;
    while (true) {
      try {
        if (await stopped(dataDir, readStat)) break;
        if (!enabled) {
          if (now() < nextTick) {
            await pause(1000);
            continue;
          }
          let initial;
          try { initial = await readJSON(join(dataDir, 'enabled.json'), null, read); }
          catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            logError(`[kct-windows] enabled.json is unreadable; restoring watcher state: ${error.message}`);
          }
          if (!initial) {
            initial = { entry, generation: randomUUID() };
            await atomicJSON(join(dataDir, 'enabled.json'), initial);
          }
          if (initial.entry !== entry) break;
          enabled = initial;
        }
        let current;
        try { current = await readJSON(join(dataDir, 'enabled.json'), null, read); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          logError(`[kct-windows] enabled.json is unreadable; keeping current watcher: ${error.message}`);
          await atomicJSON(join(dataDir, 'enabled.json'), enabled);
          current = enabled;
        }
        if (current?.generation !== enabled.generation || current.entry !== entry) break;
        if (now() >= nextTick) {
          await (options.tick ?? tick)(options);
          failures = 0;
          nextTick = now() + 10000;
        }
      } catch (error) {
        failures += 1;
        logError(`[kct-windows] Watcher iteration failed; retrying: ${error.message}`);
        nextTick = now() + retryDelay(failures);
      }
      await pause(1000);
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
  if (result?.status === 'error') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[kct-windows] ${error.message}`); process.exitCode = 1; });
}
