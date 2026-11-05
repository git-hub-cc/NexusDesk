(() => {
  let reported = false;
  const expectedId = () => location.pathname.match(/\/(?:video|note)\/(\d+)/)?.[1]
    || new URL(location.href).searchParams.get('modal_id');
  const report = data => {
    try {
      const detail = data.aweme_detail || data;
      const id = detail.aweme_id || detail.awemeId;
      if (id && expectedId() && String(id) !== expectedId()) return;
      const video = detail.video || {};
      const address = video.play_addr || video.playAddr;
      const urls = address?.url_list || address?.urlList || [];
      const url = urls.find(value => /^https?:\/\//i.test(value));
      if (!url || reported) return;
      reported = true;
      location.href = 'nexusdesk-douyin://result?url=' + encodeURIComponent(url.replace(/^http:/i, 'https:'))
        + '&title=' + encodeURIComponent(detail.desc || '抖音视频');
    } catch {}
  };
  const isDetail = url => String(url?.url || url).includes('/aweme/v1/web/aweme/detail/');
  const fetchOriginal = window.fetch;
  window.fetch = async function (...args) {
    const response = await fetchOriginal.apply(this, args);
    if (isDetail(args[0])) response.clone().json().then(report).catch(() => {});
    return response;
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this.__nexusdeskUrl = url;
    return open.call(this, method, url, ...args);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      if (!isDetail(this.__nexusdeskUrl)) return;
      try { report(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch {}
    });
    return send.apply(this, args);
  };

  // Some share pages embed the detail in their initial state and never request the web API.
  const inspect = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 12 || reported) return;
    if (value.video && (value.aweme_id || value.awemeId)) report(value);
    for (const child of Object.values(value)) inspect(child, depth + 1);
  };
  let attempts = 0;
  const timer = setInterval(() => {
    if (reported || ++attempts > 110) { clearInterval(timer); return; }
    for (const video of document.querySelectorAll('video')) video.muted = true;
    inspect(window._ROUTER_DATA);
    inspect(window.__INITIAL_STATE__);
    const renderData = document.getElementById('RENDER_DATA')?.textContent;
    if (renderData) {
      try { inspect(JSON.parse(renderData)); }
      catch { try { inspect(JSON.parse(decodeURIComponent(renderData))); } catch {} }
    }
  }, 500);
})();
