// kimi-cot-translate (kct)
// Display-layer translation for Kimi Code thinking blocks.
// Self-contained ES module injected into the Kimi Code desktop renderer.
// The original <pre> is never modified; translations render into a sibling node.

const NS = 'kct';
const SETTINGS_KEY = 'kct:settings:v1';
const CACHE_KEY = 'kct:cache:v1';
const CACHE_LIMIT = 500;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 1500;
const CONCURRENCY = 3;
const STREAM_DEBOUNCE_MS = 700;
const STREAM_MAX_WAIT_MS = 3000;
const REQUEST_TIMEOUT_MS = 15000;
const CUSTOM_TIMEOUT_MS = 60000;
const BATCH_CHARS = 4000;
const FAILURE_TTL_MS = 30000;
const TARGET_LANGUAGES = ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru'];

const DEFAULTS = {
  enabled: true,
  autoTranslate: true,
  provider: 'bing',
  targetLanguage: 'auto',
  customEndpoint: '',
  customModel: '',
  customKey: '',
  customKeyPending: false,
};

const THINK = '.think';
const HEAD = 'button.think-head';
const BODY_INNER = '.think-body-inner';

const state = {
  settings: { ...DEFAULTS },
  cache: new Map(),
  inFlight: new Map(),
  failures: new Map(),
  cooldowns: new Map(),
  queue: [],
  active: 0,
  stylesInjected: false,
};

const ctxs = new WeakMap();
const cacheSizes = new WeakMap();
const scheduled = new Set();
let rafPending = 0;
let cacheTimer = 0;
let cacheFlushTimer = 0;
let cacheDirty = false;
let cacheMemoryOnly = false;
let queueTimer = 0;
let cacheEpoch = 0;
let setupPrompted = false;
const requestControllers = new Set();

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) state.settings = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_) {
    /* keep defaults */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch (_) {
    /* ignore */
  }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    if (raw.length * 2 > CACHE_BYTES) throw new Error('oversized cache');
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) throw new Error('invalid cache');
    const now = Date.now();
    for (const pair of entries) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue;
      let [key, text, usedAt] = pair;
      if (pair.length === 2) {
        const end = key.lastIndexOf('\u0000') + 1;
        if (!/^(bing|google|custom)\u0000/.test(key) || !end ||
          !/^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/.test(key.slice(end))) continue;
        key = `${hashKey(key.slice(0, end))}:${key.slice(end)}`;
        // Legacy entries have no age; their seven-day window starts at migration.
        usedAt = now;
      }
      if (key.length > 96 || !/^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+:[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/.test(key) ||
        !Number.isFinite(usedAt) || usedAt <= 0 || usedAt > now || !text.trim()) continue;
      state.cache.delete(key);
      state.cache.set(key, { text, usedAt });
    }
  } catch (_) {
    state.cache.clear();
  }
  pruneCache();
  saveCache();
  persistCache();
}

function pruneCache(now = Date.now()) {
  let bytes = 4;
  const sizes = [];
  for (const [key, entry] of state.cache) {
    if (now - entry.usedAt >= CACHE_TTL_MS) {
      state.cache.delete(key);
      continue;
    }
    // Count UTF-16 bytes, including JSON escaping, keys, timestamps and separators.
    let measured = cacheSizes.get(entry);
    const timeLength = String(entry.usedAt).length;
    if (!measured || measured.key !== key || measured.text !== entry.text || measured.timeLength !== timeLength) {
      measured = { key, text: entry.text, timeLength,
        size: 2 * (JSON.stringify([key, entry.text, entry.usedAt]).length + 1) };
      cacheSizes.set(entry, measured);
    }
    const { size } = measured;
    sizes.push([key, size]);
    bytes += size;
  }
  for (const [key, size] of sizes) {
    if (state.cache.size <= CACHE_LIMIT && bytes <= CACHE_BYTES) break;
    state.cache.delete(key);
    bytes -= size;
  }
}

function saveCache() {
  clearTimeout(cacheTimer);
  cacheTimer = 0;
  if (state.cache.size) {
    const expires = Math.min(...[...state.cache.values()].map((entry) => entry.usedAt)) + CACHE_TTL_MS;
    cacheTimer = setTimeout(() => { pruneCache(); saveCache(); persistCache(); }, Math.max(0, expires - Date.now()));
    cacheTimer.unref?.();
  }
  cacheDirty = true;
  if (cacheMemoryOnly || typeof localStorage === 'undefined') return;
  clearTimeout(cacheFlushTimer);
  cacheFlushTimer = setTimeout(persistCache, 1000);
  cacheFlushTimer.unref?.();
}

function persistCache() {
  clearTimeout(cacheFlushTimer);
  cacheFlushTimer = 0;
  if (!cacheDirty || cacheMemoryOnly) return;
  pruneCache();
  const serialize = (entries) => JSON.stringify([...entries].map(([key, entry]) => [key, entry.text, entry.usedAt]));
  try {
    localStorage.setItem(CACHE_KEY, serialize(state.cache));
    cacheDirty = false;
  } catch (_) {
    while (state.cache.size > CACHE_LIMIT / 4) state.cache.delete(state.cache.keys().next().value);
    pruneCache();
    try {
      localStorage.setItem(CACHE_KEY, serialize(state.cache));
      cacheDirty = false;
    } catch (_) {
      cacheMemoryOnly = true;
    }
  }
}

// ---------------------------------------------------------------------------
// language + hashing
// ---------------------------------------------------------------------------

function resolveTarget() {
  const configured = state.settings.targetLanguage;
  if (configured && configured !== 'auto') return configured;
  // The desktop shell has a fixed lang="en"; Kimi stores its real locale here.
  let locale;
  try { locale = localStorage.getItem('kimi-locale'); } catch (_) { /* unavailable storage */ }
  const lang = locale || navigator.language || document.documentElement.lang || 'en';
  return String(lang).split('-')[0].toLowerCase();
}

function hasTargetLanguage() {
  return TARGET_LANGUAGES.includes(state.settings.targetLanguage);
}

function isTargetLanguage(text, lang) {
  const prose = protectedPieces(text).filter(({ skip }) => !skip).map(({ text }) => text).join('');
  const letters = prose.match(/\p{L}/gu) || [];
  if (!letters.length) return true;
  const count = (pattern) => (prose.match(pattern) || []).length;
  const han = count(/\p{Script=Han}/gu);
  const kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangul = count(/\p{Script=Hangul}/gu);
  const cyrillic = count(/\p{Script=Cyrillic}/gu);
  if (lang === 'zh') return han > 0 && !kana && !hangul && !cyrillic && han / letters.length >= 0.5;
  if (lang === 'ja') return kana > 0 && !hangul && !cyrillic && (han + kana) / letters.length >= 0.5;
  if (lang === 'ko') return hangul > 0 && !kana && !cyrillic && (han + hangul) / letters.length >= 0.5;
  // Ukrainian and other Cyrillic languages must not be mistaken for Russian.
  const commonWords = {
    en: 'the this that these those is are was were be been being and or but with without for from into of to in on at by as it its we our you your i my can could will would should have has had not do does did let first then need check',
    es: 'el la los las un una unos unas es son está están ser estar y o pero con sin para por del de al en como este esta estos estas que se su sus nosotros nuestro podemos puede debe hay primero luego verificar',
    fr: 'le la les un une des est sont être et ou mais avec sans pour par du de au aux en dans sur ce cette ces qui que nous notre vous votre peut faut pas ne puis vérifier',
    de: 'der die das ein eine eines ist sind war waren sein und oder aber mit ohne für von zu zum zur den dem des im in auf aus als diese dieser dieses wir unser können kann muss nicht dann prüfen',
    ru: 'это этот эта эти для при или как что чтобы который которая которые мы вы они его её их не нет есть будет будут нужно можно сначала затем проверить',
  };
  if (!commonWords[lang] || han || kana || hangul ||
    (lang === 'ru' ? cyrillic / letters.length < 0.8 || /[іїєґў]/iu.test(prose) : cyrillic)) return false;
  const words = prose.toLowerCase().match(/\p{L}+/gu) || [];
  const scores = Object.entries(commonWords).map(([language, vocabulary]) => {
    const known = new Set(vocabulary.split(' '));
    return [language, words.filter((word) => known.has(word)).length];
  }).sort((a, b) => b[1] - a[1]);
  // shortcut: ambiguous short prose goes to the service; use a local model if more coverage is needed.
  return scores[0][0] === lang && scores[0][1] >= 2 &&
    scores[0][1] >= words.length * 0.15 && scores[0][1] - scores[1][1] >= 2;
}

function targetFor(provider, lang) {
  if (provider === 'google') return lang === 'zh' ? 'zh-CN' : lang;
  return lang === 'zh' ? 'zh-Hans' : lang;
}

// Cache keys only need to be stable and collision-resistant enough for
// reasoning text, and must not depend on crypto.subtle being available.
function hashKey(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return `${text.length.toString(36)}-${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}`;
}

// ---------------------------------------------------------------------------
// providers — request shapes mirror DSH's experimental translator
// ---------------------------------------------------------------------------

async function fetchJSON(url, options, signal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  requestControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal }).catch((error) => {
      if (signal?.aborted) throw new Error('翻译已取消');
      if (controller.signal.aborted) {
        throw Object.assign(new Error('请求超时，请重试'), { network: true });
      }
      if (error.status === undefined && error.network === undefined) error.network = true;
      throw error;
    });
    if (!res.ok) {
      const retryAfter = res.headers?.get('retry-after');
      const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
      const retryAfterMs = retryAfter
        ? Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now())
        : NaN;
      throw Object.assign(new Error(`HTTP ${res.status}`), {
        status: res.status, retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : res.status === 429 ? 60000 : 0,
      });
    }
    try {
      return await res.json();
    } catch (error) {
      if (signal?.aborted) throw new Error('翻译已取消');
      if (controller.signal.aborted) throw Object.assign(new Error('请求超时，请重试'), { network: true });
      if (error instanceof TypeError) error.network = true;
      throw error;
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    requestControllers.delete(controller);
  }
}

async function translateGoogle(text, lang, signal) {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', targetFor('google', lang));
  url.searchParams.set('dt', 't');
  const payload = await fetchJSON(url, {
    method: 'POST',
    body: new URLSearchParams({ q: text }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    credentials: 'omit',
    redirect: 'error',
  }, signal);
  const first = Array.isArray(payload) ? payload[0] : null;
  if (!Array.isArray(first) || first.length === 0) throw new Error('google bad shape');
  return first.map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
}

async function translateBing(texts, lang, signal) {
  const url = new URL('https://edge.microsoft.com/translate/translatetext');
  url.searchParams.set('to', targetFor('bing', lang));
  url.searchParams.set('isEnterpriseClient', 'false');
  const payload = await fetchJSON(url, {
    method: 'POST',
    body: JSON.stringify(texts),
    headers: { 'content-type': 'application/json' },
    credentials: 'omit',
    redirect: 'error',
  }, signal);
  if (!Array.isArray(payload) || payload.length !== texts.length) throw new Error('bing bad shape');
  return payload.map((item) => {
    const translated = item?.translations?.[0]?.text;
    return typeof translated === 'string' && translated.trim() ? translated : null;
  });
}

function customEndpointURL(endpoint) {
  if (!endpoint) throw new Error('custom endpoint not configured');
  let url;
  try { url = new URL(endpoint); } catch (_) { throw new Error('自定义端点地址无效'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('远程自定义端点必须使用 HTTPS；仅本机地址允许 HTTP');
  }
  return url;
}

async function translateCustom(texts, lang, settings, signal) {
  const numbered = texts.length > 1;
  const text = numbered ? texts.map((text, i) => `${i + 1}. ${text}`).join('\n') : texts[0];
  const endpoint = customEndpointURL(settings.customEndpoint.trim()).href;
  const headers = { 'content-type': 'application/json' };
  if (settings.customKey) headers.authorization = `Bearer ${settings.customKey}`;
  const payload = await fetchJSON(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.customModel || undefined,
      messages: [
        {
          role: 'system',
          content:
            `You are a translation engine. Translate the user's text into ${lang}. ` +
            'Preserve line breaks, Markdown and code exactly. Output only the translation.' +
            (numbered ? ' Keep each numbered item and its number, starting each item on a new line.' : ''),
        },
        { role: 'user', content: text },
      ],
      temperature: 0,
    }),
    credentials: 'omit',
    redirect: 'error',
  }, signal, CUSTOM_TIMEOUT_MS);
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : undefined;
  if (typeof content !== 'string' || content === '') throw new Error('custom bad shape');
  if (!numbered) return [content];
  // shortcut: ambiguous numbered lists use singles; use structured output if these need batching.
  const lines = [...content.matchAll(/^(\d+)\.[ \t]+/gm)];
  if (lines.length !== texts.length || content.slice(0, lines[0]?.index).trim() ||
    lines.some((line, i) => Number(line[1]) !== i + 1)) return null;
  const results = lines.map((line, i) =>
    content.slice(line.index + line[0].length, lines[i + 1]?.index ?? content.length).trim());
  return results.every(Boolean) ? results : null;
}

const PROVIDERS = { google: translateGoogle, bing: translateBing, custom: translateCustom };

// ---------------------------------------------------------------------------
// concurrency-limited queue
// ---------------------------------------------------------------------------

function pump() {
  clearTimeout(queueTimer);
  queueTimer = 0;
  while (state.active < CONCURRENCY && state.queue.length > 0) {
    const readyAt = (job) => Math.max(job.readyAt, state.cooldowns.get(job.provider) || 0);
    const index = state.queue.findIndex((job) => readyAt(job) <= Date.now());
    if (index < 0) {
      queueTimer = setTimeout(pump, Math.min(2147483647,
        Math.max(0, Math.min(...state.queue.map(readyAt)) - Date.now())));
      return;
    }
    const [job] = state.queue.splice(index, 1);
    if (!job.batch.filter(pruneConsumers).length) continue;
    job.controller = new AbortController();
    state.active += 1;
    void translateBatch(job)
      .catch((error) => {
        if (error.status === 429) {
          state.cooldowns.set(job.provider, Math.max(state.cooldowns.get(job.provider) || 0,
            Date.now() + (Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 60000)));
        }
        if (!job.batch.some(pruneConsumers)) return;
        if (error.status === 429) {
          state.queue.push(job);
        } else if ((error.network || (error.status >= 500 && error.status < 600)) && job.retries < 2) {
          job.readyAt = Date.now() + 1000 * 2 ** job.retries * (0.8 + Math.random() * 0.4);
          job.retries += 1;
          state.queue.push(job);
        } else {
          for (const item of job.batch) {
            if (!pruneConsumers(item)) continue;
            state.failures.set(item.key, { error, failedAt: Date.now() });
            finishItem(item, error);
          }
        }
      })
      .finally(() => {
        state.active -= 1;
        pump();
      });
  }
}

function enqueue(batch, provider, lang, settings) {
  const job = { batch, provider, lang, settings, readyAt: 0, retries: 0, controller: null };
  for (const item of batch) item.job = job;
  state.queue.push(job);
  pump();
}

function pruneConsumers(item) {
  for (const consumer of item.consumers) {
    if (consumer.valid()) continue;
    item.consumers.delete(consumer);
    consumer.reject(new Error('翻译已取消'));
  }
  if (!item.consumers.size && state.inFlight.get(item.key) === item) state.inFlight.delete(item.key);
  if (item.job && !item.job.batch.some((entry) => entry.consumers.size)) item.job.controller?.abort();
  return item.consumers.size > 0;
}

function finishItem(item, error, text) {
  for (const consumer of item.consumers) {
    if (error) consumer.reject(error);
    else consumer.resolve(text);
  }
  item.consumers.clear();
  if (state.inFlight.get(item.key) === item) state.inFlight.delete(item.key);
}

function prunePending() {
  const jobs = new Set();
  for (const item of state.inFlight.values()) {
    if (item.job) jobs.add(item.job);
    pruneConsumers(item);
  }
  for (const job of jobs) {
    if (!job.batch.some((item) => item.consumers.size)) job.controller?.abort();
  }
  state.queue = state.queue.filter((job) => job.batch.some((item) => item.consumers.size));
  pump();
}

async function translateBatch({ batch, provider, lang, settings, controller }) {
  const live = batch.filter(pruneConsumers);
  if (!live.length) return;
  const results = provider === 'bing'
    ? await translateBing(live.map((item) => item.text), lang, controller.signal)
    : provider === 'custom'
      ? await translateCustom(live.map((item) => item.text), lang, settings, controller.signal)
      : [await translateGoogle(live[0].text, lang, controller.signal)];
  if (!results) {
    for (const item of live) enqueue([item], provider, lang, settings);
    return;
  }
  let saved = false;
  live.forEach((item, i) => {
    if (!pruneConsumers(item)) return;
    const text = results[i];
    if (typeof text !== 'string' || !text.trim()) {
      if (live.length > 1) {
        enqueue([item], provider, lang, settings);
      } else {
        const error = new Error('译文为空，请重试');
        state.failures.set(item.key, { error, failedAt: Date.now() });
        finishItem(item, error);
      }
      return;
    }
    const translated = preserveFencedCode(item.text, text);
    if (item.epoch === cacheEpoch && translated.length * 2 <= CACHE_BYTES) {
      state.cache.delete(item.key);
      state.cache.set(item.key, { text: translated, usedAt: Date.now() });
      saved = true;
    }
    finishItem(item, null, translated);
  });
  if (saved) {
    pruneCache();
    saveCache();
  }
}

// ---------------------------------------------------------------------------
// segmentation
// ---------------------------------------------------------------------------

function protectedPieces(text) {
  const pieces = [];
  const tokens = /^ {0,3}(`{3,})[^`\n]*(?:\n|$)|^ {0,3}(~{3,})[^\n]*(?:\n|$)|(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\3(?!`)|https?:\/\/[^\s`<>。！？；，]+/gm;
  let last = 0;
  let match;
  while ((match = tokens.exec(text)) !== null) {
    if (match.index > last) pieces.push({ text: text.slice(last, match.index), skip: false });
    const fence = match[1] || match[2];
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*\\r?$`, 'gm');
      closing.lastIndex = tokens.lastIndex;
      const end = closing.exec(text);
      tokens.lastIndex = end ? closing.lastIndex : text.length;
    }
    pieces.push({ text: text.slice(match.index, tokens.lastIndex), skip: true, fenced: !!fence });
    last = tokens.lastIndex;
  }
  if (last < text.length) pieces.push({ text: text.slice(last), skip: false });
  return pieces;
}

function preserveFencedCode(source, translated) {
  const fences = (text) => protectedPieces(text).filter(({ fenced }) => fenced).map(({ text }) => text);
  const original = fences(source);
  const result = fences(translated);
  return original.length === result.length && original.every((text, i) => text === result[i])
    ? translated : source;
}

function endsWithAbbreviation(text) {
  return /\b(?:Dr\.|Mr\.|Mrs\.|Ms\.|e\.g\.|i\.e\.|etc\.|vs\.|v?\d+(?:\.\d+)+\.?)$/i.test(text.trimEnd());
}

function sentenceUnits(text) {
  const units = [];
  let last = 0;
  for (const match of text.matchAll(/\n+|[。！？]|[.!?](?:[ \t]+|(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]))/gu)) {
    if (match[0][0] === '.' && endsWithAbbreviation(text.slice(last, match.index + 1))) continue;
    const end = match.index + match[0].length;
    units.push(text.slice(last, end));
    last = end;
  }
  if (last < text.length) units.push(text.slice(last));
  return units;
}

// Keep sentence boundaries when a chunk is too long for one request.
function splitLong(text) {
  const parts = [];
  while (text.length > MAX_CHARS) {
    const prefix = text.slice(0, MAX_CHARS);
    const boundaries = [...prefix.matchAll(/(?:[。！？.!?]\s+|\n+|\s+)/g)]
      .filter((match) => !endsWithAbbreviation(prefix.slice(0, match.index + match[0].length)));
    const boundary = boundaries.at(-1);
    let end = boundary && boundary.index > MAX_CHARS / 2
      ? boundary.index + boundary[0].length : MAX_CHARS;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    parts.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) parts.push(text);
  return parts;
}

// Paragraph boundaries (blank lines) survive translation; blank runs are
// translated as-is so the visual shape of the reasoning stays intact.
function splitParagraphs(text) {
  const parts = [];
  const re = /(\n[ \t]*\n)/g;
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    parts.push({ body: text.slice(last, match.index), sep: match[1] });
    last = match.index + match[1].length;
  }
  parts.push({ body: text.slice(last), sep: '' });
  return parts;
}

function stableStreamSource(text, waited = false) {
  const masked = protectedPieces(text).map(({ text, skip }) => skip ? ' '.repeat(text.length) : text).join('');
  const paragraphs = splitParagraphs(masked);
  let end = paragraphs.slice(0, -1).reduce((length, { body, sep }) => length + body.length + sep.length, 0);
  const tail = masked.slice(end);
  if (tail.length >= MAX_CHARS || waited) {
    // Keep the final unit growing; protected spans cannot introduce a boundary.
    end += sentenceUnits(tail).slice(0, -1).reduce((length, unit) => length + unit.length, 0);
  }
  return text.slice(0, end);
}

function translationPieces(source, lang) {
  // Equal-length masks keep sentence context and source offsets without counting code or URLs.
  const masked = protectedPieces(source).map(({ text, skip }) => skip ? ' '.repeat(text.length) : text).join('');
  let offset = 0;
  return splitParagraphs(masked).flatMap(({ body, sep }) => {
    const groups = [];
    for (const unit of sentenceUnits(body)) {
      const skip = unit.trim() ? isTargetLanguage(unit, lang) : groups.at(-1)?.skip ?? true;
      for (const piece of protectedPieces(source.slice(offset, offset + unit.length))) {
        const last = groups.at(-1);
        const preserve = skip || piece.skip;
        if (last && last.skip === preserve) last.text += piece.text;
        else groups.push({ text: piece.text, skip: preserve });
      }
      offset += unit.length;
    }
    const separator = source.slice(offset, offset + sep.length);
    offset += sep.length;
    return [...groups.flatMap(({ text, skip }) =>
      skip ? [{ text, skip }] : splitLong(text).flatMap((text) => {
        const body = text.trim();
        if (!body) return [{ text, skip: true }];
        const start = text.indexOf(body);
        return [
          { text: text.slice(0, start), skip: true },
          { text: body, skip: false },
          { text: text.slice(start + body.length), skip: true },
        ].filter(({ text }) => text);
      })), { text: separator, skip: true }];
  });
}

async function translateText(source, lang, onProgress = () => {}, settings = { ...state.settings }, valid = () => true, retryFailed = false) {
  const provider = settings.provider;
  if (!PROVIDERS[provider]) throw new Error('未知翻译服务');
  if (provider === 'custom' && settings.customKeyPending) throw new Error('请先确认新端点的密钥');
  const scope = provider === 'custom' ? `${settings.customEndpoint}\u0000${settings.customModel}` : '';
  const prefix = hashKey(`${provider}\u0000${lang}\u0000${scope ? scope + '\u0000' : ''}`);
  const pieces = translationPieces(source, lang);
  const out = pieces.map(({ text }) => text);
  const missing = [];
  const owned = new Map();
  const tasks = [];
  let completed = 0;
  let progressTimer = 0;
  const total = pieces.filter(({ skip }) => !skip).length;
  const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  const cancelFrame = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
  const notifyProgress = () => {
    if (progressTimer) return;
    progressTimer = frame(() => {
      progressTimer = 0;
      if (valid()) onProgress(preserveFencedCode(source, out.join('')), completed, total);
    });
  };

  pruneCache();
  for (const [key, failure] of state.failures) {
    if (Date.now() - failure.failedAt >= FAILURE_TTL_MS) state.failures.delete(key);
  }
  for (const [index, { text, skip }] of pieces.entries()) {
    if (skip) continue;
    const key = `${prefix}:${hashKey(text)}`;
    if (retryFailed) state.failures.delete(key);
    let promise;
    if (state.failures.has(key)) {
      promise = Promise.reject(state.failures.get(key).error);
    } else if (state.cache.has(key)) {
      const hit = state.cache.get(key);
      hit.usedAt = Date.now();
      state.cache.delete(key);
      state.cache.set(key, hit);
      out[index] = preserveFencedCode(text, hit.text);
      completed += 1;
      continue;
    } else {
      let pending = state.inFlight.get(key);
      if (pending && !pruneConsumers(pending)) pending = null;
      if (!pending) {
        pending = { text, key, consumers: new Set(), epoch: cacheEpoch };
        state.inFlight.set(key, pending);
      }
      promise = new Promise((resolve, reject) => pending.consumers.add({ valid, resolve, reject }));
      if (!pending.job && !owned.has(pending)) {
        missing.push(pending);
        owned.set(pending, promise);
      }
    }
    tasks.push(promise.then((translated) => {
      out[index] = preserveFencedCode(text, translated);
      completed += 1;
      if (valid()) notifyProgress();
    }));
  }
  if (completed) {
    saveCache();
    if (tasks.length && valid()) notifyProgress();
  }

  let next = 0;
  const enqueueNext = () => {
    while (next < missing.length && (missing[next].job || !pruneConsumers(missing[next]))) next += 1;
    if (next >= missing.length) return;
    const batch = [missing[next++]];
    const numbering = provider === 'custom' ? 4 : 0;
    let chars = batch[0].text.length + (numbering ? 3 : 0);
    while (provider !== 'google' && next < missing.length && batch.length < 8 &&
      chars + missing[next].text.length + numbering <= BATCH_CHARS) {
      const item = missing[next++];
      if (item.job || !pruneConsumers(item)) continue;
      chars += item.text.length + numbering;
      batch.push(item);
    }
    enqueue(batch, provider, lang, settings);
    void Promise.allSettled(batch.map((item) => owned.get(item))).then(enqueueNext);
  };
  // Bound each caller's queued batches so a newly opened block can take a turn.
  for (let i = 0; i < CONCURRENCY + 1; i += 1) enqueueNext();
  const results = await Promise.allSettled(tasks);
  if (progressTimer) cancelFrame(progressTimer);
  progressTimer = 0;
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  const finalText = preserveFencedCode(source, out.join(''));
  if (valid()) onProgress(finalText, total, total);
  return finalText;
}

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------

function injectStyles() {
  if (state.stylesInjected) return;
  state.stylesInjected = true;
  const style = document.createElement('style');
  style.dataset[NS] = 'style';
  style.textContent = `
.think[data-kct-mounted]{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;column-gap:8px}
.think[data-kct-mounted]>.think-head{min-width:0}
.think[data-kct-mounted]>.think-body{grid-column:1/-1}
.${NS}-bar{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:4px;font:12px/20px var(--font-ui,sans-serif);color:var(--color-text-muted,#777)}
.${NS}-bar[hidden]{display:none}
.${NS}-btn{font:inherit;color:inherit;background:transparent;border:0;border-radius:var(--radius-sm,4px);padding:0 5px;cursor:pointer;white-space:nowrap}
.${NS}-btn:hover{color:var(--color-text,#222);background:var(--color-surface-sunken,rgba(128,128,128,.1))}
.${NS}-btn:focus-visible{outline:2px solid var(--color-accent,#4385ef);outline-offset:2px}
.${NS}-btn:disabled{cursor:default}
.${NS}-status{color:var(--color-text-faint,#888);font-size:11px}
.${NS}-status:empty{display:none}
.${NS}-status[data-state="error"]{color:var(--color-danger,#b9433e)}
.${NS}-translated{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
[kct-view="original"] .${NS}-translated{display:none}
[kct-view="translated"] .${NS}-translated{display:block}
.${NS}-source-hidden{display:none !important}
.${NS}-panel{position:fixed;inset-block-start:56px;inset-inline-end:16px;z-index:2147483000;box-sizing:border-box;width:300px;max-width:calc(100vw - 32px);max-height:calc(100vh - 72px);overflow:auto;padding:14px;border-radius:8px;background:var(--color-surface-raised,#fff);color:var(--color-text,#111);border:1px solid var(--color-line,rgba(0,0,0,.15));box-shadow:0 8px 28px rgba(0,0,0,.15);font:12px/1.7 var(--font-ui,sans-serif)}
.${NS}-panel-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.${NS}-panel h4{margin:0 0 8px;font-size:12px;font-weight:600}
.${NS}-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0}
.${NS}-row>select,.${NS}-row>input{min-width:0;max-width:164px;font:inherit;padding:3px 5px;border-radius:4px;border:1px solid var(--color-line,rgba(128,128,128,.4));background:var(--color-surface-raised,#fff);color:inherit}
.${NS}-hint{margin-top:8px;opacity:.65;font-size:11px}
.${NS}-start{display:block;width:100%;margin-top:12px;padding:6px 10px;background:var(--color-text,#222);color:var(--color-surface-raised,#fff)}
@media(max-width:480px){.${NS}-bar{gap:2px;font-size:11px;max-width:180px}.${NS}-status{max-width:85px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
`;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// mounting
// ---------------------------------------------------------------------------

function mount(think) {
  if (ctxs.has(think)) return;
  const head = think.querySelector(HEAD);
  const body = think.querySelector(BODY_INNER) || think.querySelector('.think-body');
  if (!head || !body) return;

  const bar = document.createElement('div');
  bar.className = `${NS}-bar`;
  bar.dataset[NS] = 'bar';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = `${NS}-btn`;
  toggle.textContent = '翻译';
  toggle.title = '翻译这段思考';

  const status = document.createElement('button');
  status.type = 'button';
  status.className = `${NS}-btn ${NS}-status`;
  status.setAttribute('aria-live', 'polite');
  status.dataset.state = 'idle';
  status.disabled = true;

  const settings = document.createElement('button');
  settings.type = 'button';
  settings.className = `${NS}-btn`;
  settings.dataset[NS + 'Settings'] = '1';
  settings.textContent = '设置';
  settings.setAttribute('aria-label', '思维链翻译设置');
  settings.addEventListener('click', openPanel);

  bar.append(status, toggle, settings);
  bar.hidden = !isOpen(think);
  head.after(bar);
  think.dataset.kctMounted = '1';

  const ctx = {
    think,
    body,
    bar,
    toggle,
    status,
    pickedSource: pickSource(body),
    sourceNode: null,
    view: 'original',
    running: false,
    done: false,
    requested: false,
    source: '',
    timer: 0,
    lastError: '',
    generation: 0,
    preferOriginal: false,
    rendered: false,
    skipped: false,
    translatedPrefix: '',
    translatedSource: '',
    retryFailed: false,
    streamSince: 0,
  };
  ctx.sourceNode = ctx.pickedSource;
  ctxs.set(think, ctx);

  toggle.addEventListener('click', () => {
    if (!hasTargetLanguage()) {
      openPanel({ currentTarget: toggle });
      return;
    }
    if (ctx.rendered) {
      ctx.preferOriginal = ctx.view === 'translated';
      setView(ctx, ctx.view === 'original' ? 'translated' : 'original');
      return;
    }
    // Not translated yet — treat the click as a manual "translate now".
    if (ctx.running) return;
    ctx.requested = true;
    ctx.retryFailed = true;
    schedule(ctx);
  });

  status.addEventListener('click', () => {
    if (status.dataset.state !== 'error') return;
    ctx.requested = true;
    ctx.retryFailed = true;
    schedule(ctx);
  });

  schedule(ctx);
}

function setView(ctx, view) {
  ctx.view = view;
  // Drive visibility with one attribute on the block we already own. Use a
  // dedicated name so it never collides with the mount marker the observer
  // uses to recognise our own nodes.
  ctx.think.setAttribute(`${NS}-view`, view);
  // Hide whichever node actually holds the reasoning text. Resolve it lazily:
  // a virtualised transcript may replace the node after mount.
  const source = pickSource(ctx.body);
  if (source) {
    ctx.sourceNode = source;
    const hidden = view === 'translated';
    if (source.classList.contains(`${NS}-source-hidden`) !== hidden) {
      source.classList.toggle(`${NS}-source-hidden`, hidden);
    }
  }
  ctx.toggle.textContent = view === 'translated' ? '原文' : ctx.rendered ? '译文' : '翻译';
  ctx.toggle.title = view === 'translated' ? '查看原文' : ctx.rendered ? '查看译文' : '翻译这段思考';
  ctx.toggle.setAttribute('aria-label', ctx.toggle.title);
  ctx.toggle.setAttribute('aria-pressed', String(view === 'translated'));
  ctx.toggle.hidden = ctx.skipped;
}

function readSource(ctx) {
  // Kimi renders reasoning as <pre> today, but history rows and future
  // renders may differ, so fall back to the block body minus our own nodes.
  const cached = ctx.sourceNode;
  if (cached && ctx.body.contains(cached)) return cached.textContent || '';
  const node = pickSource(ctx.body);
  if (node) {
    ctx.sourceNode = node;
    return node.textContent || '';
  }
  return sourceFromBody(ctx.body);
}

function sourceFromBody(body) {
  const clone = body.cloneNode(true);
  for (const el of clone.querySelectorAll(`[data-${NS}], .${NS}-translated`)) el.remove();
  return clone.textContent || '';
}

// Pick whatever node actually holds the reasoning text, so view switching can
// hide it without guessing. Prefers a direct <pre>, then any descendant.
function pickSource(body) {
  const pres = [...body.querySelectorAll('pre')].filter((el) => !el.closest(`[data-${NS}]`));
  if (pres.length > 0) return pres[0];
  for (const child of body.children) {
    if (child.dataset[NS] || child.classList.contains(`${NS}-translated`)) continue;
    if ((child.textContent || '').trim() !== '') return child;
  }
  return null;
}

function cancelContext(ctx) {
  ctx.generation += 1;
  ctx.running = false;
  clearTimeout(ctx.timer);
  ctx.timer = 0;
  ctx.streamSince = 0;
  scheduled.delete(ctx);
  if (!scheduled.size && rafPending) {
    cancelAnimationFrame(rafPending);
    rafPending = 0;
  }
}

function schedule(ctx) {
  if (!ctx.think.isConnected || !isOpen(ctx.think)) {
    cancelContext(ctx);
    ctx.bar.hidden = true;
    return;
  }
  scheduled.add(ctx);
  if (rafPending) return;
  rafPending = requestAnimationFrame(() => {
    rafPending = 0;
    const batch = [...scheduled];
    scheduled.clear();
    for (const item of batch) void maybeRun(item);
  });
}

function isOpen(think) {
  const body = think.querySelector('.think-body');
  return !!body && body.classList.contains('open');
}

function isStreaming(think) {
  return think.classList.contains('streaming');
}

async function maybeRun(ctx) {
  if (!ctx.think.isConnected) return;
  ctx.bar.hidden = !isOpen(ctx.think);
  const body = ctx.think.querySelector(BODY_INNER);
  if (!body) return;
  if (body !== ctx.body) {
    ctx.generation += 1;
    ctx.running = false;
    ctx.body = body;
    ctx.sourceNode = pickSource(body);
    ctx.source = '';
    ctx.done = false;
    ctx.rendered = false;
    ctx.skipped = false;
    ctx.translatedSource = '';
    setView(ctx, 'original');
  }
  if (!ctx.bar.isConnected) ctx.think.querySelector(HEAD)?.after(ctx.bar);
  const source = readSource(ctx);
  if (ctx.skipped && source !== ctx.source) {
    ctx.skipped = false;
    ctx.done = false;
    setView(ctx, 'original');
  }
  if (ctx.rendered && source.startsWith(ctx.translatedSource)) {
    render(ctx, ctx.translatedPrefix + source.slice(ctx.translatedSource.length));
  } else if (ctx.rendered) {
    ctx.rendered = false;
    ctx.translatedSource = '';
    setView(ctx, 'original');
  }
  if (source !== ctx.source && ctx.done) {
    ctx.done = false;
    ctx.rendered = false;
    setView(ctx, 'original');
  } else if (ctx.done) {
    // Vue can replace just the source node while leaving the block alive.
    if (!ctx.skipped && !ctx.body.querySelector(`.${NS}-translated`)) ctx.done = false;
    setView(ctx, ctx.view);
  }
  if (!state.settings.enabled || ctx.running || !isOpen(ctx.think)) return;
  if (!hasTargetLanguage()) {
    if (!setupPrompted) {
      setupPrompted = true;
      if (!panel) openPanel({ currentTarget: ctx.bar.querySelector('[data-kct-settings]') });
    }
    return;
  }
  if (!state.settings.autoTranslate && !ctx.requested) return;
  if (state.settings.provider === 'custom' && state.settings.customKeyPending) {
    ctx.status.dataset.state = 'error';
    ctx.status.textContent = '请确认新端点密钥';
    ctx.status.disabled = true;
    return;
  }

  if (source.trim() === '') return;
  if (source === ctx.source && ctx.done) return;

  if (isStreaming(ctx.think)) {
    if (!ctx.streamSince) ctx.streamSince = Date.now();
    if (!ctx.timer) ctx.timer = window.setTimeout(() => {
      ctx.timer = 0;
      if (ctx.think.isConnected && isOpen(ctx.think) && state.settings.enabled &&
        (state.settings.autoTranslate || ctx.requested)) void run(ctx);
    }, STREAM_DEBOUNCE_MS);
    return;
  }

  clearTimeout(ctx.timer);
  ctx.timer = 0;
  await run(ctx);
}

async function run(ctx) {
  if (ctx.running || !hasTargetLanguage()) return;
  const fullSource = readSource(ctx);
  let source = fullSource;
  if (isStreaming(ctx.think)) {
    source = stableStreamSource(fullSource, Date.now() - ctx.streamSince >= STREAM_MAX_WAIT_MS);
    if (!source.trim() && Date.now() - ctx.streamSince < STREAM_MAX_WAIT_MS && !ctx.timer) {
      ctx.timer = setTimeout(() => {
        ctx.timer = 0;
        if (ctx.think.isConnected && isOpen(ctx.think) && state.settings.enabled) void run(ctx);
      },
        STREAM_MAX_WAIT_MS - (Date.now() - ctx.streamSince));
    }
  }
  if (!source.trim()) return;
  const lang = resolveTarget();
  if (translationPieces(fullSource, lang).every(({ skip }) => skip)) {
    render(ctx, fullSource);
    ctx.source = fullSource;
    ctx.done = !isStreaming(ctx.think);
    ctx.status.dataset.state = 'ok';
    ctx.status.textContent = '';
    ctx.status.title = '';
    ctx.status.disabled = true;
    ctx.toggle.disabled = false;
    return;
  }
  if (source === ctx.source && ctx.rendered) {
    if (!isStreaming(ctx.think)) {
      ctx.done = true;
      ctx.status.textContent = '';
    }
    return;
  }

  const generation = ++ctx.generation;
  const body = ctx.body;
  const url = location.href;
  const valid = () => ctx.generation === generation && ctx.think.isConnected &&
    body.isConnected && isOpen(ctx.think) && location.href === url && readSource(ctx).startsWith(source);
  ctx.running = true;
  const retryFailed = ctx.retryFailed;
  ctx.retryFailed = false;
  ctx.lastError = '';
  ctx.status.dataset.state = 'loading';
  ctx.status.textContent = '翻译中…';
  ctx.status.title = '';
  ctx.status.disabled = true;
  ctx.toggle.disabled = false;

  try {
    const translated = await translateText(source, lang, (text, done, total) => {
      const current = readSource(ctx);
      if (!valid() || !current.startsWith(source)) return;
      ctx.translatedPrefix = text;
      ctx.translatedSource = source;
      render(ctx, text + current.slice(source.length));
      ctx.status.textContent = `翻译中 ${done}/${total}`;
    }, { ...state.settings }, valid, retryFailed);
    if (!valid() || !readSource(ctx).startsWith(source)) return;
    const current = readSource(ctx);
    ctx.translatedPrefix = translated;
    ctx.translatedSource = source;
    render(ctx, translated + current.slice(source.length));
    ctx.done = current === source && !isStreaming(ctx.think);
    ctx.source = source;
    ctx.status.dataset.state = 'ok';
    ctx.status.textContent = ctx.done ? '' : '后续内容待翻译';
    ctx.status.title = '';
    ctx.status.disabled = true;
    ctx.toggle.disabled = false;
    ctx.lastError = '';
  } catch (error) {
    if (!valid()) return;
    ctx.lastError = String((error && error.message) || error);
    ctx.status.dataset.state = 'error';
    ctx.status.textContent = '重试';
    ctx.status.title = `翻译失败：${ctx.lastError}`;
    ctx.status.disabled = false;
    ctx.toggle.disabled = false;
  } finally {
    if (ctx.generation === generation) {
      ctx.running = false;
      if (valid() && readSource(ctx) !== fullSource) schedule(ctx);
    }
  }
}

function render(ctx, text) {
  let node = ctx.body.querySelector(`.${NS}-translated`);
  ctx.skipped = text === readSource(ctx);
  if (ctx.skipped) {
    node?.remove();
    ctx.rendered = false;
    setView(ctx, 'original');
    return;
  }
  if (!node) {
    node = pickSource(ctx.body)?.cloneNode(false) || document.createElement('pre');
    node.removeAttribute('id');
    node.classList.remove(`${NS}-source-hidden`);
    node.classList.add(`${NS}-translated`);
    node.dataset[NS] = 'translated';
    ctx.body.appendChild(node);
  }
  if (node.textContent !== text) node.textContent = text;
  ctx.rendered = true;
  setView(ctx, ctx.preferOriginal ? 'original' : 'translated');
}

// ---------------------------------------------------------------------------
// settings panel
// ---------------------------------------------------------------------------

let panel = null;
let panelTrigger = null;

function closePanel() {
  panel?.remove();
  panel = null;
  if (panelTrigger?.isConnected) panelTrigger.focus();
  panelTrigger = null;
}

function openPanel(event) {
  if (panel) {
    closePanel();
    return;
  }
  panelTrigger = event?.currentTarget || null;
  panel = document.createElement('div');
  panel.id = 'kct-settings';
  panel.className = `${NS}-panel`;
  panel.dataset[NS] = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '思维链翻译设置');

  const heading = document.createElement('div');
  heading.className = `${NS}-panel-heading`;
  const title = document.createElement('h4');
  const firstUse = !hasTargetLanguage();
  title.textContent = firstUse ? '选择翻译语言' : '思维链翻译';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = `${NS}-btn`;
  close.textContent = '关闭';
  close.addEventListener('click', closePanel);
  heading.append(title, close);
  panel.appendChild(heading);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closePanel();
    }
  });

  if (firstUse) {
    const intro = document.createElement('p');
    intro.textContent = '你希望将思考内容翻译为什么语言？已是目标语言的内容会保留原样。之后可在设置中更改。';
    panel.appendChild(intro);
  }
  const suggested = resolveTarget();
  const language = select(TARGET_LANGUAGES,
    firstUse ? TARGET_LANGUAGES.includes(suggested) ? suggested : 'en' : state.settings.targetLanguage,
    (v) => {
      if (firstUse) return;
      state.settings.targetLanguage = v;
      saveSettings();
      resetAll();
    });
  panel.appendChild(
    row(
      '目标语言',
      language,
    ),
  );
  if (firstUse) {
    const hint = document.createElement('div');
    hint.className = `${NS}-hint`;
    const service = { bing: 'Bing', google: 'Google', custom: '你配置的自定义端点' }[state.settings.provider];
    hint.textContent = `需要翻译的思考原文会发送到${service || '所选翻译服务'}。确认前不会发送，之后可在设置中更改服务。`;
    panel.appendChild(hint);
    const start = document.createElement('button');
    start.type = 'button';
    start.className = `${NS}-btn ${NS}-start`;
    start.textContent = '开始使用';
    start.addEventListener('click', () => {
      state.settings.targetLanguage = language.value;
      saveSettings();
      closePanel();
      resetAll();
    });
    panel.appendChild(start);
    document.body.appendChild(panel);
    language.focus();
    return;
  }

  panel.appendChild(
    row(
      '启用翻译',
      checkbox(state.settings.enabled, (v) => {
        state.settings.enabled = v;
        saveSettings();
        resetAll();
      }),
    ),
  );

  panel.appendChild(
    row(
      '翻译服务',
      select(['bing', 'google', 'custom'], state.settings.provider, (v) => {
        state.settings.provider = v;
        saveSettings();
        if (panel) {
          const trigger = panelTrigger;
          closePanel();
          openPanel({ currentTarget: trigger });
        }
        resetAll();
      }),
    ),
  );

  panel.appendChild(
    row(
      '自动翻译',
      checkbox(state.settings.autoTranslate, (v) => {
        state.settings.autoTranslate = v;
        saveSettings();
        resetAll();
      }),
    ),
  );

  if (state.settings.provider === 'custom') {
    const endpoint = document.createElement('input');
    endpoint.placeholder = 'https://…/v1/chat/completions';
    endpoint.value = state.settings.customEndpoint;
    endpoint.addEventListener('change', () => {
      const value = endpoint.value.trim();
      let next;
      try {
        next = customEndpointURL(value);
      } catch (error) {
        endpoint.setCustomValidity(error.message);
        endpoint.reportValidity();
        endpointError.textContent = error.message;
        return;
      }
      endpoint.setCustomValidity('');
      let previousOrigin = '';
      try { previousOrigin = new URL(state.settings.customEndpoint).origin; } catch (_) { /* unset */ }
      if (next.origin !== previousOrigin) {
        state.settings.customKey = '';
        key.value = '';
        state.settings.customKeyPending = true;
      }
      state.settings.customEndpoint = value;
      confirmKey.hidden = !state.settings.customKeyPending;
      endpointError.textContent = state.settings.customKeyPending ? '请确认新端点的密钥；无密钥可留空确认。' : '';
      saveSettings();
      resetAll();
    });
    panel.appendChild(row('端点', endpoint));

    const model = document.createElement('input');
    model.placeholder = 'model name';
    model.value = state.settings.customModel;
    model.addEventListener('change', () => {
      state.settings.customModel = model.value.trim();
      saveSettings();
      resetAll();
    });
    panel.appendChild(row('模型', model));

    const key = document.createElement('input');
    key.type = 'password';
    key.placeholder = 'API key（可选）';
    key.value = state.settings.customKey;
    const saveKey = () => {
      if (!endpoint.checkValidity()) {
        endpoint.reportValidity();
        return;
      }
      state.settings.customKey = key.value.trim();
      state.settings.customKeyPending = false;
      confirmKey.hidden = true;
      endpointError.textContent = '';
      saveSettings();
      resetAll();
    };
    key.addEventListener('change', () => {
      if (!state.settings.customKeyPending) saveKey();
    });
    panel.appendChild(row('密钥', key));
    const confirmKey = document.createElement('button');
    confirmKey.type = 'button';
    confirmKey.className = `${NS}-btn`;
    confirmKey.textContent = '确认密钥';
    confirmKey.hidden = !state.settings.customKeyPending;
    confirmKey.addEventListener('click', saveKey);
    panel.appendChild(confirmKey);
    const endpointError = document.createElement('div');
    endpointError.setAttribute('role', 'alert');
    endpointError.textContent = state.settings.customKeyPending ? '请确认新端点的密钥；无密钥可留空确认。' : '';
    panel.appendChild(endpointError);
  }

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = `${NS}-btn`;
  clear.textContent = '清空缓存';
  clear.addEventListener('click', () => {
    cacheEpoch += 1;
    state.cache.clear();
    saveCache();
    persistCache();
    clear.textContent = '已清空';
  });
  panel.appendChild(row('缓存', clear));

  const hint = document.createElement('div');
  hint.className = `${NS}-hint`;
  hint.textContent =
    state.settings.provider === 'custom'
      ? '思考原文会发送到你配置的自定义端点。'
      : '思考原文会发送到所选翻译服务，可能包含代码与对话细节。';
  panel.appendChild(hint);
  document.body.appendChild(panel);
  panel.querySelector('select')?.focus();
}

function diagnose() {
  const blocks = [...document.querySelectorAll(THINK)];
  const lines = [`发现 ${blocks.length} 个思考块`];
  blocks.forEach((think, i) => {
    const ctx = ctxs.get(think);
    const body = think.querySelector(BODY_INNER) || think.querySelector('.think-body');
    const bodyOpen = think.querySelector('.think-body');
    const source = ctx ? readSource(ctx) : '';
    const preCount = body ? body.querySelectorAll('pre').length : 0;
    lines.push(
      [
        `#${i + 1}`,
        `open=${bodyOpen ? bodyOpen.classList.contains('open') : '?'}`,
        `streaming=${think.classList.contains('streaming')}`,
        `ctx=${!!ctx}`,
        `srcNode=${ctx && ctx.sourceNode ? ctx.sourceNode.tagName : 'none'}`,
        `pre=${preCount}`,
        `srcLen=${source.length}`,
        `view=${ctx ? ctx.view : '-'}`,
        `状态=${ctx ? `${ctx.status.dataset.state}` : '-'}`,
        ctx && ctx.lastError ? `err=${ctx.lastError}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
  });
  return lines.join('\n');
}

function row(label, control) {
  const wrap = document.createElement('div');
  wrap.className = `${NS}-row`;
  const span = document.createElement('label');
  span.textContent = label;
  control.id = `kct-control-${label}`;
  span.htmlFor = control.id;
  wrap.append(span, control);
  return wrap;
}

function select(options, value, onChange) {
  const labels = {
    auto: '跟随 Kimi 界面', zh: '简体中文', en: 'English', ja: '日本語', ko: '한국어',
    es: 'Español', fr: 'Français', de: 'Deutsch', ru: 'Русский',
    bing: 'Bing', google: 'Google', custom: '自定义服务',
  };
  const el = document.createElement('select');
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option;
    item.textContent = labels[option] || option;
    if (option === value) item.selected = true;
    el.appendChild(item);
  }
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function checkbox(value, onChange) {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.checked = value;
  el.addEventListener('change', () => onChange(el.checked));
  return el;
}

function resetAll() {
  for (const think of document.querySelectorAll(THINK)) {
    const ctx = ctxs.get(think);
    if (!ctx) continue;
    cancelContext(ctx);
    ctx.done = false;
    ctx.requested = false;
    ctx.source = '';
    ctx.retryFailed = false;
    ctx.rendered = false;
    ctx.skipped = false;
    ctx.translatedSource = '';
    ctx.preferOriginal = false;
    const node = ctx.body.querySelector(`.${NS}-translated`);
    if (node) node.remove();
    setView(ctx, 'original');
    ctx.toggle.disabled = false;
    ctx.status.dataset.state = 'idle';
    ctx.status.textContent = '';
    ctx.status.title = '';
    ctx.status.disabled = true;
    schedule(ctx);
  }
  prunePending();
}

// ---------------------------------------------------------------------------
// observer
// ---------------------------------------------------------------------------

function isOurs(node) {
  if (!(node instanceof Element)) return false;
  return !!node.closest('[data-kct]');
}

const observer = typeof document === 'undefined' ? null : new MutationObserver((records) => {
  for (const record of records) {
    const el = record.target instanceof Element ? record.target : record.target.parentElement;
    if (!el) continue;

    // Ignore our own mutations: the toolbar, the translated node and the
    // panel all live inside or on the think block.
    if (isOurs(el) || isOurs(record.target)) continue;

    if (record.type === 'childList') {
      for (const removed of record.removedNodes) {
        if (!(removed instanceof Element) || removed.isConnected) continue;
        const hosts = removed.matches(THINK) ? [removed] : [];
        hosts.push(...removed.querySelectorAll(THINK));
        for (const host of hosts) {
          const ctx = ctxs.get(host);
          if (ctx) cancelContext(ctx);
        }
      }
    }

    // Attribute changes matter: expanding a block flips `.think-body.open`,
    // and reasoning going from streaming to settled flips `.think`. This is
    // the trigger the first version missed, which is why the button appeared
    // but nothing was ever translated.
    if (record.type === 'attributes') {
      const host = el.closest(THINK) || (el.matches(THINK) ? el : null);
      if (!host) continue;
      const ctx = ctxs.get(host);
      if (ctx) schedule(ctx);
      else mount(host);
      continue;
    }

    const host = el.closest(THINK);
    if (host) {
      const ctx = ctxs.get(host);
      if (ctx) {
        if (record.type === 'characterData' || record.type === 'childList') schedule(ctx);
      } else {
        mount(host);
      }
      continue;
    }
    if (record.type === 'childList') {
      for (const added of record.addedNodes) {
        if (!(added instanceof Element)) continue;
        if (added.matches(THINK)) mount(added);
        for (const inner of added.querySelectorAll(THINK)) mount(inner);
      }
    }
  }
  prunePending();
  if (panelTrigger && !panelTrigger.isConnected) closePanel();
});

function leavePage() {
  for (const think of document.querySelectorAll(THINK)) {
    const ctx = ctxs.get(think);
    if (ctx) cancelContext(ctx);
  }
  closePanel();
  prunePending();
}

function flushCache() {
  if (cacheDirty && !cacheMemoryOnly) persistCache();
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

function boot() {
  loadSettings();
  loadCache();
  injectStyles();

  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  for (const think of document.querySelectorAll(THINK)) mount(think);

  window.navigation?.addEventListener('currententrychange', leavePage);
  window.addEventListener('popstate', leavePage);
  window.addEventListener('hashchange', leavePage);
  window.addEventListener('pagehide', flushCache);
  window.addEventListener('pagehide', leavePage);
  window.addEventListener('beforeunload', flushCache);
}

if (typeof document === 'undefined') {
  module.exports = {
    state, translateText, isTargetLanguage, TARGET_LANGUAGES, prunePending,
    cancelRequests: () => { for (const controller of requestControllers) controller.abort(); },
  };
} else {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
  window.__kct = { state, mount, openPanel, resetAll, translateText, diagnose };
}
