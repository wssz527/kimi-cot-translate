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
  let active = false;
  let lastDone = -1;

  function showOriginal(value) {
    source.hidden = sourceLabel.hidden = !value;
    result.hidden = value;
  }
  function busy(value) {
    source.disabled = target.disabled = translate.disabled = value;
    cancel.hidden = !value;
    cancel.disabled = !value;
  }
  function invalidate() {
    result.textContent = '';
    original.disabled = translated.disabled = true;
    showOriginal(true);
  }
  function finish() {
    active = false;
    lastDone = -1;
    busy(false);
    invalidate();
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
    active = true;
    lastDone = -1;
    busy(true);
    status.textContent = 'Translating with Bing...';
    api.postMessage({ type: 'translate', source: source.value, target: target.value });
  });
  cancel.addEventListener('click', () => {
    active = false;
    lastDone = -1;
    cancel.disabled = true;
    status.textContent = 'Cancelling...';
    api.postMessage({ type: 'cancel' });
  });
  window.addEventListener('message', ({ data }) => {
    if (!active) {
      if (data?.type === 'cancelled') {
        finish();
        status.textContent = 'Cancelled. A request already sent may finish at the provider.';
      }
      return;
    }
    if (data?.type === 'progress' &&
        Number.isInteger(data.done) && Number.isInteger(data.total) &&
        data.total > 0 && data.done >= lastDone && data.done <= data.total) {
      lastDone = data.done;
      status.textContent = `Translating with Bing... ${data.done}/${data.total}`;
    } else if (data?.type === 'done') {
      active = false;
      result.textContent = data.text;
      original.disabled = translated.disabled = false;
      busy(false);
      showOriginal(false);
      status.textContent = 'Translation complete. Original text is preserved.';
    } else if (data?.type === 'error' || data?.type === 'cancelled') {
      finish();
      status.textContent = data.type === 'cancelled'
        ? 'Cancelled. A request already sent may finish at the provider.' : data.text;
    }
  });
})();
