export async function installRuntimeHook(api, rendererSource, revision) {
  const app = api?.app;
  const contents = api?.webContents;
  const previous = globalThis.__kctRuntimeHook;
  // `loaded` counts pages that actually run this revision: a page that kept an
  // older kct.js keeps its own __kct and answers the probe, so counting it as
  // loaded is what let a stale renderer pass for a verified one.
  const summarize = (state) => {
    let attached = 0;
    let loaded = 0;
    let stale = 0;
    for (const record of state?.wired?.values?.() ?? []) {
      if (record.attached) attached += 1;
      if (record.loaded) loaded += 1;
      if (record.stale) stale += 1;
    }
    return { revision, attached, loaded, stale };
  };
  // One expression for every revision check: a page that mounted an older
  // bundle answers `loaded` too, so the revision is what decides.
  const probeExpression = `(() => ({ loaded: !!window.__kct, revision: window.__kctRuntimeRevision ?? null }))()`;

  if (previous?.revision === revision && typeof previous.dispose === 'function') {
    if (previous.ready) await previous.ready;
    return summarize(previous);
  }

  const replacing = !!previous && typeof previous.dispose === 'function';
  if (replacing) {
    try {
      previous.dispose();
    } catch {
      console.warn('[kct-runtime] previous hook disposal failed');
    }
  }

  let active = true;
  let disposed = false;
  let listener = null;
  const wired = new Map();

  function warnFailure() {
    if (!active) return;
    try {
      console.warn('[kct-runtime] renderer hook failed');
    } catch {
      // Logging must never take down the app.
    }
  }

  function allowed(wc) {
    try {
      if (!wc || wc.isDestroyed()) return false;
      const url = new URL(wc.getURL());
      return url.protocol === 'app:'
        && url.host === 'renderer'
        && !url.username
        && !url.password
        && (url.pathname === '/'
          || url.pathname === '/index.html'
          || /^\/sessions\/[A-Za-z0-9_-]+$/.test(url.pathname));
    } catch {
      return false;
    }
  }

  function deadline(value) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('renderer hook timed out'));
      }, 5000);
      Promise.resolve(value).then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error('renderer hook failed'));
        },
      );
    });
  }

  function execute(wc, record, source) {
    let call;
    try {
      call = Promise.resolve(wc.executeJavaScript(source));
    } catch {
      call = Promise.reject(new Error('renderer hook failed'));
    }
    const gate = call.then(() => null, () => null).then(() => {
      if (record.inflight !== gate) return;
      record.inflight = null;
      if (active && record.pending && !record.running && wired.get(wc) === record) queue(wc);
    });
    record.inflight = gate;
    return call;
  }

  async function attempt(wc, record) {
    if (!active || wired.get(wc) !== record || !allowed(wc)) return;
    record.attached = true;
    record.loaded = false;
    record.stale = false;
    await deadline(execute(wc, record, rendererSource));
    if (!active || wired.get(wc) !== record || !allowed(wc)) return;
    const page = await deadline(execute(wc, record, probeExpression));
    if (!active || wired.get(wc) !== record) return;
    record.revision = page?.revision ?? null;
    // A page whose __kct predates this hook keeps answering `loaded`. It runs,
    // but not this revision, so it is reported stale instead of counted as a
    // successful install.
    record.stale = page?.loaded === true && record.revision !== revision;
    record.loaded = page?.loaded === true && !record.stale;
  }

  async function probe(wc, record) {
    if (!active || wired.get(wc) !== record || !allowed(wc)) return;
    const page = await deadline(execute(wc, record, probeExpression));
    record.revision = page?.revision ?? null;
    record.stale = page?.loaded === true && record.revision !== revision;
    record.loaded = page?.loaded === true && !record.stale;
  }

  async function pump(wc, record) {
    do {
      record.pending = false;
      await attempt(wc, record);
    } while (active && record.pending && wired.get(wc) === record);
  }

  function queue(wc) {
    const record = wired.get(wc);
    if (!active || !record) return null;
    if (record.running) {
      record.pending = true;
      return record.current;
    }
    if (record.inflight) {
      record.pending = true;
      return null;
    }
    record.running = true;
    record.current = pump(wc, record)
      .catch(warnFailure)
      .finally(() => {
        record.running = false;
        record.current = null;
        if (active && record.pending && wired.get(wc) === record) queue(wc);
      });
    return record.current;
  }

  function wire(wc) {
    if (!active || !wc) return null;
    if (wired.has(wc)) return wired.get(wc);
    const record = {
      attached: false,
      loaded: false,
      stale: false,
      revision: null,
      running: false,
      pending: false,
      current: null,
      inflight: null,
      onLoad: null,
      onGone: null,
      onDestroyed: null,
    };
    record.onLoad = () => queue(wc);
    record.onGone = () => { record.loaded = false; record.stale = false; };
    record.onDestroyed = () => {
      try {
        wc.removeListener('did-finish-load', record.onLoad);
        wc.removeListener('render-process-gone', record.onGone);
      } catch {
        // The record is removed without touching a dead webContents again.
      }
      wired.delete(wc);
    };
    wired.set(wc, record);
    try {
      wc.on('did-finish-load', record.onLoad);
      wc.on('render-process-gone', record.onGone);
      wc.once('destroyed', record.onDestroyed);
    } catch {
      try {
        wc.removeListener('did-finish-load', record.onLoad);
        wc.removeListener('render-process-gone', record.onGone);
      } catch {
        // Ignore an already-destroyed webContents.
      }
      wired.delete(wc);
      return null;
    }
    record.attached = allowed(wc);
    return record;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    active = false;
    if (listener) {
      try {
        app?.removeListener('web-contents-created', listener);
      } catch {
        // Never make disposal depend on a live app or webContents object.
      }
    }
    for (const [wc, record] of wired) {
      try {
        wc.removeListener('did-finish-load', record.onLoad);
        wc.removeListener('render-process-gone', record.onGone);
      } catch {
        // Ignore an already-destroyed webContents.
      }
      try {
        wc.removeListener('destroyed', record.onDestroyed);
      } catch {
        // Ignore an already-destroyed webContents.
      }
    }
    wired.clear();
    if (globalThis.__kctRuntimeHook === hook) delete globalThis.__kctRuntimeHook;
  }

  async function health() {
    const pages = [];
    for (const [wc] of wired) {
      if (!allowed(wc)) continue;
      try {
        const page = await deadline(wc.executeJavaScript(`(() => {
          const loaded = !!window.__kct;
          const pageRevision = window.__kctRuntimeRevision ?? null;
          if (!loaded) return { loaded: false, revision: pageRevision };
          return { loaded: true, revision: pageRevision,
            health: typeof window.__kct.health === 'function' ? window.__kct.health() : null };
        })()`));
        page.stale = page.loaded === true && page.revision !== revision;
        pages.push(page);
      } catch {
        pages.push({ loaded: null, revision: null, stale: false, error: 'renderer did not answer' });
      }
    }
    const mounted = pages.filter((page) => page.loaded === true);
    const current = mounted.filter((page) => page.revision === revision);
    const stale = mounted.filter((page) => page.revision !== revision);
    return {
      revision, pages,
      current: current.length,
      stale: stale.length,
      unresponsive: pages.filter((page) => page.loaded === null).length,
      pending: pages.filter((page) => page.loaded === false).length,
      // Only pages running this revision can report on this bundle's behaviour.
      currentHealth: current.map((page) => page.health).filter(Boolean),
      staleRevisions: [...new Set(stale.map((page) => page.revision ?? null))],
    };
  }

  async function reloadStale() {
    const stale = [];
    for (const [wc, record] of wired) {
      if (!allowed(wc)) continue;
      try {
        const page = await deadline(wc.executeJavaScript(
          `(() => ({ loaded: !!window.__kct, revision: window.__kctRuntimeRevision ?? null }))()`));
        if (!page?.loaded || page.revision === revision) continue;
        wc.reload();
        record.loaded = false;
        stale.push(page.revision ?? null);
      } catch {
        // A page that cannot be inspected is left untouched.
      }
    }
    return { revision, reloaded: stale.length, stale };
  }

  const hook = { revision, wired, listener: null, dispose, health, reloadStale };
  listener = (_event, wc) => {
    wire(wc);
  };
  hook.listener = listener;
  globalThis.__kctRuntimeHook = hook;

  try {
    app?.on('web-contents-created', listener);
  } catch {
    warnFailure();
  }

  const pending = [];
  let existing = [];
  try {
    existing = contents?.getAllWebContents?.() ?? [];
  } catch {
    warnFailure();
  }
  for (const wc of Array.isArray(existing) ? existing : []) {
    const record = wire(wc);
    if (record && allowed(wc)) {
      const task = replacing ? probe(wc, record).catch(warnFailure) : queue(wc);
      if (task) pending.push(task);
    }
  }

  hook.ready = Promise.all(pending).then(() => summarize(hook));
  return hook.ready;
}
