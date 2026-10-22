(() => {
  const api = acquireVsCodeApi();
  const source = document.getElementById('source');
  const sourceLabel = document.getElementById('source-label');
  const result = document.getElementById('result');
  const target = document.getElementById('target');
  const translate = document.getElementById('translate');
  const cancel = document.getElementById('cancel');
  const original = document.getElementById('original');
  const translated = document.getElementById('translated');
  const status = document.getElementById('status');

  function showOriginal(value) {
    source.hidden = sourceLabel.hidden = !value;
    result.hidden = value;
  }
  function busy(value) {
    source.disabled = target.disabled = translate.disabled = value;
    cancel.hidden = !value;
  }
  function invalidate() {
    result.textContent = '';
    original.disabled = translated.disabled = true;
    showOriginal(true);
  }
  source.addEventListener('input', invalidate);
  target.addEventListener('change', invalidate);
  original.addEventListener('click', () => showOriginal(true));
  translated.addEventListener('click', () => showOriginal(false));
  translate.addEventListener('click', () => {
    if (!source.value.trim()) {
      status.textContent = 'Paste the thinking text first.';
      return;
    }
    invalidate();
    busy(true);
    status.textContent = 'Translating with Bing...';
    api.postMessage({ type: 'translate', source: source.value, target: target.value });
  });
  cancel.addEventListener('click', () => api.postMessage({ type: 'cancel' }));
  window.addEventListener('message', ({ data }) => {
    if (data?.type === 'progress') {
      status.textContent = 'Translating with Bing...';
    } else if (data?.type === 'done') {
      result.textContent = data.text;
      original.disabled = translated.disabled = false;
      busy(false);
      showOriginal(false);
      status.textContent = 'Translation complete. Original text is preserved.';
    } else if (data?.type === 'error' || data?.type === 'cancelled') {
      busy(false);
      invalidate();
      status.textContent = data.type === 'cancelled'
        ? 'Cancelled. A request already sent may finish at the provider.' : data.text;
    }
  });
})();
