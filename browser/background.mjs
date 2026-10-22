export const LANGUAGES = ['zh-Hans', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru'];

export function settingsKey(url) {
  const parsed = new URL(url);
  const supported = (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)) ||
    (parsed.protocol === 'https:' && ['kimi.com', 'www.kimi.com'].includes(parsed.hostname));
  if (!supported || parsed.username || parsed.password) throw new Error('Unsupported page');
  return `kct.browser.v1:${parsed.origin}`;
}

export function validateRequest(message) {
  if (!LANGUAGES.includes(message?.lang) || !Array.isArray(message?.texts) ||
      message.texts.length < 1 || message.texts.length > 8 ||
      message.texts.some(text => typeof text !== 'string' || !text.trim() || text.length > 1500) ||
      message.texts.reduce((sum, text) => sum + text.length, 0) > 4000) {
    throw new Error('Invalid translation request');
  }
}

export async function translate(message, sender, api = chrome, request = fetch) {
  if (sender.id !== api.runtime.id || !sender.tab || sender.frameId !== 0) {
    throw new Error('Unsupported sender');
  }
  const key = settingsKey(sender.url);
  // Chromium keeps sender.url at the document's initial URL after SPA navigation.
  if (settingsKey(sender.tab.url) !== key ||
      (sender.documentLifecycle && sender.documentLifecycle !== 'active')) {
    throw new Error('Stale sender document');
  }
  validateRequest(message);
  const settings = (await api.storage.local.get(key))[key];
  if (settings?.consent !== true ||
      (settings.language === 'zh' ? 'zh-Hans' : settings.language) !== message.lang) {
    throw new Error('Choose and confirm a language first');
  }
  const url = new URL('https://edge.microsoft.com/translate/translatetext');
  url.searchParams.set('to', message.lang);
  url.searchParams.set('isEnterpriseClient', 'false');
  const response = await request(url.href, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message.texts),
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Translation HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload) || payload.length !== message.texts.length ||
      payload.some(item => typeof item?.translations?.[0]?.text !== 'string' ||
        !item.translations[0].text.trim() || item.translations[0].text.length > 20000)) {
    throw new Error('Invalid translation response');
  }
  return payload;
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.kind !== 'kct.bing') return false;
    translate(message, sender).then(
      payload => respond({ ok: true, payload }),
      error => respond({ ok: false, error: error.message }),
    );
    return true;
  });
}
