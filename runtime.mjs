#!/usr/bin/env node
// The official app stays sealed; only the running, verified main process is touched.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { installRuntimeHook } from './runtime-hook.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
export const APP = '/Applications/Kimi Code.app';
const EXECUTABLE = join(APP, 'Contents/MacOS/Kimi Code');
const FRAMEWORK = join(APP, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
export const DATA = join(homedir(), 'Library/Application Support/kimi-cot-translate');
const STATE = join(DATA, 'runtime-state.json');
const LABEL = 'com.user.kimi-cot-translate.runtime';
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CORE_FILES = ['runtime.mjs', 'runtime-hook.mjs', 'supported-runtimes.json', 'kct.js'];
const SETTLED = new Set(['active', 'error', 'blocked-inspector']);
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

export function parseProcess(text) {
  const fields = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*?)\s*$/.exec(text);
  if (!fields) throw new Error('Cannot identify the Kimi main process');
  return { pid: Number(fields[1]), uid: Number(fields[2]), started: fields[3], executable: fields[4] };
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

export async function findProcesses() {
  const pids = await output('/usr/bin/pgrep', ['-x', 'Kimi Code']).catch((error) => {
    if (error.code === 1) return '';
    throw error;
  });
  const found = [];
  for (const id of pids.trim().split(/\s+/).filter(Boolean)) {
    const info = await processIdentity(Number(id)).catch(() => null);
    if (info?.uid === process.getuid() && info.executable === EXECUTABLE) found.push(info);
  }
  return found;
}

export async function portOpen() {
  return new Promise((resolvePort) => {
    const socket = connect({ host: '127.0.0.1', port: 9229 });
    const finish = (value) => { socket.destroy(); resolvePort(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(true));
  });
}

export function inspectFuses(binary) {
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const at = binary.indexOf(sentinel);
  if (at < 0 || binary[at + sentinel.length] !== 1) throw new Error('Unknown Electron fuse layout');
  if (binary[at + sentinel.length + 1] < 4 || binary[at + sentinel.length + 2 + 3] !== 49) {
    throw new Error('Node inspector signal support is disabled');
  }
}

export function assertRendererContract(css) {
  for (const selector of ['think', 'think-head', 'think-body', 'think-body-inner', 'think-text']) {
    if (!new RegExp(`\\.${selector}(?:\\[|[\\s.{:#>])`).test(css)) {
      throw new Error('Kimi reasoning UI changed; translation is disabled until compatibility is checked');
    }
  }
}

export async function verifyApp() {
  const before = await fingerprint(EXECUTABLE);
  await output('/usr/bin/codesign', ['--verify', '--deep', '--strict', APP]);
  const signature = await run('/usr/bin/codesign', ['-dv', '--verbose=2', APP], { timeout: 10000 });
  if (!/^Identifier=com\.kimi\.code\.desktop$/m.test(signature.stderr)
    || !/^TeamIdentifier=2J9472RW75$/m.test(signature.stderr)) {
    throw new Error('Application does not have the expected official signing identity');
  }
  const binary = await readFile(FRAMEWORK);
  const supported = JSON.parse(await readFile(join(HERE, 'supported-runtimes.json'), 'utf8'));
  const runtime = supported.find((item) => item.sha256 === hash(binary));
  if (!runtime) throw new Error('New Electron runtime needs an isolated compatibility check; Kimi is left untouched');
  inspectFuses(binary);
  const version = (await output('/usr/libexec/PlistBuddy', [
    '-c', 'Print :CFBundleShortVersionString', join(APP, 'Contents/Info.plist'),
  ])).trim();
  const dist = join(APP, 'Contents/Resources/desktop-dist');
  const index = await readFile(join(dist, 'index.html'), 'utf8');
  const assets = [...index.matchAll(/href="(\/assets\/[A-Za-z0-9_-]+\.css)"/g)].map((item) => item[1]);
  assertRendererContract((await Promise.all(assets.map((name) => readFile(join(dist, name), 'utf8')))).join('\n'));
  if (before !== await fingerprint(EXECUTABLE)) throw new Error('Application changed during verification');
  return { version, electron: runtime.electron, executable: before };
}

async function verifyLiveProcess(info, app) {
  assertIdentity(await processIdentity(info.pid), info);
  if (await fingerprint(EXECUTABLE) !== app.executable) throw new Error('Application changed during attachment');
  const files = await output('/usr/sbin/lsof', ['-nP', '-a', '-p', String(info.pid), '-d', 'txt', '-Fin']);
  const inode = (await stat(EXECUTABLE)).ino;
  if (!files.includes(`i${inode}\nn${EXECUTABLE}\n`)) throw new Error('Running executable does not match the verified app');
}

export async function attachInspector(info, app, operations = {}) {
  const verifyLive = operations.verifyLiveProcess ?? verifyLiveProcess;
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
  if (await portOpen()) throw new Error('Inspector port 9229 is occupied; refusing to attach');
  await verifyLive(info, app);
  let socket;
  let counter = 0;
  let closed = false;
  const pending = new Map();
  let evaluate;
  const loaderRequire = `(typeof require === 'function' ? require : process.mainModule.require.bind(process.mainModule))`;
  const closeExpression = `if(process.pid===${info.pid} && process.type==='browser'){
    clearTimeout(globalThis.__kctInspectorDeadline);
    setTimeout(()=>${loaderRequire}('node:inspector').close(),25);}true`;
  try {
    await trigger(info);
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
    if (identity?.pid !== info.pid || identity.type !== 'browser' || identity.electron !== app.electron) {
      throw new Error('Inspector identity mismatch');
    }
    return {
      evaluate,
      async close() {
        if (!closed) {
          await evaluate(closeExpression).catch(() => {});
        }
        for (let attempt = 0; attempt < 150 && await portOpen(); attempt++) await sleep(100);
        socket.close();
        if (await portOpen()) {
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
    if (await portOpen()) {
      for (let attempt = 0; attempt < 150 && await portOpen(); attempt++) await sleep(100);
    }
    socket?.close();
    if (await portOpen()) {
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
    if (!result?.loaded) throw new Error('No main Kimi renderer accepted the translation script');
    return result;
  } finally { await inspector.close(); }
}

async function readState() {
  try { return JSON.parse(await readFile(STATE, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

async function saveState(state) {
  const next = JSON.stringify(state, null, 2) + '\n';
  const old = await readFile(STATE, 'utf8').catch(() => '');
  if (next === old) return;
  await writeFile(`${STATE}.next`, next, { mode: 0o600 });
  await rename(`${STATE}.next`, STATE);
}

function waitingState(detail, now = Date.now(), extra = {}) {
  return { status: 'waiting', detail, checkedAt: new Date(now).toISOString(), ...extra };
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

export async function tick(deps = {}) {
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
  const processes = await find();
  const beforeWait = await previousState().catch(() => ({}));
  const preserved = matchedAttempt(beforeWait);
  const waiting = (detail, extra = {}, now = Date.now()) => {
    const state = waitingState(detail, now, { ...extra, ...(preserved ? { attempt: preserved } : {}) });
    return state;
  };
  if (!processes.length) {
    const state = waiting('Kimi Code is not running', {}, now());
    await save(state);
    return state;
  }
  if (processes.length !== 1) {
    const state = waiting('Multiple Kimi main processes; waiting for one default instance',
      { identity: processSetIdentity(processes) }, now());
    await save(state);
    return state;
  }
  const info = processes[0];
  const source = await read(join(HERE, 'kct.js'), 'utf8');
  const supported = await read(join(HERE, 'supported-runtimes.json'), 'utf8');
  const loader = await read(new URL(import.meta.url), 'utf8');
  const revision = runtimeRevision(source, supported, installRuntimeHook.toString(), loader);
  const identity = `${info.pid}:${info.started}:${await fileFingerprint(EXECUTABLE)}`;
  const reusable = matchedAttempt(beforeWait, identity, revision);
  if (reusable) {
    const restored = { ...reusable, checkedAt: new Date(now()).toISOString() };
    await save(restored);
    return restored;
  }
  const nowValue = now();
  const wait = async (detail, extra = {}) => {
    const state = waiting(detail, extra, nowValue);
    await save(state);
    return state;
  };
  const args = await command('/bin/ps', ['-p', String(info.pid), '-o', 'command=']);
  if (args.includes('--user-data-dir') || args.includes('--remote-debugging') || args.includes('--inspect')) {
    return wait('A test or debugging instance is running; skipped');
  }
  if (now() - Date.parse(info.started) < 5000) return wait('Kimi is starting');
  // No retry storm: make at most one signal attempt for a process and script revision.
  const state = { identity, revision, pid: info.pid, status: 'checking', checkedAt: new Date(now()).toISOString() };
  await save(state);
  try {
    const app = await verify();
    state.appVersion = app.version;
    // A busy port is a retryable external condition; no signal has been sent yet.
    if (await checkPort()) {
      return wait('Inspector port 9229 is in use; no signal sent', { appVersion: app.version });
    }
    const result = await install(info, app, source, revision);
    state.status = 'active';
    state.loaded = result.loaded;
    state.inspectorClosed = true;
  } catch (error) {
    state.status = error.inspectorOpen ? 'blocked-inspector' : 'error';
    state.detail = error.message;
  }
  await save(state);
  console.log(JSON.stringify(state));
  return state;
}

async function acquireLock(dataDir = DATA) {
  const lock = join(dataDir, '.runtime-lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pidText = await readFile(join(lock, 'pid'), 'utf8').catch(() => '');
    const pid = Number(pidText);
    if (pidText.trim() && pid) {
      try {
        process.kill(pid, 0);
        return null;
      } catch (error) {
        if (error.code === 'ESRCH') {
          await rm(lock, { recursive: true });
          return acquireLock(dataDir);
        }
        if (error.code === 'EPERM') return null;
        throw error;
      }
    }
    if (Date.now() - (await stat(lock)).mtimeMs < 60000) return null;
    await rm(lock, { recursive: true });
    return acquireLock(dataDir);
  }
  await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
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

export async function switchBundle({
  dataDir,
  stageDir,
  backupDir,
  names = CORE_FILES,
  renameFile = rename,
}) {
  backupDir ??= await mkdtemp(join(dataDir, '.deploy-backup-'));
  const backedUp = [];
  const installed = [];
  const missing = [];
  let rolledBack = false;

  const rollback = async () => {
    const failures = [];
    for (const name of [...installed].reverse()) {
      try { await rm(join(dataDir, name), { force: true }); } catch (error) { failures.push(error); }
    }
    for (const name of [...backedUp].reverse()) {
      try { await renameFile(join(backupDir, name), join(dataDir, name)); } catch (error) { failures.push(error); }
    }
    for (const name of missing) {
      try { await rm(join(dataDir, name), { force: true }); } catch (error) { failures.push(error); }
    }
    if (!failures.length) {
      try { await rm(backupDir, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Deployment rollback failed');
    rolledBack = true;
  };

  try {
    for (const name of names) {
      try {
        await renameFile(join(dataDir, name), join(backupDir, name));
        backedUp.push(name);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing.push(name);
      }
    }
    for (const name of names) {
      await renameFile(join(stageDir, name), join(dataDir, name));
      installed.push(name);
    }
  } catch (error) {
    try { await rollback(); } catch (rollbackError) { error.rollbackError = rollbackError; }
    throw error;
  }

  return {
    async rollback() {
      if (!rolledBack) await rollback();
    },
    async commit() {
      if (rolledBack) return;
      await rm(backupDir, { recursive: true, force: true });
    },
  };
}

export async function deploy({
  files: providedFiles,
  dataDir = DATA,
  plistPath = PLIST,
  label = LABEL,
  acquire,
  verify = verifyApp,
  run = output,
  fileStat = stat,
  commit,
  platformCheck = assertInstallPlatform,
} = {}) {
  platformCheck();
  await verify();
  const files = providedFiles ?? await readBundle(HERE);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = await (acquire ? acquire() : acquireLock(dataDir));
  if (!lock) throw new Error('Installation skipped: another runtime operation is in progress; retry shortly');
  let switched;
  let staged;
  let hadAgent = false;
  let plistChanged = false;
  let stoppedJob = false;
  let keepPlistBackup = false;
  const log = join(dataDir, 'runtime.log');
  const plistBackup = join(dataDir, '.runtime-plist.backup');
  try {
    staged = await stageBundle(dataDir, files);
    hadAgent = await fileStat(plistPath).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (hadAgent) {
      await writeFile(plistBackup, await readFile(plistPath), { mode: 0o600 });
      const domain = `gui/${process.getuid()}/${label}`;
      let loaded = true;
      try { await run('/bin/launchctl', ['print', domain]); }
      catch (error) {
        if (!/could not find service|service.*not found/i.test(String(error.stderr ?? error.message))) throw error;
        loaded = false;
      }
      if (loaded) {
        await run('/bin/launchctl', ['bootout', domain]);
        stoppedJob = true;
      }
    }
    switched = await switchBundle({ dataDir, stageDir: staged });
    await verifyBundle(dataDir, files);
    await mkdir(dirname(plistPath), { recursive: true });
    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(dataDir, 'runtime.mjs'))}</string><string>--once</string></array>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>10</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`;
    const plistNext = `${plistPath}.next`;
    try {
      await writeFile(plistNext, contents, { mode: 0o600 });
      await rename(plistNext, plistPath);
      plistChanged = true;
    } catch (error) {
      await rm(plistNext, { force: true }).catch(() => {});
      throw error;
    }
    await run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath]);
    const completed = switched;
    switched = undefined;
    await (commit ? commit(completed) : completed.commit()).catch((commitError) => {
      console.warn(`[kct] deployment backup cleanup failed: ${commitError.message}`);
    });
  } catch (error) {
    if (switched) {
      try { await switched.rollback(); } catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    if (plistChanged) {
      try {
        if (hadAgent) await rename(plistBackup, plistPath);
        else await rm(plistPath, { force: true });
      } catch (plistError) {
        error.plistRestoreError = plistError;
        keepPlistBackup = hadAgent;
      }
    }
    if (stoppedJob && !error.rollbackError && !error.plistRestoreError) {
      await run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath])
        .catch((restartError) => { error.agentRestartError = restartError; });
    }
    throw error;
  } finally {
    await lock.release();
    if (!keepPlistBackup) await rm(plistBackup, { force: true }).catch(() => {});
    if (staged) await rm(staged, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`Runtime loader installed: ${dataDir}`);
}

async function main() {
  const arg = process.argv[2];
  if (process.argv.length !== 3 || !['--once', '--check', '--install', '--disable'].includes(arg)) {
    throw new Error('Use --install, --check, --once or --disable');
  }
  if (arg === '--install') return deploy();
  if (arg === '--check') return console.log(JSON.stringify(await readState(), null, 2));
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
  if (!lock) return;
  try {
    await tick();
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
