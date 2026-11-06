(() => {
  if (window.top !== window || location.hostname !== 'chromewebstore.google.com') return;
  // Capture before the store's handlers, including after SPA route changes.
  window.addEventListener('click', event => {
    if (!/^\/detail\/(?:[^/]+\/)?[a-p]{32}\/?$/.test(location.pathname)) return;
    const button = event.composedPath().find(node => node?.matches?.('button, [role="button"]'));
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    const text = (button.getAttribute('aria-label') || button.textContent || '').trim();
    if (!/^(?:Add to Chrome|Add to Chromium|添加至 Chrome|添加到 Chrome|添加至Chrome|添加到Chrome|添加扩展程序|添加扩展|添加拓展)$/i.test(text)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    location.href = 'nexusdesk-extension://install?source=' + encodeURIComponent(location.href);
  }, true);
})();
