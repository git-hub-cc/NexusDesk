(() => {
  if (window.top !== window || !/(^|\.)youtube\.com$/i.test(location.hostname)) return;
  const prefix = 'noteide:youtube-progress:';
  let active = null;
  const videoId = () => {
    const url = new URL(location.href);
    return url.pathname === '/watch' ? url.searchParams.get('v') : null;
  };
  const save = () => {
    if (!active?.restored || active.id !== videoId() || active.video.readyState < 1
        || document.querySelector('.ad-showing, .ad-interrupting')) return;
    const { video, id } = active;
    if (!Number.isFinite(video.duration) || !Number.isFinite(video.currentTime)) return;
    try {
      if (video.ended || video.duration - video.currentTime < 2) localStorage.removeItem(prefix + id);
      else localStorage.setItem(prefix + id, String(video.currentTime));
    } catch { /* Storage can be disabled by the page's settings. */ }
  };
  const update = () => {
    const id = videoId();
    const video = document.querySelector('video.html5-main-video');
    if (!id || !video) { active = null; return; }
    if (!active || active.id !== id || active.video !== video) {
      let position = 0;
      try { position = Number(localStorage.getItem(prefix + id)); } catch {}
      const url = new URL(location.href);
      // Explicit timestamps take precedence over remembered positions.
      const explicit = url.searchParams.has('t') || url.searchParams.has('start') || /^#t=/.test(url.hash);
      active = { id, video, position: explicit ? 0 : position, restored: false };
    }
    if (document.querySelector('.ad-showing, .ad-interrupting') || video.readyState < 1
        || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const player = document.querySelector('#movie_player');
    // The reused video element can still contain the previous video's media.
    if (typeof player?.getVideoData === 'function' && player.getVideoData()?.video_id !== id) return;
    if (!active.restored) {
      if (Number.isFinite(active.position) && active.position > 0 && active.position < video.duration - 2) {
        try { video.currentTime = active.position; } catch { return; }
      }
      active.restored = true;
    } else save();
  };
  document.addEventListener('timeupdate', update, true);
  document.addEventListener('loadedmetadata', update, true);
  document.addEventListener('pause', save, true);
  document.addEventListener('ended', save, true);
  document.addEventListener('yt-navigate-start', () => { save(); active = null; });
  document.addEventListener('yt-navigate-finish', update);
  document.addEventListener('visibilitychange', save);
  window.addEventListener('pagehide', save);
  setInterval(update, 1000);
})();
