import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { findProcesses, windowsPaths } from './runtime-windows.mjs';

const run = promisify(execFile);
const enabled = process.platform === 'win32' && process.env.KCT_WINDOWS_LIVE === '1';

function inspectorOpen() {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: 9229 });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(true));
  });
}

async function loader(arg) {
  return run(process.execPath, ['runtime-windows.mjs', arg], {
    timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
}

async function stopOwned(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await run('taskkill.exe', ['/PID', String(child.pid), '/T'], {
    windowsHide: true, timeout: 10000,
  }).catch(() => {});
  for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
  if (child.exitCode === null && child.signalCode === null) {
    await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, timeout: 10000,
    }).catch(() => {});
  }
}

test('verified Windows Kimi attaches, installs without restart, disables and recovers', {
  skip: !enabled,
  timeout: 180000,
}, async (t) => {
  const exe = join(process.env.LOCALAPPDATA, 'Programs', 'Kimi Code', 'Kimi Code.exe');
  const { dataDir } = windowsPaths();
  await assert.rejects(stat(dataDir), { code: 'ENOENT' }, 'live test requires fresh plugin data');
  const before = createHash('sha256').update(await readFile(exe)).digest('hex');
  assert.equal(before, '9c6aac3196d3fb2a62e3ff67e6add9f24238efddf661cfcc7088b120f7e478e9');
  assert.equal(await inspectorOpen(), false, 'test needs a free inspector port');
  let child;
  let installationAttempted = false;
  t.after(async () => {
    if (installationAttempted) await loader('--disable').catch(() => {});
    await stopOwned(child);
  });
  const pids = [];
  for (let cycle = 0; cycle < 2; cycle++) {
    assert.equal((await findProcesses()).length, 0, 'refusing to start alongside an existing Kimi instance');
    child = spawn(exe, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    child.stdout.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000); });
    child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000); });
    let spawnError;
    child.once('error', (error) => { spawnError = error; });
    pids.push(child.pid);
    let state;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, `app exited early: ${diagnostics}`);
      const found = await findProcesses();
      if (!found.length) {
        await sleep(1000);
        continue;
      }
      assert.deepEqual(found.map((info) => info.pid), [child.pid], 'refusing to attach to a process this test did not start');
      assert.equal(child.exitCode, null, `test process exited before attachment: ${diagnostics}`);
      const attached = await loader('--once');
      const checked = await loader('--check');
      state = JSON.parse(checked.stdout);
      if (state.status === 'active') break;
      assert.ok(!['error', 'blocked-inspector'].includes(state.status),
        `${JSON.stringify(state)}\n${attached.stdout}\n${diagnostics}`);
      await sleep(1000);
    }
    assert.equal(state?.status, 'active', JSON.stringify(state));
    assert.equal(state.pid, child.pid);
    assert.ok(state.loaded >= 1);
    assert.equal(state.inspectorClosed, true);
    assert.equal(await inspectorOpen(), false);
    const snapshot = JSON.stringify(state);
    await loader('--once');
    const unchanged = JSON.parse((await loader('--check')).stdout);
    assert.equal(unchanged.pid, state.pid);
    assert.equal(unchanged.revision, state.revision);
    assert.equal(unchanged.status, 'active', snapshot);
    if (cycle === 0) {
      installationAttempted = true;
      await loader('--install');
      let watched;
      for (let attempt = 0; attempt < 20; attempt++) {
        watched = JSON.parse((await loader('--check')).stdout);
        if (watched.checkedAt !== unchanged.checkedAt) break;
        await sleep(1000);
      }
      assert.equal(watched.status, 'active', JSON.stringify(watched));
      assert.notEqual(watched.checkedAt, unchanged.checkedAt, 'scheduled watcher did not run');
      assert.equal(child.exitCode, null, 'installation restarted the app');
      assert.deepEqual((await findProcesses()).map((info) => info.pid), [child.pid]);
      await loader('--disable');
      for (let attempt = 0; attempt < 20; attempt++) {
        const locked = await stat(join(dataDir, '.runtime-lock')).then(() => true,
          (error) => { if (error.code === 'ENOENT') return false; throw error; });
        if (!locked) break;
        await sleep(1000);
      }
      await assert.rejects(stat(join(dataDir, '.runtime-lock')), { code: 'ENOENT' });
      installationAttempted = false;
      assert.equal(child.exitCode, null, 'disabling the extension terminated the app');
    }
    await stopOwned(child);
    assert.equal(await inspectorOpen(), false);
  }
  assert.notEqual(pids[0], pids[1]);
  assert.equal(createHash('sha256').update(await readFile(exe)).digest('hex'), before);
});
