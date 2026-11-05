import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src-tauri/src/commands/browser_video_progress.js', import.meta.url), 'utf8');
function setup(href = 'https://www.youtube.com/watch?v=first') {
  const storage = new Map([['nexusdesk:youtube-progress:first', '42'], ['nexusdesk:youtube-progress:second', '85']]);
  const listeners = {};
  const video = { readyState: 1, duration: 200, currentTime: 0, ended: false };
  const state = { ad: false, id: 'first' };
  const location = { hostname: 'www.youtube.com', href };
  const window = { addEventListener: (name, fn) => { listeners[name] = fn; } };
  window.top = window;
  let tick;
  vm.runInNewContext(source, {
    window, location, URL, Number,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    document: {
      addEventListener: (name, fn) => { listeners[name] = fn; },
      querySelector: selector => selector === 'video.html5-main-video' ? video : selector === '#movie_player' ? { getVideoData: () => ({ video_id: state.id }) } : state.ad ? {} : null,
    },
    setInterval: fn => { tick = fn; },
  });
  return { storage, video, state, location, listeners, tick: () => tick() };
}

test('restores saved progress and persists playback on page exit', () => {
  const s = setup();
  s.tick();
  assert.equal(s.video.currentTime, 42);
  s.video.currentTime = 65;
  s.listeners.pagehide();
  assert.equal(s.storage.get('nexusdesk:youtube-progress:first'), '65');
});

test('SPA switches wait for matching media and do not overwrite the previous video', () => {
  const s = setup();
  s.tick();
  s.location.href = 'https://www.youtube.com/watch?v=second';
  s.tick();
  assert.equal(s.video.currentTime, 42);
  assert.equal(s.storage.get('nexusdesk:youtube-progress:second'), '85');
  s.state.id = 'second';
  s.video.currentTime = 0;
  s.tick();
  assert.equal(s.video.currentTime, 85);
  assert.equal(s.storage.get('nexusdesk:youtube-progress:first'), '42');
});

test('ads do not restore or save progress; completed videos clear their position', () => {
  const s = setup();
  s.state.ad = true;
  s.tick();
  assert.equal(s.video.currentTime, 0);
  s.listeners.pause();
  assert.equal(s.storage.get('nexusdesk:youtube-progress:first'), '42');
  s.state.ad = false;
  s.tick();
  assert.equal(s.video.currentTime, 42);
  s.video.currentTime = 200;
  s.video.ended = true;
  s.listeners.ended();
  assert.equal(s.storage.has('nexusdesk:youtube-progress:first'), false);
});

test('explicit timestamps take precedence and unavailable metadata preserves saved progress', () => {
  const s = setup('https://www.youtube.com/watch?v=first&t=10s');
  s.video.readyState = 0;
  s.tick();
  s.listeners.pagehide();
  assert.equal(s.storage.get('nexusdesk:youtube-progress:first'), '42');
  s.video.readyState = 1;
  s.video.currentTime = 10;
  s.tick();
  assert.equal(s.video.currentTime, 10);
});
