(() => {
  if (window.top !== window) return;
  let host, root, request;
  const close = () => { host?.remove(); host = root = null; };
  const send = (id, value = '') => {
    location.href = 'noteide-suggestion://action?' + new URLSearchParams({ request, id, value });
  };
  Object.defineProperty(window, '__noteideSuggestions', { value: data => {
    if (!data.html) { if (request === data.request) close(); return; }
    request = data.request;
    if (!host) {
      host = document.createElement('div');
      host.style.cssText = 'all:initial;position:fixed;inset:0;margin:0;padding:0;border:0;width:100%;height:100%;background:transparent;z-index:2147483647;pointer-events:none';
      host.setAttribute('popover', 'manual');
      root = host.attachShadow({ mode: 'closed' });
      root.addEventListener('pointerdown', event => event.preventDefault());
      root.addEventListener('click', event => {
        const action = event.target.closest('[data-action]');
        if (action) { event.stopPropagation(); send(action.dataset.action, action.dataset.value); }
      });
      document.documentElement.append(host);
      try { host.showPopover?.(); } catch { /* Older runtimes use fixed stacking. */ }
    }
    root.innerHTML = data.html;
    const panel = root.querySelector('.native-menu');
    panel.style.cssText = `position:absolute;pointer-events:auto;top:0;left:${Math.max(0, data.x)}px;width:${Math.max(1, Math.min(data.width, innerWidth - Math.max(0, data.x)))}px;max-height:min(240px,100vh);overflow:auto`;
  }});
  document.addEventListener('pointerdown', event => {
    if (host && !event.composedPath().includes(host)) { send('close'); close(); }
  }, true);
})();
