(() => {
  const googleHost = /^(www\.)?google\.(com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/i;
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor || anchor.hasAttribute('download')) return;
    const target = anchor.getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '';
    const newTab = target.toLowerCase() === '_blank';
    const googleResult = window.top === window && googleHost.test(location.hostname)
      && location.pathname === '/search' && anchor.closest('#search') && anchor.querySelector('h3');
    if (!newTab && !googleResult) return;
    const url = new URL(anchor.href, location.href);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    // Preserve new browsing contexts while keeping same-tab address updates in sync.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (newTab || event.ctrlKey || event.metaKey) window.open(url.href, '_blank', 'noopener');
    else if (target && !['_self', '_top', '_parent'].includes(target.toLowerCase())) window.open(url.href, target, 'noopener');
    else location.assign(url.href);
  }, true);
})();
