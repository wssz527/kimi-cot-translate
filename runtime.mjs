#!/usr/bin/env node
// The official app stays sealed; only the running, verified main process is touched.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { installRuntimeHook } from './runtime-hook.mjs';
import { downloadBundle, fetchManifest, localVersion, resolveUpdate, RUNTIME_FILES,
  versionedManifestUrl } from './runtime-update.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
export const APP = '/Applications/Kimi Code.app';
const EXECUTABLE = join(APP, 'Contents/MacOS/Kimi Code');
const FRAMEWORK = join(APP, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
const ELECTRON_INFO = join(APP, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist');
export const DATA = join(homedir(), 'Library/Application Support/kimi-cot-translate');
// launchd watches these directories instead of polling on a timer. The Kimi
// profile directory changes continuously while the app runs and goes quiet
// once it exits, so the job only wakes for real Kimi activity.
const KIMI_PROFILE = join(homedir(), 'Library/Application Support/kimi-code-app');
const WATCH_PATHS = [KIMI_PROFILE, join(KIMI_PROFILE, 'Local Storage'), join(KIMI_PROFILE, 'Session Storage')];
const STATE = join(DATA, 'runtime-state.json');
const RUN_RESULT = join(DATA, '.last-run.json');
const LEGACY_JOURNAL = join(DATA, '.legacy-migration.json');
const LABEL = 'com.user.kimi-cot-translate.runtime';
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CORE_FILES = ['runtime.mjs', 'runtime-hook.mjs', 'runtime-update.mjs', 'runtime-launcher.mjs',
  'supported-runtimes.json', 'kct.js'];
const SETTLED = new Set(['active', 'error', 'blocked-inspector', 'checking']);
export const MAX_ATTEMPTS = 8;
export const retryDelay = (attempts) => [30000, 120000, 600000, 1800000][
  Math.min(Math.max(attempts - 1, 0), 3)];

export function permanentError(message) {
  return Object.assign(new Error(message), { failureKind: 'permanent' });
}

export function recordFailure(state, error, now) {
  state.failureKind = error.inspectorOpen ? 'inspector-uncertain' : error.failureKind ?? 'transient';
  state.status = state.failureKind === 'inspector-uncertain' ? 'blocked-inspector' : 'error';
  state.detail = error.message;
  state.nextRetryAt = state.failureKind === 'permanent' || state.attempts >= MAX_ATTEMPTS
    ? null : new Date(now + retryDelay(state.attempts)).toISOString();
  if (state.attempts >= MAX_ATTEMPTS && state.failureKind !== 'permanent') {
    state.detail += '; retry limit reached; waiting for Kimi to restart';
  }
  return state;
}

export async function reusableAttempt(attempt, now, checkPort) {
  if (attempt.status === 'active') return attempt;
  if (attempt.status === 'checking' || !attempt.failureKind) {
    attempt = recordFailure({ ...attempt, attempts: attempt.attempts ?? 1,
      lastAttemptAt: attempt.lastAttemptAt ?? attempt.checkedAt ?? new Date(now).toISOString() },
      Object.assign(new Error('Previous attempt was interrupted or its trigger state is unknown'),
        { failureKind: 'inspector-uncertain' }), now);
  }
  // Probe even during backoff: an uncertain trigger must never be followed by another on an open port.
  if (attempt.failureKind === 'inspector-uncertain' && await checkPort()) return attempt;
  if (attempt.failureKind === 'permanent' || attempt.attempts >= MAX_ATTEMPTS
    || now < Date.parse(attempt.nextRetryAt)) return attempt;
  return null;
}
const output = async (command, args) => (await run(command, args, {
  encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
  env: { ...process.env, LC_ALL: 'C' },
})).stdout;
const fingerprint = (file) => stat(file).then((s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`);

function assertInstallPlatform({
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
} = {}) {
  if (platform !== 'darwin') throw new Error('Installation requires macOS');
  if (arch !== 'arm64') throw new Error('Installation requires Apple Silicon (arm64)');
  if (!/^24\./.test(nodeVersion)) throw new Error(`Installation requires Node 24; found ${nodeVersion}`);
}

const PROCESS_START_RE = /^\s*(\d+)\s+(\d+)\s+(\w{3})\s+(\w{3})\s+(\d+)\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.*?)\s*$/;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

export function parseProcess(text, parseStarted = Date.parse) {
  const fields = PROCESS_START_RE.exec(text);
  if (!fields || !(fields[4] in MONTHS)) throw new Error('Cannot identify the Kimi main process');
  const started = `${fields[3]} ${fields[4]} ${fields[5]} ${fields[6]}:${fields[7]}:${fields[8]} ${fields[9]}`;
  return {
    pid: Number(fields[1]), uid: Number(fields[2]), started,
    // ps lstart is wall-clock local time; the caller decides how it maps to an epoch.
    startedAt: parseStarted(started), executable: fields[10],
  };
}

export async function processIdentity(pid) {
  return parseProcess(await output('/bin/ps', ['-p', String(pid), '-o', 'pid=,uid=,lstart=,comm=']));
}

export function assertIdentity(processInfo, expected = processInfo) {
  if (processInfo.uid !== process.getuid() || processInfo.executable !== EXECUTABLE
    || JSON.stringify(processInfo) !== JSON.stringify(expected)) {
    throw new Error('Kimi process identity changed; no signal sent');
  }
}

export async function findProcesses({
  listProcesses = () => output('/bin/ps', ['-A', '-o', 'pid=,comm=']),
  identify = processIdentity,
} = {}) {
  // `pgrep -x` cannot match a name containing a space on macOS, so scan the
  // process table and keep entries whose executable path is exactly ours.
  const listing = await listProcesses();
  const found = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || match[2].trim() !== EXECUTABLE) continue;
    const info = await identify(Number(match[1])).catch(() => null);
    if (info?.uid === process.getuid() && info.executable === EXECUTABLE) found.push(info);
  }
  return found;
}

export async function portOpen(openSocket = connect) {
  return new Promise((resolvePort) => {
    const socket = openSocket({ host: '127.0.0.1', port: 9229 });
    const finish = (value) => { socket.destroy(); resolvePort(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(500, () => finish(true));
  });
}

export function inspectFuses(binary) {
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const at = binary.indexOf(sentinel);
  if (at < 0 || binary[at + sentinel.length] !== 1) throw permanentError('Unknown Electron fuse layout');
  if (binary[at + sentinel.length + 1] < 4 || binary[at + sentinel.length + 2 + 3] !== 49) {
    throw permanentError('Node inspector signal support is disabled');
  }
}

export function assertRendererContract(css) {
  for (const selector of ['think', 'think-head', 'think-body', 'think-body-inner', 'think-text']) {
    if (!new RegExp(`\\.${selector}(?:\\[|[\\s.{:#>])`).test(css)) {
      throw permanentError('Kimi reasoning UI changed; translation is disabled until compatibility is checked');
    }
  }
}

// The hash allowlist is the fast path for a fully validated runtime. An unknown
// hash is still allowed when the official signature and the inspector fuse hold.
// The packaged stylesheet is auxiliary evidence only; the live page is inspected
// after attachment. None of these gates is inferred from a version number, so an
// official update that leaves them intact keeps translating.
export async function verifyApp(deps = {}) {
  const identify = deps.fingerprint ?? fingerprint;
  const command = deps.output ?? output;
  const read = deps.readFile ?? readFile;
  const before = await identify(EXECUTABLE);
  const codesign = deps.run ?? run;
  const requirement = 'anchor apple generic and identifier "com.kimi.code.desktop" and certificate leaf[subject.OU] = "2J9472RW75"';
  try {
    await codesign('/usr/bin/codesign', ['--verify', '--strict', '--deep', `-R=${requirement}`, APP], { timeout: 20000 });
  } catch (error) {
    if (error.killed || error.code === 'ETIMEDOUT') throw error;
    throw permanentError('Official Kimi signature or signing identity could not be verified');
  }
  const signature = { status: 'valid', identifier: 'com.kimi.code.desktop', team: '2J9472RW75' };
  const frameworkBefore = await identify(FRAMEWORK);
  const binary = await read(FRAMEWORK);
  inspectFuses(binary);
  const supported = JSON.parse(await read(join(HERE, 'supported-runtimes.json'), 'utf8'));
  const known = supported.find((item) => item.sha256 === hash(binary));
  const electron = known?.electron ?? await command('/usr/libexec/PlistBuddy', [
    '-c', 'Print :CFBundleVersion', ELECTRON_INFO,
  ]).then((value) => value.trim(), () => null);
  const version = await command('/usr/libexec/PlistBuddy', [
    '-c', 'Print :CFBundleShortVersionString', join(APP, 'Contents/Info.plist'),
  ]).then((value) => value.trim(), () => null);
  let rendererContract = 'unknown';
  try {
    const dist = join(APP, 'Contents/Resources/desktop-dist');
    const index = await read(join(dist, 'index.html'), 'utf8');
    const assets = [...index.matchAll(/href\s*=\s*["'](\/assets\/[A-Za-z0-9_.-]+\.css)(?:\?[^"']*)?["']/gi)]
      .map((item) => item[1]);
    if (assets.length) {
      assertRendererContract((await Promise.all(assets.map((name) => read(join(dist, name), 'utf8')))).join('\n'));
      rendererContract = 'present-in-styles';
    }
  } catch {
    // Stylesheet classes are auxiliary evidence only: asset names and class
    // hashes change between builds, and the live page is the authority.
    rendererContract = 'unknown';
  }
  if (before !== await identify(EXECUTABLE) || frameworkBefore !== await identify(FRAMEWORK)) {
    throw new Error('Application changed during verification');
  }
  return { version, electron, executable: before, framework: frameworkBefore, signature,
    rendererContract, verified: known ? 'exact' : 'capabilities' };
}

async function verifyLiveProcess(info, app) {
  assertIdentity(await processIdentity(info.pid), info);
  if (await fingerprint(EXECUTABLE) !== app.executable
    || (app.framework && await fingerprint(FRAMEWORK) !== app.framework)) {
    throw new Error('Application changed during attachment');
  }
  const files = await output('/usr/sbin/lsof', ['-nP', '-a', '-p', String(info.pid), '-d', 'txt', '-Fin']);
  const inode = (await stat(EXECUTABLE)).ino;
  if (!files.includes(`i${inode}\nn${EXECUTABLE}\n`)) throw permanentError('Running executable does not match the verified app');
}

export async function attachInspector(info, app, operations = {}) {
  const verifyLive = operations.verifyLiveProcess ?? verifyLiveProcess;
  const checkPort = operations.portOpen ?? portOpen;
  const trigger = operations.triggerInspector ?? ((target) => process.kill(target.pid, 'SIGUSR1'));
  const checkIdentity = operations.checkIdentity
    ?? (async (target) => assertIdentity(await processIdentity(target.pid), target));
  const verifyPortOwner = operations.verifyPortOwner ?? (async (target) => {
    const owned = await output('/usr/sbin/lsof', [
      '-nP', '-a', '-p', String(target.pid), '-iTCP:9229', '-sTCP:LISTEN', '-Fpn',
    ]);
    if (!owned.includes(`p${target.pid}\n`) || !owned.includes('n127.0.0.1:9229\n')) {
      throw new Error('Inspector socket is not owned by the expected Kimi process');
    }
  });
  await verifyLive(info, app);
  if (await checkPort()) throw new Error('Inspector port 9229 is occupied; refusing to attach');
  await verifyLive(info, app);
  let socket;
  let counter = 0;
  let closed = false;
  let triggered = false;
  const pending = new Map();
  let evaluate;
  const loaderRequire = `(typeof require === 'function' ? require : process.mainModule.require.bind(process.mainModule))`;
  const closeExpression = `if(process.pid===${info.pid} && process.type==='browser'){
    clearTimeout(globalThis.__kctInspectorDeadline);
    setTimeout(()=>${loaderRequire}('node:inspector').close(),25);}true`;
  try {
    await trigger(info);
    triggered = true;
    let endpoint;
    for (let attempt = 0; attempt < 50; attempt++) {
      await checkIdentity(info);
      try {
        const response = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(400) });
        endpoint = (await response.json()).find((target) => target.type === 'node')?.webSocketDebuggerUrl;
      } catch { /* Wait for this process's inspector to start. */ }
      if (endpoint) break;
      await sleep(100);
    }
    if (!endpoint) throw new Error('Kimi did not open its inspector');
    await verifyPortOwner(info);
    const url = new URL(endpoint);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== '9229') {
      throw new Error('Unexpected inspector endpoint');
    }
    socket = new WebSocket(url);
    socket.addEventListener('message', ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error('Inspector rejected a command'));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      closed = true;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Inspector disconnected'));
      }
      pending.clear();
    });
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('Inspector connection timeout')), 2000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspector connection failed')); }, { once: true });
    });
    evaluate = async (expression) => {
      const result = await new Promise((resolveCommand, reject) => {
        const id = ++counter;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Inspector command timeout'));
        }, 7000);
        pending.set(id, { resolve: resolveCommand, reject, timer });
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true } }));
      });
      if (result.exceptionDetails) throw new Error('Kimi runtime rejected the translation hook');
      return result.result?.value;
    };
    // The first command arms a deadline before inspecting identity or loading plugin code.
    const identity = await evaluate(inspectorDeadlineExpression(info.pid));
    if (identity?.pid !== info.pid || identity.type !== 'browser' || !identity.electron
      || (app.electron && identity.electron !== app.electron)) {
      throw new Error('Inspector identity mismatch');
    }
    return {
      evaluate,
      async close() {
        if (!closed) {
          await evaluate(closeExpression).catch(() => {});
        }
        for (let attempt = 0; attempt < 150 && await checkPort(); attempt++) await sleep(100);
        socket.close();
        if (await checkPort()) {
          const error = new Error('Inspector did not close; quit Kimi normally to close port 9229');
          error.inspectorOpen = true;
          throw error;
        }
      },
    };
  } catch (error) {
    if (socket?.readyState === WebSocket.OPEN && evaluate) {
      await evaluate(closeExpression).catch(() => {});
    }
    if (triggered) error.failureKind = 'inspector-uncertain';
    if (await checkPort()) {
      for (let attempt = 0; attempt < 150 && await checkPort(); attempt++) await sleep(100);
    }
    socket?.close();
    if (await checkPort()) {
      error.inspectorOpen = true;
      error.message = 'Inspector could not be closed; quit Kimi normally to close port 9229';
    }
    throw error;
  }
}

export function inspectorDeadlineExpression(pid) {
  return `(() => {
    if(process.pid!==${Number(pid)} || process.type!=='browser') throw new Error('Wrong inspector process');
    const load=typeof require==='function'?require:process.mainModule.require.bind(process.mainModule);
    const inspector=load('node:inspector');
    clearTimeout(globalThis.__kctInspectorDeadline);
    globalThis.__kctInspectorDeadline=setTimeout(()=>inspector.close(),12000);
    return {pid:process.pid,type:process.type,electron:process.versions.electron};
  })()`;
}

export function rendererBootstrap(source, revision) {
  return `(() => {
    if (window.__kct) return;
    try {
      ${source}
      window.__kctRuntimeRevision=${JSON.stringify(revision)};
    } catch (error) { console.warn('[kct] Translation UI did not load'); }
  })()`;
}

export async function installIntoProcess(info, app, source, revision, operations) {
  const inspector = await attachInspector(info, app, operations);
  try {
    const result = await inspector.evaluate(`(async () => {
      const electron=(typeof require==='function'?require:process.mainModule.require.bind(process.mainModule))('electron');
      return await (${installRuntimeHook.toString()})(electron,
        ${JSON.stringify(rendererBootstrap(source, revision))},${JSON.stringify(revision)});
    })()`);
    if (!result?.loaded && !result?.stale) throw new Error('No main Kimi renderer accepted the translation script');
    // Read the page-level picture in the same inspector session: one signal per
    // run, no extra attachment, and the answer describes this revision only.
    const health = await inspector.evaluate(`(async () => {
      const hook = globalThis.__kctRuntimeHook;
      if (!hook || typeof hook.health !== 'function') return null;
      return await hook.health();
    })()`).catch(() => null);
    return { ...result, health };
  } catch (error) {
    error.failureKind = 'inspector-uncertain';
    throw error;
  } finally { await inspector.close(); }
}

async function readState() {
  try { return JSON.parse(await readFile(STATE, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export async function saveState(state, file = STATE) {
  const next = JSON.stringify(state, null, 2) + '\n';
  const old = await readFile(file, 'utf8').catch(() => '');
  if (next === old) return;
  await writeFile(`${file}.next`, next, { mode: 0o600 });
  await rename(`${file}.next`, file);
}

export function launchOutcome(state, error) {
  if (error) return error.failureKind === 'permanent' ? 'incompatible' : 'failed';
  switch (state?.status) {
    case 'active':
      // `liveVerified` records that this very run attached to the process,
      // installed the hook and read the page back. A reused historical `active`
      // record proves none of that, so it can never confirm a candidate.
      if (state.liveVerified !== true) return 'transient';
      if (state.inspectorClosed !== true) return 'failed';
      if ((state.loaded ?? 0) > 0) return 'success';
      // The hook is installed and every open window still runs the previous
      // kct.js. The new bundle is in place; the pages adopt it on their next
      // load, which is the user's window to close or refresh — not a failure.
      if (state.renderer === 'stale') return 'transient';
      return 'failed';
    case 'waiting':
      return 'waiting';
    case 'error':
    case 'blocked-inspector':
      if (state.failureKind === 'permanent') return 'incompatible';
      if (state.failureKind === 'transient') return 'transient';
      return 'failed';
    default:
      return 'transient';
  }
}

async function writeRunResult(state, error) {
  const result = {
    id: process.env.KCT_LAUNCH_ID ?? null,
    candidate: process.env.KCT_CANDIDATE_ID ?? null,
    outcome: launchOutcome(state, error),
    status: state?.status ?? 'error',
    failureKind: state?.failureKind ?? error?.failureKind ?? null,
    loaded: state?.loaded ?? 0,
    inspectorClosed: state?.inspectorClosed === true,
    liveVerified: state?.liveVerified === true,
    revision: state?.revision ?? null,
    pid: state?.pid ?? null,
    renderer: state?.renderer ?? null,
    pagesCurrent: state?.pagesCurrent ?? null,
    pagesStale: state?.pagesStale ?? null,
    pagesPending: state?.pagesPending ?? null,
    pagesUnresponsive: state?.pagesUnresponsive ?? null,
    staleRevisions: state?.staleRevisions ?? [],
    blocks: state?.blocks ?? null,
    translation: state?.translation ?? null,
    detail: state?.detail ?? error?.message ?? null,
    checkedAt: state?.checkedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
  const next = JSON.stringify(result, null, 2) + '\n';
  await writeFile(`${RUN_RESULT}.next`, next, { mode: 0o600 });
  await rename(`${RUN_RESULT}.next`, RUN_RESULT);
}

function waitingState(detail, now = Date.now(), extra = {}) {
  return { status: 'waiting', detail, checkedAt: new Date(now).toISOString(), ...extra };
}

// Page-level facts travel with the run result so a candidate can be judged on
// what the pages actually do, not only on the hook answering.
export function pageHealth(health) {
  if (!health) return {};
  const current = health.currentHealth ?? [];
  const blocks = current.reduce((count, page) => count + (page.blocks ?? 0), 0);
  const mounted = current.reduce((count, page) => count + (page.mounted ?? 0), 0);
  return {
    renderer: health.stale ? 'stale' : health.current ? 'current' : 'none',
    pagesCurrent: health.current ?? 0,
    pagesStale: health.stale ?? 0,
    pagesPending: health.pending ?? 0,
    pagesUnresponsive: health.unresponsive ?? 0,
    staleRevisions: health.staleRevisions ?? [],
    blocks,
    mounted,
    // No thinking block is not a translation failure: a fresh conversation has
    // nothing to translate yet.
    translation: blocks === 0 ? 'no-thinking-blocks' : mounted === 0 ? 'unmounted' : 'unconfirmed',
  };
}

function processSetIdentity(processes) {
  return processes.map(({ pid, started }) => `${pid}:${started}`).sort().join('|');
}

function matchedAttempt(state, identity, revision) {
  const attempt = SETTLED.has(state?.status) ? state : state?.attempt;
  if (identity === undefined && revision === undefined) return attempt ?? null;
  return attempt?.identity === identity && attempt.revision === revision ? attempt : null;
}

function runtimeRevision(source, supported,
  hookSource = installRuntimeHook.toString(), loaderSource = '') {
  return hash(source + hookSource + loaderSource + supported);
}

// Fetch and install a newer runtime bundle when one is published. Returns
// { updated: true, from, to } after a successful atomic deploy, or
// { updated: false, reason } leaving the current deployment untouched.
export async function selfUpdate({
  dataDir = DATA,
  currentVersion,
  manifestUrl,
  fetchImpl = fetch,
  resolve,
  deployFn,
  lock,
  cacheDir,
} = {}) {
  const check = await (resolve ?? (() => resolveUpdate({
    current: currentVersion, manifestUrl, fetchImpl,
  })))();
  if (!check?.available) return { updated: false, reason: 'up-to-date', current: check?.current, remote: check?.remote };
  if (!deployFn) return { updated: false, reason: 'no-deploy', available: true, remote: check.remote };
  const files = await downloadBundle(check.manifest, { fetchImpl, cacheDir });
  await deployFn({ files, dataDir, acquire: lock });
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
  return { updated: true, from: check.current, to: check.remote };
}

export async function maybeUpdate(state, {
  now = Date.now(), dataDir = DATA, version, updateCheck, resolveUpdateFn, applyUpdate, processKey,
} = {}) {
  if (!updateCheck || !resolveUpdateFn || !processKey || state.updateCheckedFor === processKey) return state;
  if (state.updateAttemptFor !== processKey) {
    state.updateAttemptFor = processKey;
    state.updateAttempts = 0;
    delete state.updateNextRetryAt;
  }
  if (state.updateAttempts >= 4 || now < Date.parse(state.updateNextRetryAt)) return state;
  state.updateAttempts += 1;
  state.lastUpdateAttemptAt = new Date(now).toISOString();
  try {
    const result = await resolveUpdateFn(version);
    state.lastUpdateCheckAt = new Date(now).toISOString();
    state.updateVersion = result.remote;
    if (!result.available) state.updateStatus = 'up-to-date';
    else if (!applyUpdate) state.updateStatus = 'available';
    else {
      const applied = await applyUpdate(result.manifest, dataDir);
      if (!applied) throw new Error('Update deployment deferred');
      state.updateStatus = 'staged';
    }
    state.updateCheckedFor = processKey;
    delete state.updateError;
    delete state.updateNextRetryAt;
  } catch (error) {
    state.updateStatus = 'failed';
    state.updateError = error.message;
    const migrationRequired = /migration (?:must be started outside|requires an explicit --install|requires --install)/.test(error.message);
    if (migrationRequired) state.updateAttempts = 4;
    state.updateNextRetryAt = state.updateAttempts >= 4 ? null
      : new Date(now + [60000, 300000, 1800000][state.updateAttempts - 1]).toISOString();
  }
  return state;
}

async function tickAttachment(deps = {}) {
  const find = deps.findProcesses ?? findProcesses;
  const save = deps.saveState ?? saveState;
  const command = deps.output ?? output;
  const read = deps.readFile ?? readFile;
  const previousState = deps.readState ?? readState;
  const fileFingerprint = deps.fingerprint ?? fingerprint;
  const checkPort = deps.portOpen ?? portOpen;
  const verify = deps.verifyApp ?? verifyApp;
  const install = deps.installIntoProcess ?? installIntoProcess;
  const now = deps.now ?? Date.now;
  // A candidate run has to prove itself against the live process: a persisted
  // `active` record from an earlier revision or an earlier start describes what
  // happened then, not what this bundle does now.
  const candidate = deps.candidate ?? Boolean(process.env.KCT_CANDIDATE_ID);
  const processes = await find();
  let beforeWait = await previousState().catch(() => ({}));
  const diskState = structuredClone(beforeWait);
  const updateFields = () => Object.fromEntries(Object.entries(beforeWait)
    .filter(([key]) => key.startsWith('update') || key.startsWith('lastUpdate')));
  const persist = async (state) => {
    Object.assign(state, updateFields());
    const fields = (value) => JSON.stringify({ ...value, checkedAt: undefined });
    if (fields(state) === fields(diskState)) return beforeWait;
    state.checkedAt = new Date(now()).toISOString();
    await save(state);
    beforeWait = structuredClone(state);
    return state;
  };
  const preserved = matchedAttempt(beforeWait);
  const waiting = (detail, extra = {}, now = Date.now()) => {
    const state = waitingState(detail, now, { ...extra, ...(preserved ? { attempt: preserved } : {}) });
    return state;
  };
  if (!processes.length) {
    const state = waiting('Kimi Code is not running', {}, now());
    return persist(state);
  }
  if (processes.length !== 1) {
    const state = waiting('Multiple Kimi main processes; waiting for one default instance',
      { identity: processSetIdentity(processes) }, now());
    return persist(state);
  }
  const info = processes[0];
  const processKey = `${info.pid}:${info.started}`;
  const sameProcess = preserved?.pid === info.pid
    && (preserved.started === info.started || preserved.identity?.startsWith(`${processKey}:`));
  if (!candidate && sameProcess && preserved.status !== 'active' && preserved.failureKind !== 'permanent') {
    const reusable = await reusableAttempt(preserved, now(), checkPort);
    if (reusable) return persist(reusable);
  }
  const state = {
    identity: processKey, revision: null, pid: info.pid, started: info.started, status: 'checking',
    attempts: (sameProcess ? preserved.attempts ?? 1 : 0) + 1,
    lastAttemptAt: new Date(now()).toISOString(), nextRetryAt: null, failureKind: null,
  };
  try {
    const source = await read(join(HERE, 'kct.js'), 'utf8');
    const supported = await read(join(HERE, 'supported-runtimes.json'), 'utf8');
    const loader = await read(new URL(import.meta.url), 'utf8');
    const revision = runtimeRevision(source, supported, installRuntimeHook.toString(), loader);
    const identity = `${processKey}:${await fileFingerprint(EXECUTABLE)}`;
    if (!candidate) {
      const matched = matchedAttempt(beforeWait, identity, revision);
      if (matched) {
        const reusable = await reusableAttempt(matched, now(), checkPort);
        if (reusable) return persist(reusable);
      }
    }
    if (sameProcess && state.attempts > MAX_ATTEMPTS && !candidate) return persist(preserved);
    state.identity = identity;
    state.revision = revision;
    const args = await command('/bin/ps', ['-p', String(info.pid), '-o', 'command=']);
    if (args.includes('--user-data-dir') || args.includes('--remote-debugging') || args.includes('--inspect')) {
      return persist(waiting('A test or debugging instance is running; skipped', {}, now()));
    }
    if (now() - info.startedAt < 5000) return persist(waiting('Kimi is starting', {}, now()));
    // Persist before attachment so a crashed loader cannot blindly repeat its signal.
    await persist(state);
    const app = await verify();
    state.appVersion = app.version;
    if (await checkPort()) throw new Error('Inspector port 9229 is in use; no signal sent');
    const result = await install(info, app, source, revision);
    state.status = 'active';
    state.loaded = result.loaded;
    state.stalePages = result.stale ?? 0;
    state.inspectorClosed = true;
    state.liveVerified = true;
    state.verifiedAt = new Date(now()).toISOString();
    // healthyAt means the runtime could run, the hook is installed in the live
    // process and the pages were read back. It never means translation has been
    // proven: an empty conversation has no thinking blocks to translate.
    Object.assign(state, pageHealth(result.health));
  } catch (error) {
    recordFailure(state, error, now());
  }
  const saved = await persist(state);
  console.log(JSON.stringify(saved));
  return saved;
}

export async function tick(deps = {}) {
  let processes;
  const find = deps.findProcesses ?? findProcesses;
  const state = await tickAttachment({ ...deps, findProcesses: async () => (processes = await find()) });
  if (!deps.update || processes.length !== 1) return state;
  const info = processes[0];
  const updated = await maybeUpdate({ ...state }, {
    now: (deps.now ?? Date.now)(), processKey: `${info.pid}:${info.started}`, ...deps.update,
  });
  if (JSON.stringify(updated) !== JSON.stringify(state)) await (deps.saveState ?? saveState)(updated);
  return updated;
}

async function acquireLock(dataDir = DATA) {
  try {
    const { acquireLock: shared } = await import('./runtime-launcher.mjs');
    return await shared(dataDir);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  // Windows bundles do not ship the macOS launcher; keep a compatible fallback.
  const lock = join(dataDir, '.runtime-lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pidText = await readFile(join(lock, 'pid'), 'utf8').catch(() => '');
    const pid = Number(pidText);
    if (pidText.trim() && Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return null; }
      catch (probe) {
        if (probe.code === 'EPERM') return null;
        if (probe.code !== 'ESRCH') throw probe;
        await rm(lock, { recursive: true, force: true });
        return acquireLock(dataDir);
      }
    }
    if (Date.now() - (await stat(lock)).mtimeMs < 60000) return null;
    await rm(lock, { recursive: true, force: true });
    return acquireLock(dataDir);
  }
  try { await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 }); }
  catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
  return { async release() { await rm(lock, { recursive: true, force: true }); } };
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export async function readBundle(dir, read = readFile) {
  const files = new Map();
  for (const name of CORE_FILES) {
    const bytes = await read(join(dir, name));
    if (!bytes?.length) throw new Error(`${name} is empty or unreadable`);
    files.set(name, Buffer.from(bytes));
  }
  let supported;
  try {
    supported = JSON.parse(files.get('supported-runtimes.json').toString('utf8'));
  } catch {
    throw new Error('supported-runtimes.json is not valid JSON');
  }
  if (!Array.isArray(supported) || supported.length === 0 || supported.some((item) =>
    typeof item?.electron !== 'string' || !/^[a-f0-9]{64}$/.test(item?.sha256 ?? '')
      || typeof item.validatedWithApp !== 'string')) {
    throw new Error('supported-runtimes.json has an invalid runtime entry');
  }
  return files;
}

async function verifyBundle(dir, files, read = readFile) {
  for (const [name, expected] of files) {
    const actual = await read(join(dir, name));
    if (hash(actual) !== hash(expected)) throw new Error(`Deployment hash mismatch: ${name}`);
  }
}

export async function stageBundle(dataDir, files, read = readFile, write = writeFile) {
  const stage = await mkdtemp(join(dataDir, '.deploy-stage-'));
  try {
    for (const [name, bytes] of files) await write(join(stage, name), bytes, { mode: 0o600 });
    await verifyBundle(stage, files, read);
    return stage;
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function agentPlist(dataDir, label) {
  const log = join(dataDir, 'runtime.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(dataDir, 'runtime.mjs'))}</string><string>--once</string></array>
<key>WatchPaths</key><array>${WATCH_PATHS.map((path) => `<string>${xml(path)}</string>`).join('')}</array>
<key>StartInterval</key><integer>60</integer>
<key>RunAtLoad</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`;
}

async function agentLoaded(run, label) {
  try {
    await run('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]);
    return true;
  } catch (error) {
    if (/could not find service|service.*not found/i.test(String(error.stderr ?? error.message))) return false;
    throw error;
  }
}

async function bootstrapAgent(run, plistPath, label, retryDelayMs = 1000, onStarted = () => {}) {
  const bootstrap = () => run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath]);
  try { await bootstrap(); }
  catch (firstError) {
    await sleep(retryDelayMs);
    try { await bootstrap(); } catch (error) { error.firstError = firstError; throw error; }
  }
  onStarted();
  if (!await agentLoaded(run, label)) throw new Error('LaunchAgent registration could not be confirmed');
}

export async function repairAgent({ dataDir = DATA, plistPath = PLIST, label = LABEL,
  run = output, retryDelayMs = 1000 } = {}) {
  const config = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]));
  const args = config.ProgramArguments;
  if (config.Label !== label || !Array.isArray(args) || args.length !== 3
    || args[0] !== process.execPath || args[1] !== join(dataDir, 'runtime.mjs') || args[2] !== '--once'
    || config.RunAtLoad !== true || config.StartInterval !== 60) {
    throw new Error('LaunchAgent configuration is invalid; run --install from a verified KCT package');
  }
  const entry = await readFile(join(dataDir, 'runtime.mjs'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') throw new Error('Stable launcher is missing; run --install from a verified KCT package');
    throw error;
  });
  const { ENTRY_MARKER } = await import('./runtime-launcher.mjs');
  if (!entry.includes(ENTRY_MARKER)) {
    throw new Error('Stable launcher is missing; run --install from a verified KCT package');
  }
  const { readDeployment, verifyVersion } = await import('./runtime-launcher.mjs');
  const deployment = await readDeployment(dataDir);
  await verifyVersion(dataDir, deployment.current);
  if (await agentLoaded(run, label)) return { registered: true, repaired: false };
  await bootstrapAgent(run, plistPath, label, retryDelayMs);
  return { registered: true, repaired: true };
}

async function replaceFile(file, bytes) {
  const temp = `${file}.${process.pid}.next`;
  try {
    const handle = await open(temp, 'w', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
    const directory = await open(dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}

async function recoverMigration({ dataDir, journal, plistPath, label, run, allowMigration = true }) {
  const snapshot = await readFile(journal, 'utf8').then(JSON.parse, (error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!snapshot) return false;
  if (process.env.XPC_SERVICE_NAME === label || !allowMigration) {
    throw new Error('Interrupted LaunchAgent migration requires --install from a terminal session');
  }
  const loaded = await agentLoaded(run, label);
  if (loaded) await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
  for (const [file, value] of [[join(dataDir, 'runtime.mjs'), snapshot.entry],
    [plistPath, snapshot.plist], [join(dataDir, 'deployment.json'), snapshot.pointer]]) {
    if (value) await replaceFile(file, Buffer.from(value, 'base64'));
    else await rm(file, { force: true });
  }
  if (snapshot.wasLoaded && snapshot.plist) await bootstrapAgent(run, plistPath, label);
  await rm(journal, { force: true });
  return true;
}

export async function deploy({
  files: providedFiles, dataDir = DATA, plistPath = PLIST, label = LABEL,
  acquire, verify = verifyApp, run = output, platformCheck = assertInstallPlatform,
  retryDelayMs = 1000, checkSyntax = true, allowMigration = false,
} = {}) {
  platformCheck();
  await verify();
  const files = providedFiles ?? await readBundle(HERE);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = await (acquire ? acquire() : acquireLock(dataDir));
  if (!lock) throw new Error('Installation skipped: another runtime operation is in progress; retry shortly');
  const { detectLegacyInstall, stageLegacyMigration, storeVersion, switchVersion,
    readDeployment, atomicJSON } = await import('./runtime-launcher.mjs');
  const pointer = join(dataDir, 'deployment.json');
  const entry = join(dataDir, 'runtime.mjs');
  const journal = join(dataDir, '.migration.json');
  let stopped = false;
  let started = false;
  let changed = false;
  let oldEntry, oldPlist, oldPointer;
  try {
    await recoverMigration({ dataDir, journal, plistPath, label, run, allowMigration });
    const oldState = await readDeployment(dataDir).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    oldEntry = await readFile(entry).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    oldPlist = await readFile(plistPath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    oldPointer = await readFile(pointer).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    const plist = agentPlist(dataDir, label);
    const launcher = files.get('runtime-launcher.mjs');
    if (!launcher?.length) throw new Error('Runtime bundle missing runtime-launcher.mjs');
    // A v0.2.x install has no pointer and no launcher, so nothing below applies
    // until its five loose files are turned into a real version directory.
    const legacy = oldState ? null : await detectLegacyInstall(dataDir);
    const inService = process.env.XPC_SERVICE_NAME === label;
    if (legacy && !inService && allowMigration) {
      const loaded = await agentLoaded(run, label);
      await atomicJSON(journal, {
        entry: oldEntry?.toString('base64') ?? null, plist: oldPlist?.toString('base64') ?? null,
        pointer: null, wasLoaded: loaded, createdAt: new Date().toISOString(),
      });
      if (loaded) {
        await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
        stopped = true;
      }
      await stageLegacyMigration(dataDir, files, { checkSyntax });
      changed = true;
      await mkdir(dirname(plistPath), { recursive: true });
      await replaceFile(plistPath, plist);
      await bootstrapAgent(run, plistPath, label, retryDelayMs, () => { started = true; });
      await rm(journal, { force: true });
      console.log(`Runtime loader migrated from a v0.2.x install: ${dataDir}`);
      return;
    }
    if (legacy) {
      // Inside the running service — and for the automatic updater, which runs
      // from the same job — nothing may bootout. The stable entry is replaced
      // with the launcher in place, which is exactly the path the legacy plist
      // already invokes, so launchd needs no change and the current invocation
      // finishes normally. The next trigger goes through the launcher, which is
      // also what confirms the new version.
      await stageLegacyMigration(dataDir, files, { checkSyntax });
      // The plist file is updated either way; launchd keeps the configuration it
      // already loaded, so a live job is not disturbed and picks the new file up
      // on its next natural reload.
      await mkdir(dirname(plistPath), { recursive: true });
      await replaceFile(plistPath, plist);
      if (!await agentLoaded(run, label)) {
        await bootstrapAgent(run, plistPath, label, retryDelayMs, () => { started = true; });
      }
      console.log(`Runtime loader staged over a v0.2.x install; the next trigger confirms it: ${dataDir}`);
      return;
    }
    const migrate = !oldEntry?.equals(launcher) || oldPlist?.toString() !== plist;
    if (migrate && inService) {
      throw new Error('LaunchAgent migration must be started outside the running service');
    }
    if (migrate && !allowMigration) {
      throw new Error('LaunchAgent migration requires an explicit --install from a terminal session');
    }
    if (!migrate) {
      // A pending candidate is confirmed by the launcher, not by re-installing
      // over it: rewriting the pointer here would drop the first-start check.
      if (!oldState?.candidate) await switchVersion(dataDir, files, { checkSyntax });
      await repairAgent({ dataDir, plistPath, label, run, retryDelayMs });
      return;
    }
    const id = await storeVersion(dataDir, files, { checkSyntax });
    const loaded = await agentLoaded(run, label);
    await atomicJSON(journal, {
      entry: oldEntry?.toString('base64') ?? null, plist: oldPlist?.toString('base64') ?? null,
      pointer: oldPointer?.toString('base64') ?? null, wasLoaded: loaded,
      createdAt: new Date().toISOString(),
    });
    if (loaded) {
      await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
      stopped = true;
    }
    if (oldState) {
      await switchVersion(dataDir, files, { checkSyntax });
    } else {
      await atomicJSON(pointer, { current: id, previous: null, candidate: false, installedAt: new Date().toISOString() });
    }
    changed = true;
    await replaceFile(entry, launcher);
    await mkdir(dirname(plistPath), { recursive: true });
    await replaceFile(plistPath, plist);
    await bootstrapAgent(run, plistPath, label, retryDelayMs, () => { started = true; });
    await rm(journal, { force: true });
  } catch (error) {
    if (started) {
      await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`])
        .catch((failure) => { error.agentStopError = failure; });
    }
    if (changed) {
      try {
        for (const [file, bytes] of [[entry, oldEntry], [plistPath, oldPlist], [pointer, oldPointer]]) {
          if (bytes) await replaceFile(file, bytes);
          else await rm(file, { force: true });
        }
      } catch (failure) { error.rollbackError = failure; }
    }
    if (stopped && !error.rollbackError) {
      await bootstrapAgent(run, plistPath, label, retryDelayMs)
        .catch((failure) => { error.agentRestartError = failure; });
    }
    if (!error.rollbackError && !error.agentRestartError) await rm(journal, { force: true }).catch(() => {});
    throw error;
  } finally { await lock.release(); }
  console.log(`Runtime loader installed: ${dataDir}`);
}

// The v0.2.x updater only ever fetched its own five files, so it could replace
// every loose file with the new bundle and still leave no launcher and no
// pointer behind — an install that reports 0.3.0 while running the old layout.
//
// Nothing here touches launchd: the loose files are verified against the
// published manifest, the launcher is fetched from the same tag, and the entry
// is swapped in place. The next job trigger goes through the launcher, which is
// what confirms the version.
//
// The order matters and is the whole point of this function: a legacy install
// has no runtime-launcher.mjs, so nothing may import it before it has been
// fetched, verified and written. Detection and fetching use only what a legacy
// install already has.
const LAUNCHER = 'runtime-launcher.mjs';
// A legacy layout is recognised by its own file set, not by the launcher that
// is missing from it. Keeping the test here rather than importing it is what
// breaks the bootstrapping cycle.
//
// A single signature is not enough to tell the two entry points apart: this
// module mentions the launcher's signature in the checks it performs, so a
// literal match would classify the runtime as a launcher and send it looking for
// a dependency that a legacy install does not have. The runtime exports tick();
// the launcher never does.
const isLauncherEntry = (source) => source.includes('export async function launch(')
  && !source.includes('export async function tick(');

async function legacyLayout(dataDir, read = readFile, fileStat = stat) {
  const has = (name) => fileStat(join(dataDir, name)).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (await has('deployment.json')) return null;
  const present = [];
  for (const name of RUNTIME_FILES) {
    if (name === LAUNCHER) continue;
    if (await has(name)) present.push(name);
  }
  if (present.length !== RUNTIME_FILES.length - 1) return null;
  const entry = await read(join(dataDir, 'runtime.mjs'), 'utf8').catch(() => '');
  return { present, entry, isLauncher: isLauncherEntry(entry) };
}

export async function migrateLegacyInPlace({ dataDir = DATA, fetchImpl = fetch } = {}) {
  const layout = await legacyLayout(dataDir);
  if (!layout) return null;

  if (layout.isLauncher) {
    // The entry is already a launcher but the pointer is gone: rebuild both from
    // the local files. The launcher is present here, so importing it is safe.
    const { stageLegacyMigration } = await import('./runtime-launcher.mjs');
    const files = await readBundle(dataDir).catch(() => null);
    if (!files) throw new Error('Stable launcher is present but the version pointer is missing');
    return { adopted: true, ...(await stageLegacyMigration(dataDir, files, { checkSyntax: false })) };
  }

  const version = await localVersion();
  const manifest = await fetchManifest(versionedManifestUrl(version), { fetchImpl });
  const files = new Map();
  for (const name of RUNTIME_FILES) {
    if (name === LAUNCHER) continue;
    const bytes = await readFile(join(dataDir, name));
    if (hash(bytes) !== manifest.files[name]) {
      throw new Error(`Installed ${name} does not match v${version}; run --install from a verified package`);
    }
    files.set(name, bytes);
  }
  const launcher = (await downloadBundle(manifest, { fetchImpl, required: [LAUNCHER] })).get(LAUNCHER);
  if (!launcher?.length || hash(launcher) !== manifest.files[LAUNCHER]) {
    throw new Error(`Downloaded ${LAUNCHER} does not match v${version}`);
  }
  // Written before the import: the file has to exist on disk for the dynamic
  // import below to resolve. A failed write leaves the install untouched, so the
  // next start simply retries.
  await replaceFile(join(dataDir, LAUNCHER), launcher);
  const written = await readFile(join(dataDir, LAUNCHER));
  if (hash(written) !== manifest.files[LAUNCHER]) {
    throw new Error(`Installed ${LAUNCHER} failed verification after writing`);
  }

  files.set(LAUNCHER, written);
  const { stageLegacyMigration } = await import('./runtime-launcher.mjs');
  const staged = await stageLegacyMigration(dataDir, files);
  console.log(`[kct] migrated a v0.2.x install to the versioned loader: ${staged.current}`);
  return { version, ...staged };
}

export async function doctor({
  dataDir = DATA, plistPath = PLIST, label = LABEL, run = output,
  find = findProcesses, verify = verifyApp, attach = attachInspector, stateReader = readState,
} = {}) {
  const report = {
    installation: { evidence: 'live', status: 'unknown' },
    launchAgent: { evidence: 'live', status: 'unknown' },
    process: { evidence: 'live', status: 'unknown' },
    injection: { evidence: 'unknown', status: 'unknown' },
    page: { evidence: 'unknown', status: 'unknown' },
    translation: { evidence: 'unknown', status: 'unknown' },
    update: { evidence: 'history', status: 'unknown' },
  };
  try {
    const { readDeployment, verifyVersion } = await import('./runtime-launcher.mjs');
    const deployment = await readDeployment(dataDir);
    await verifyVersion(dataDir, deployment.current);
    const { ENTRY_MARKER } = await import('./runtime-launcher.mjs');
    const entry = await readFile(join(dataDir, 'runtime.mjs'), 'utf8');
    if (!entry.includes(ENTRY_MARKER)) throw new Error('Stable launcher is missing');
    report.installation = { evidence: 'live', status: 'complete', current: deployment.current,
      previous: deployment.previous, candidate: !!deployment.candidate };
    if (deployment.blocked) report.update.rollback = deployment.blocked;
  } catch (error) {
    report.installation = { evidence: 'live', status: 'incomplete', detail: error.message };
  }
  try {
    const config = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]));
    const args = config.ProgramArguments;
    const valid = config.Label === label && Array.isArray(args) && args.length === 3
      && args[0] === process.execPath && args[1] === join(dataDir, 'runtime.mjs') && args[2] === '--once'
      && config.RunAtLoad === true && config.StartInterval === 60;
    let loaded = false;
    let actual = '';
    try { actual = await run('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]); loaded = true; }
    catch (error) {
      if (!/could not find service|service.*not found/i.test(String(error.stderr ?? error.message))) throw error;
    }
    const loadedPathsMatch = !loaded || (actual.includes(args?.[0] ?? '\0') && actual.includes(args?.[1] ?? '\0'));
    report.launchAgent = { evidence: 'live', status: !valid || !loadedPathsMatch ? 'invalid'
      : loaded ? 'registered' : 'unregistered', configurationValid: valid, registered: loaded,
    };
  } catch (error) {
    report.launchAgent = { evidence: 'live', status: 'unknown', detail: error.message };
  }
  const historical = await stateReader().catch(() => ({}));
  report.update = { ...report.update, status: historical.updateStatus ?? 'unknown',
    lastAttemptAt: historical.lastUpdateAttemptAt ?? null, lastCheckAt: historical.lastUpdateCheckAt ?? null,
    version: historical.updateVersion ?? null, nextRetryAt: historical.updateNextRetryAt ?? null,
    detail: historical.updateError ?? null };
  report.lastAttempt = { evidence: 'history', status: historical.status ?? 'unknown',
    checkedAt: historical.checkedAt ?? null, detail: historical.detail ?? null };
  let processes;
  try { processes = await find(); }
  catch (error) {
    report.process = { evidence: 'unknown', status: 'unknown', detail: error.message };
    return report;
  }
  report.process = { evidence: 'live', status: processes.length === 1 ? 'found'
    : processes.length ? 'multiple' : 'not-running', count: processes.length };
  if (processes.length !== 1) return report;
  let lock;
  try { lock = await acquireLock(dataDir); }
  catch (error) {
    report.injection = { evidence: 'unknown', status: 'unknown', detail: error.message };
    return report;
  }
  if (!lock) {
    report.injection = { evidence: 'live', status: 'busy',
      detail: 'Another runtime operation is in progress; retry shortly' };
    return report;
  }
  try {
    const app = await verify();
    const inspector = await attach(processes[0], app);
    let result;
    try {
      result = await inspector.evaluate(`(async () => {
        const hook = globalThis.__kctRuntimeHook;
        if (!hook) return { present: false };
        return { present: true, revision: hook.revision,
          health: typeof hook.health === 'function' ? await hook.health() : null };
      })()`);
    } finally { await inspector.close(); }
    report.injection = { evidence: 'live', status: result?.present ? 'loaded' : 'missing',
      revision: result?.revision ?? null, inspectorClosed: true };
    if (!result?.present || !result.health) return report;
    const pages = result.health.pages ?? [];
    const loaded = pages.filter((page) => page?.loaded === true);
    const stale = loaded.filter((page) => page.stale === true || page.revision !== result.revision);
    const health = loaded.map((page) => page.health).filter(Boolean);
    const invalid = health.reduce((count, page) => count + page.unsupported, 0);
    const blocks = health.reduce((count, page) => count + page.blocks, 0);
    const mounted = health.reduce((count, page) => count + page.mounted, 0);
    report.injection = { ...report.injection, staleRenderers: stale.length };
    report.page = { evidence: 'live', status: stale.length ? 'stale-renderer'
      : invalid ? 'unsupported-structure'
        : mounted ? 'mounted' : blocks ? 'unmounted' : health.length ? 'no-thinking-blocks' : 'unknown',
    pages: pages.length, loaded: loaded.length, stale: stale.length,
    revisions: [...new Set(pages.map((page) => page.revision ?? null))],
    blocks, mounted, unsupported: invalid };
    const failures = health.reduce((count, page) => count + page.failed, 0);
    const translated = health.reduce((count, page) => count + page.translated, 0);
    report.translation = { evidence: health.length ? 'live' : 'unknown', status: failures ? 'error'
      : translated ? 'working' : health.length && health.every((page) => !page.enabled) ? 'disabled' : 'unconfirmed',
    translated, failures };
  } catch (error) {
    report.injection = { evidence: 'unknown', status: 'unknown', detail: error.message };
  } finally { await lock.release(); }
  return report;
}

export async function reloadStalePages({
  dataDir = DATA, find = findProcesses, verify = verifyApp, attach = attachInspector,
} = {}) {
  const lock = await acquireLock(dataDir);
  if (!lock) throw new Error('Another runtime operation is in progress; retry shortly');
  try {
    const processes = await find();
    if (processes.length !== 1) {
      throw new Error(processes.length ? 'Multiple Kimi main processes; refresh skipped'
        : 'Kimi Code is not running; refresh skipped');
    }
    const app = await verify();
    const inspector = await attach(processes[0], app);
    try {
      return await inspector.evaluate(`(async () => {
        const hook = globalThis.__kctRuntimeHook;
        if (!hook) return { present: false, reloaded: 0, stale: [] };
        if (typeof hook.reloadStale !== 'function') {
          return { present: true, reloaded: 0, stale: 'unknown',
            detail: 'Installed hook is too old to refresh pages; refresh the window manually' };
        }
        return { present: true, ...(await hook.reloadStale()) };
      })()`);
    } finally { await inspector.close(); }
  } finally { await lock.release(); }
}

async function main() {
  const arg = process.argv[2];
  if (process.argv.length !== 3
    || !['--once', '--check', '--doctor', '--repair', '--refresh', '--install', '--disable', '--update'].includes(arg)) {
    throw new Error('Use --install, --check, --doctor, --repair, --refresh, --once, --update or --disable');
  }
  if (arg === '--install') return deploy({ allowMigration: true });
  if (arg === '--check') return console.log(JSON.stringify(await readState(), null, 2));
  if (arg === '--doctor') return console.log(JSON.stringify(await doctor(), null, 2));
  if (arg === '--repair') return console.log(JSON.stringify(await repairAgent(), null, 2));
  if (arg === '--refresh') return console.log(JSON.stringify(await reloadStalePages(), null, 2));
  if (arg === '--update') {
    await mkdir(DATA, { recursive: true, mode: 0o700 });
    const lock = await acquireLock();
    if (!lock) throw new Error('Another runtime operation is in progress; retry shortly');
    try {
      const result = await selfUpdate({ currentVersion: await localVersion(),
        cacheDir: join(DATA, '.download-cache'),
        deployFn: ({ files, dataDir }) => deploy({ files, dataDir, allowMigration: true,
          acquire: async () => ({ release: async () => {} }) }) });
      console.log(JSON.stringify(result, null, 2));
    } finally { await lock.release(); }
    return;
  }
  if (arg === '--disable') {
    const domain = `gui/${process.getuid()}/${LABEL}`;
    try {
      await output('/bin/launchctl', ['print', domain]);
      await output('/bin/launchctl', ['bootout', domain]);
    } catch (error) {
      if (!/could not find service|service.*not found/i.test(String(error.stderr ?? error.message))) throw error;
    }
    await rm(PLIST, { force: true });
    console.log('Runtime auto-loading disabled. In-memory translation ends when Kimi next quits.');
    return;
  }
  await mkdir(DATA, { recursive: true, mode: 0o700 });
  const lock = await acquireLock();
  if (!lock) { process.exitCode = 75; return; }
  try {
    // A half-migrated install is repaired before the tick, so the run that
    // notices it is also the run that fixes it.
    await migrateLegacyInPlace().catch((error) => {
      console.error(`[kct] legacy migration deferred: ${error.message}`);
    });
    const state = await tick({ update: { version: await localVersion(), dataDir: DATA, updateCheck: true,
      resolveUpdateFn: (current) => resolveUpdate({ current }),
      applyUpdate: async (manifest, dataDir) => {
        const cacheDir = join(dataDir, '.download-cache');
        const files = await downloadBundle(manifest, { cacheDir });
        await deploy({ files, dataDir, allowMigration: false,
          acquire: async () => ({ release: async () => {} }) });
        await rm(cacheDir, { recursive: true, force: true });
        return true;
      } } });
    await writeRunResult(state);
  } catch (error) {
    await writeRunResult(null, error).catch(() => {});
    throw error;
  } finally { await lock.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[kct] ${error.message}`);
    for (const key of ['rollbackError', 'plistRestoreError', 'agentRestartError']) {
      if (error[key]) console.error(`[kct] ${key}: ${error[key].message}`);
    }
    process.exitCode = 1;
  });
}
