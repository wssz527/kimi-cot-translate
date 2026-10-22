(() => {
  if (globalThis.__kctBrowserMounted || !globalThis.KCTBrowserCore) return;
  const isCode = location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname);
  const isChat = location.protocol === 'https:' && ['kimi.com', 'www.kimi.com'].includes(location.hostname);
  if (!isCode && !isChat) return;
  globalThis.__kctBrowserMounted = true;

  const core = globalThis.KCTBrowserCore;
  const key = `kct.browser.v1:${location.origin}`;
  const selector = isCode ? '.think:has(> button.think-head)' : '.toolcall-container.thinking-container';
  let settings = { language: '', consent: false, auto: false };
  let loaded = false;
  let timer;
  let epoch = 0;
  const contexts = new Map();

  function locate(block) {
    if (block.closest('[data-kct-browser], pre, code, [contenteditable], textarea, .markdown')) return null;
    if (isCode) {
      const head = block.querySelector(':scope > button.think-head[aria-expanded="true"]');
      const body = block.querySelector(':scope > .think-body.open:not([inert]) > .think-body-inner');
      const source = body?.querySelector(':scope > pre.think-text');
      return head && source ? source : null;
    }
    if (!block.classList.contains('is-expanded') ||
        !block.querySelector(':scope > .toolcall-title-container')) return null;
    const sources = block.querySelectorAll(':scope > .toolcall-content .toolcall-content-text');
    return sources.length === 1 && sources[0].closest(selector) === block ? sources[0] : null;
  }

  function visible(node) {
    if (!node.isConnected || document.visibilityState !== 'visible' ||
        node.closest('[hidden], [inert], [aria-hidden="true"]') ||
        !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const box = node.getBoundingClientRect();
    let top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
    let left = Math.max(0, box.left), right = Math.min(innerWidth, box.right);
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (Number(style.opacity) === 0) return false;
      const rect = parent.getBoundingClientRect();
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) {
        top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom);
      }
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) {
        left = Math.max(left, rect.left); right = Math.min(right, rect.right);
      }
    }
    return bottom > top && right > left;
  }

  function accepted() {
    return loaded && settings.consent === true && core.languages.includes(settings.language);
  }

  function sourceOf(ctx) {
    return ctx.source.innerText;
  }

  function queueScan() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      scan();
    }, 700);
  }

  function applySettings(next) {
    const value = {
      language: typeof next?.language === 'string' ? next.language : '',
      consent: next?.consent === true,
      auto: next?.auto === true,
    };
    if (value.language === settings.language && value.consent === settings.consent &&
        value.auto === settings.auto) return;
    const clearCompleted = value.language !== settings.language || value.consent !== settings.consent;
    settings = value;
    if (clearCompleted) {
      epoch++;
      for (const [block, ctx] of contexts) {
        invalidate(ctx);
        if (locate(block) === ctx.source && visible(ctx.source)) ctx.epoch = epoch;
      }
    }
    scan();
  }

  async function save(next) {
    await chrome.storage.local.set({ [key]: next });
    // storage.onChanged is asynchronous; update immediately for browsers/tests
    // that deliver it after the user's next click.
    applySettings(next);
    // A real storage event can arrive after local apply. It is now a no-op.
  }

  function mount(block, source) {
    const host = document.createElement('div');
    host.dataset.kctBrowser = '1';
    const shadow = host.attachShadow({ mode: 'open' });
    // Only extension-owned, static markup; translated text is always textContent.
    shadow.innerHTML = `<style>
      :host{display:block;margin:8px 0;font:13px/1.6 sans-serif;color:inherit}
      .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      button,select{font:inherit} button:focus-visible,select:focus-visible{outline:2px solid #1682c4}
      label{display:inline-flex;gap:4px;align-items:center} [hidden]{display:none!important}
      output{display:block;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6px}
      .hint{font-size:12px;opacity:.8}
    </style><div class="bar">
      <select aria-label="翻译目标语言"><option value="">选择目标语言</option></select>
      <button type="button" class="consent">确认语言并允许发送到 Bing</button>
      <label><input type="checkbox">自动翻译可见思考</label>
      <button type="button" class="translate">翻译本段</button>
    </div><div class="hint">仅发送本段已展开的思考正文到 Bing；设置按站点保存。</div>
    <span role="status" aria-live="polite"></span><output hidden aria-label="思考译文"></output>`;
    const language = shadow.querySelector('select');
    const names = ['简体中文', 'English', '日本語', '한국어', 'Español', 'Français', 'Deutsch', 'Русский'];
    core.languages.forEach((value, i) => language.add(new Option(names[i], value)));
    const ctx = {
      block, source, host, language, consent: shadow.querySelector('.consent'),
      auto: shadow.querySelector('input'), button: shadow.querySelector('.translate'),
      status: shadow.querySelector('[role="status"]'), output: shadow.querySelector('output'),
      generation: 0, running: false, last: '', failed: '', result: '', noTranslation: false,
      href: location.href,
      epoch,
    };
    source.after(host);
    contexts.set(block, ctx);
    language.addEventListener('change', () => {
      // Changing the language alone does not send the thinking text.
      void save({ language: language.value, consent: false, auto: false })
        .catch(() => { ctx.status.textContent = '设置保存失败，未启用翻译'; });
    });
    ctx.consent.addEventListener('click', () => {
      if (core.languages.includes(language.value)) {
        void save({ language: language.value, consent: true, auto: false })
          .catch(() => { ctx.status.textContent = '设置保存失败，未启用翻译'; });
      }
    });
    ctx.auto.addEventListener('change', () => {
      if (accepted()) void save({ ...settings, auto: ctx.auto.checked })
        .catch(() => { ctx.status.textContent = '设置保存失败'; });
    });
    ctx.button.addEventListener('click', () => {
      if (!accepted() || ctx.noTranslation) return;
      if (ctx.result) {
        ctx.output.hidden = !ctx.output.hidden;
        ctx.button.textContent = ctx.output.hidden ? '显示译文' : '收起译文';
      } else void run(ctx, true);
    });
    return ctx;
  }

  function invalidate(ctx) {
    ctx.generation++;
    ctx.running = false;
    ctx.last = ctx.failed = ctx.result = '';
    ctx.noTranslation = false;
    ctx.output.textContent = '';
    ctx.output.hidden = true;
    ctx.button.hidden = false;
    ctx.status.textContent = '';
    ctx.button.textContent = '翻译本段';
  }

  async function run(ctx, retryFailed = false) {
    if (!accepted() || ctx.running || locate(ctx.block) !== ctx.source || !visible(ctx.source)) return;
    const source = sourceOf(ctx);
    if (!source.trim()) return;
    if (source.length > 100000) {
      ctx.failed = source;
      ctx.status.textContent = '思考正文超过 100000 字符，未发送。';
      return;
    }
    const generation = ++ctx.generation;
    const runEpoch = epoch;
    const language = settings.language;
    const href = location.href;
    const valid = () => ctx.generation === generation && ctx.epoch === runEpoch && runEpoch === epoch &&
      accepted() && settings.language === language &&
      locate(ctx.block) === ctx.source && visible(ctx.source) && location.href === href &&
      sourceOf(ctx) === source;
    ctx.running = true;
    ctx.status.textContent = '翻译中…';
    try {
      const result = await core.translateText(
        source, language, () => {}, { provider: 'bing' }, valid, retryFailed,
      );
      if (!valid()) return;
      ctx.last = source;
      if (result === source) {
        ctx.result = '';
        ctx.noTranslation = true;
        ctx.output.textContent = '';
        ctx.output.hidden = true;
        ctx.button.hidden = true;
        ctx.status.textContent = '无需翻译（正文已是目标语言）';
        return;
      }
      ctx.result = result;
      ctx.noTranslation = false;
      ctx.output.textContent = result;
      ctx.output.hidden = false;
      ctx.button.hidden = false;
      ctx.button.textContent = '收起译文';
      ctx.status.textContent = '译文（原文保留）';
    } catch (error) {
      if (valid()) {
        ctx.failed = source;
        ctx.status.textContent = `翻译失败：${error.message}。可点击翻译本段重试。`;
      }
    } finally {
      if (ctx.generation === generation) {
        ctx.running = false;
        if (!valid()) queueScan();
      }
    }
  }

  function scan() {
    for (const [block, ctx] of contexts) {
      if (locate(block) !== ctx.source || !visible(ctx.source)) {
        invalidate(ctx);
        ctx.host.remove();
        contexts.delete(block);
        continue;
      }
      if (ctx.href !== location.href || (ctx.last && sourceOf(ctx) !== ctx.last) ||
          (ctx.failed && sourceOf(ctx) !== ctx.failed)) {
        invalidate(ctx);
        ctx.href = location.href;
      }
      ctx.epoch = epoch;
    }
    for (const block of document.querySelectorAll(selector)) {
      const source = locate(block);
      if (!source || !visible(source)) continue;
      const ctx = contexts.get(block) || mount(block, source);
      if (!ctx.host.isConnected) ctx.source.after(ctx.host);
      ctx.language.value = core.languages.includes(settings.language) ? settings.language : '';
      ctx.consent.hidden = accepted();
      ctx.consent.disabled = !ctx.language.value || !loaded;
      ctx.button.disabled = ctx.auto.disabled = !accepted() || ctx.noTranslation;
      ctx.auto.checked = accepted() && settings.auto === true;
      if (accepted() && settings.auto === true && !ctx.last && ctx.failed !== sourceOf(ctx) &&
          !ctx.running) void run(ctx);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[key]) return;
    applySettings(changes[key].newValue);
  });
  chrome.storage.local.get(key).then(value => {
    settings = {
      language: typeof value[key]?.language === 'string' ? value[key].language : '',
      consent: value[key]?.consent === true,
      auto: value[key]?.auto === true,
    };
    loaded = true;
    scan();
  }).catch(() => { loaded = false; scan(); });
  new MutationObserver(records => {
    if (records.some(record => !record.target.closest?.('[data-kct-browser]'))) queueScan();
  }).observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-expanded', 'aria-hidden'],
  });
  addEventListener('scroll', queueScan, { capture: true, passive: true });
  addEventListener('resize', queueScan, { passive: true });
  addEventListener('popstate', queueScan);
  addEventListener('hashchange', queueScan);
  document.addEventListener('visibilitychange', () => {
    for (const ctx of contexts.values()) invalidate(ctx);
    queueScan();
  });
})();
