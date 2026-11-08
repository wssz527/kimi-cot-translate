import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { installRuntimeHook } from './runtime-hook.mjs';

const install = Function(`return (${installRuntimeHook.toString()});`)();
const SOURCE_V1 = '(() => { window.__kct = { revision: 1 }; })();';
const SOURCE_V2 = '(() => { window.__kct = { revision: 2 }; })();';
const isProbe = (source) => source.includes('loaded: !!window.__kct') && !source.includes('__kct.health');
// rendererBootstrap only stamps __kctRuntimeRevision when the page was not
// already mounted, so the mock records the revision the hook was installed with.
let hookRevision = null;
const installHook = (api, source, revision) => {
  hookRevision = revision;
  return install(api, source, revision);
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

class MockWebContents extends EventEmitter {
  constructor(url, execute) {
    super();
    this.url = url;
    this.destroyed = false;
    this.installed = false;
    this.revision = null;
    this.nextRevision = null;
    this.health = null;
    this.reloads = 0;
    this.calls = [];
    this.execute = execute ?? (async (source, wc) => {
      if (isProbe(source)) return { loaded: wc.installed, revision: wc.revision };
      if (source.includes('__kct.health')) {
        return { loaded: wc.installed, revision: wc.revision, health: wc.health };
      }
      if (!wc.installed) {
        wc.installed = true;
        wc.revision = wc.nextRevision ?? hookRevision;
      }
      return undefined;
    });
  }

  getURL() {
    return this.url;
  }

  isDestroyed() {
    return this.destroyed;
  }

  executeJavaScript(source) {
    this.calls.push(source);
    return this.execute(source, this);
  }

  reload() {
    this.reloads += 1;
  }

  count(source) {
    return this.calls.filter((item) => item === source).length;
  }

  probes() {
    return this.calls.filter(isProbe).length;
  }
}

function runtime(urls = []) {
  const app = new EventEmitter();
  const contents = urls.map((url) => new MockWebContents(url));
  return {
    app,
    contents,
    webContents: { getAllWebContents: () => contents },
  };
}

function retireHook(t) {
  t.after(() => {
    try {
      globalThis.__kctRuntimeHook?.dispose?.();
    } catch {
      // Cleanup must not mask the test result.
    }
    delete globalThis.__kctRuntimeHook;
  });
}

test('the exported hook survives toString serialization', () => {
  assert.equal(typeof installRuntimeHook, 'function');
  assert.equal(typeof install, 'function');
});

test('only the app renderer allowlist is executed', async (t) => {
  retireHook(t);
  const allowed = [
    'app://renderer/',
    'app://renderer/index.html',
    'app://renderer/index.html?theme=dark',
    'app://renderer/index.html#session',
    'app://renderer/sessions/session_12-A',
  ];
  const blocked = [
    'https://renderer/index.html',
    'file:///index.html',
    'app://other/index.html',
    'app://renderer:444/index.html',
    'app://user:pass@renderer/index.html',
    'app://renderer/screenshot.html',
    'app://renderer/browser-overlay.html',
    'app://renderer/sessions/bad.value',
    'app://renderer/sessions/ok/extra',
    'app://renderer/index.html/extra',
  ];
  const r = runtime([...allowed, ...blocked]);
  const summary = await installHook({ app: r.app, webContents: r.webContents }, SOURCE_V1, 'urls');

  assert.deepEqual(summary, { revision: 'urls', attached: allowed.length, loaded: allowed.length, stale: 0 });
  for (const wc of r.contents.slice(0, allowed.length)) {
    assert.equal(wc.calls.length, 2, wc.getURL());
    assert.equal(wc.calls[0], SOURCE_V1, wc.getURL());
    assert.ok(isProbe(wc.calls[1]), wc.getURL());
  }
  for (const wc of r.contents.slice(allowed.length)) {
    assert.deepEqual(wc.calls, [], wc.getURL());
  }
});

test('reinstalling the same revision is idempotent', async (t) => {
  retireHook(t);
  const r = runtime(['app://renderer/index.html']);
  const wc = r.contents[0];
  const first = installHook({ app: r.app, webContents: r.webContents }, SOURCE_V1, 'same');
  const second = installHook({ app: r.app, webContents: r.webContents }, SOURCE_V1, 'same');
  const [a, b] = await Promise.all([first, second]);
  const c = await installHook({ app: r.app, webContents: r.webContents }, SOURCE_V1, 'same');

  assert.deepEqual(a, { revision: 'same', attached: 1, loaded: 1, stale: 0 });
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  assert.equal(r.app.listenerCount('web-contents-created'), 1);
  assert.equal(wc.listenerCount('did-finish-load'), 1);
  assert.equal(wc.count(SOURCE_V1), 1);
  assert.equal(wc.probes(), 1);
});

test('reload installs the source again for the same webContents', async (t) => {
  retireHook(t);
  const r = runtime(['app://renderer/sessions/reload']);
  const wc = r.contents[0];
  await installHook({ app: r.app, webContents: r.webContents }, SOURCE_V1, 'reload');
  wc.emit('did-finish-load');
  await flush();

  assert.equal(wc.count(SOURCE_V1), 2);
  assert.equal(wc.probes(), 2);
  assert.equal(globalThis.__kctRuntimeHook.wired.size, 1);
});

test('health flags an older renderer revision and refresh reloads only that page', async (t) => {
  retireHook(t);
  const r = runtime(['app://renderer/index.html', 'app://renderer/sessions/two']);
  const [fresh, old] = r.contents;
  fresh.nextRevision = 'v1';
  old.nextRevision = 'v1';
  await installHook({ app: r.app, webContents: r.webContents }, SOURCE_V1, 'v1');
  old.revision = 'v0';

  const health = await globalThis.__kctRuntimeHook.health();
  assert.equal(health.pages.length, 2);
  assert.equal(health.pages[0].stale, false);
  assert.equal(health.pages[0].revision, 'v1');
  assert.equal(health.pages[1].stale, true);
  assert.equal(health.pages[1].revision, 'v0');

  const refresh = await globalThis.__kctRuntimeHook.reloadStale();
  assert.deepEqual(refresh, { revision: 'v1', reloaded: 1, stale: ['v0'] });
  assert.equal(fresh.reloads, 0);
  assert.equal(old.reloads, 1);
});

test('refresh does nothing when every page already runs the current revision', async (t) => {
  retireHook(t);
  const r = runtime(['app://renderer/index.html']);
  const wc = r.contents[0];
  wc.nextRevision = 'v1';
  await installHook({ app: r.app, webContents: r.webContents }, SOURCE_V1, 'v1');
  const refresh = await globalThis.__kctRuntimeHook.reloadStale();
  assert.deepEqual(refresh, { revision: 'v1', reloaded: 0, stale: [] });
  assert.equal(wc.reloads, 0);
});

test('source rejection is contained and leaves future pages working', async (t) => {
  retireHook(t);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => { console.warn = originalWarn; });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const r = runtime(['app://renderer/index.html']);
  const broken = r.contents[0];
  broken.execute = async (source) => {
    if (source === SOURCE_V1) throw new Error('token=secret');
    return true;
  };
  const summary = await installHook({ app: r.app, webContents: r.webContents }, SOURCE_V1, 'error');
  await flush();

  assert.deepEqual(summary, { revision: 'error', attached: 1, loaded: 0, stale: 0 });
  assert.equal(unhandled.length, 0);
  assert.equal(r.app.listenerCount('web-contents-created'), 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], '[kct-runtime] renderer hook failed');
  assert.doesNotMatch(warnings[0], /secret|SOURCE_V1|window\.__kct/);

  const next = new MockWebContents('app://renderer/sessions/next');
  r.app.emit('web-contents-created', {}, next);
  next.emit('did-finish-load');
  await flush();
  assert.equal(next.count(SOURCE_V1), 1);
  assert.equal(next.probes(), 1);
});

test('a five-second timeout is contained, including a late rejection', async (t) => {
  retireHook(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const r = runtime(['app://renderer/index.html']);
  const wc = r.contents[0];
  let rejectLate;
  let firstSource = true;
  wc.execute = async (source) => {
    if (isProbe(source)) return { loaded: true, revision: 'timeout' };
    if (firstSource) {
      firstSource = false;
      return new Promise((_resolve, reject) => { rejectLate = reject; });
    }
    return undefined;
  };
  const pending = installHook({ app: r.app, webContents: r.webContents }, SOURCE_V1, 'timeout');
  t.mock.timers.tick(5000);
  const summary = await pending;

  assert.deepEqual(summary, { revision: 'timeout', attached: 1, loaded: 0, stale: 0 });
  assert.equal(wc.probes(), 0);
  assert.equal(r.app.listenerCount('web-contents-created'), 1);
  wc.emit('did-finish-load');
  await flush();
  assert.equal(wc.count(SOURCE_V1), 1, 'a timed-out run must finish before the next run');
  rejectLate(new Error('token=late-secret'));
  await flush();
  assert.equal(unhandled.length, 0);
  assert.equal(wc.count(SOURCE_V1), 2);
  assert.equal(wc.probes(), 1);
});

test('a newer revision reports an old page as stale instead of loaded', async (t) => {
  retireHook(t);
  const r = runtime(['app://renderer/index.html']);
  const wc = r.contents[0];
  await installHook({ app: r.app, webContents: r.webContents }, SOURCE_V1, 'v1');
  const oldAppListener = r.app.listeners('web-contents-created')[0];
  const oldLoadListener = wc.listeners('did-finish-load')[0];

  const summary = await installHook({ app: r.app, webContents: r.webContents }, SOURCE_V2, 'v2');
  assert.equal(summary.loaded, 0, 'a page still running v1 is not a loaded v2 renderer');
  assert.equal(summary.stale, 1, 'it is reported as stale instead');
  assert.deepEqual(summary, { revision: 'v2', attached: 1, loaded: 0, stale: 1 });
  assert.equal(r.app.listenerCount('web-contents-created'), 1);
  assert.equal(wc.listenerCount('did-finish-load'), 1);
  assert.notEqual(r.app.listeners('web-contents-created')[0], oldAppListener);
  assert.notEqual(wc.listeners('did-finish-load')[0], oldLoadListener);
  assert.equal(wc.count(SOURCE_V1), 1);
  assert.equal(wc.count(SOURCE_V2), 0);
  assert.equal(wc.probes(), 2, 'the new revision probes once without replacing the old UI');

  wc.emit('did-finish-load');
  await flush();
  assert.equal(wc.count(SOURCE_V1), 1);
  assert.equal(wc.count(SOURCE_V2), 1);
  assert.equal(wc.probes(), 3);
  assert.equal(globalThis.__kctRuntimeHook.revision, 'v2');

  const oldWc = wc;
  wc.url = 'app://renderer/screenshot-2';
  wc.emit('did-finish-load');
  await flush();
  assert.equal(wc.count(SOURCE_V2), 1);

  globalThis.__kctRuntimeHook.dispose();
  assert.equal(globalThis.__kctRuntimeHook, undefined);
  assert.equal(r.app.listenerCount('web-contents-created'), 0);
  assert.equal(oldWc.listenerCount('did-finish-load'), 0);
  oldWc.emit('did-finish-load');
  await flush();
  assert.equal(oldWc.count(SOURCE_V2), 1);
});

test('new webContents are wired and still honor the allowlist', async (t) => {
  retireHook(t);
  const r = runtime();
  const summary = await installHook({ app: r.app, webContents: r.webContents }, SOURCE_V1, 'new');
  assert.deepEqual(summary, { revision: 'new', attached: 0, loaded: 0, stale: 0 });

  const allowed = new MockWebContents('app://renderer/sessions/new_session');
  r.app.emit('web-contents-created', {}, allowed);
  assert.equal(allowed.listenerCount('did-finish-load'), 1);
  assert.equal(allowed.count(SOURCE_V1), 0);
  allowed.emit('did-finish-load');
  await flush();
  assert.equal(allowed.count(SOURCE_V1), 1);
  assert.equal(allowed.probes(), 1);

  const blocked = new MockWebContents('app://renderer/screenshot-1');
  r.app.emit('web-contents-created', {}, blocked);
  blocked.emit('did-finish-load');
  await flush();
  assert.deepEqual(blocked.calls, []);
  assert.equal(globalThis.__kctRuntimeHook.wired.size, 2);
});

test('health separates current, stale, pending and unresponsive pages', async (t) => {
  retireHook(t);
  const r = runtime([
    'app://renderer/index.html',
    'app://renderer/sessions/two',
    'app://renderer/sessions/three',
    'app://renderer/sessions/four',
  ]);
  const [current, stale, pending, dead] = r.contents;
  for (const wc of [current, stale, pending]) wc.nextRevision = 'v2';
  await installHook({ app: r.app, webContents: r.webContents }, SOURCE_V2, 'v2');
  stale.revision = 'v1';
  pending.installed = false;
  dead.execute = async () => { throw new Error('renderer is gone'); };
  current.health = { ready: true, enabled: true, blocks: 0, mounted: 0,
    unsupported: 0, translated: 0, failed: 0 };

  const health = await globalThis.__kctRuntimeHook.health();
  assert.equal(health.revision, 'v2');
  assert.equal(health.current, 1);
  assert.equal(health.stale, 1);
  assert.equal(health.pending, 1);
  assert.equal(health.unresponsive, 1);
  assert.deepEqual(health.staleRevisions, ['v1']);
  assert.equal(health.currentHealth.length, 1, 'only current pages describe this revision');
  assert.equal(health.currentHealth[0].blocks, 0);
});

test('a page with no thinking blocks is not treated as a failed renderer', async (t) => {
  retireHook(t);
  const r = runtime(['app://renderer/index.html']);
  const wc = r.contents[0];
  wc.nextRevision = 'v3';
  wc.health = { ready: true, enabled: true, blocks: 0, mounted: 0,
    unsupported: 0, translated: 0, failed: 0 };
  await installHook({ app: r.app, webContents: r.webContents }, SOURCE_V1, 'v3');

  const health = await globalThis.__kctRuntimeHook.health();
  assert.equal(health.current, 1);
  assert.equal(health.stale, 0);
  assert.equal(health.currentHealth[0].failed, 0);
  assert.equal(health.currentHealth[0].blocks, 0);
});

test('a stale page is reloaded only once per refresh and never twice in a row', async (t) => {
  retireHook(t);
  const r = runtime(['app://renderer/index.html']);
  const wc = r.contents[0];
  wc.nextRevision = 'v2';
  await installHook({ app: r.app, webContents: r.webContents }, SOURCE_V2, 'v2');
  wc.revision = 'v1';

  assert.deepEqual(await globalThis.__kctRuntimeHook.reloadStale(),
    { revision: 'v2', reloaded: 1, stale: ['v1'] });
  assert.equal(wc.reloads, 1);
  wc.installed = false;
  wc.revision = null;
  assert.deepEqual(await globalThis.__kctRuntimeHook.reloadStale(),
    { revision: 'v2', reloaded: 0, stale: [] });
  assert.equal(wc.reloads, 1, 'a page that no longer reports a stale revision is not reloaded again');
});
