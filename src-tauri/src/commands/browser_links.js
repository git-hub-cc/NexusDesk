(() => {
  const googleHost = /^(www\.)?google\.(com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/i;
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor || anchor.hasAttribute('download')) return;
    const target = anchor.getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '';
    const newTab = target.toLowerCase() === '_blank';
    const modifiedClick = event.ctrlKey || event.metaKey;
    const googleResult = window.top === window && googleHost.test(location.hostname)
      && location.pathname === '/search' && anchor.closest('#search') && anchor.querySelector('h3');
    if (!newTab && !googleResult && !modifiedClick) return;
    const url = new URL(anchor.href, location.href);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    // 由宿主创建后台标签，避免 WebView 的默认修饰键点击行为丢失请求。
    event.preventDefault();
    event.stopImmediatePropagation();
    if (modifiedClick) location.assign(`nexusdesk-tab://open?url=${encodeURIComponent(url.href)}`);
    else if (newTab) window.open(url.href, '_blank', 'noopener');
    else if (target && !['_self', '_top', '_parent'].includes(target.toLowerCase())) window.open(url.href, target, 'noopener');
    else location.assign(url.href);
  }, true);
})();
