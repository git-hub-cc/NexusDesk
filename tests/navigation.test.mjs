import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('navigation bridge opens web links in application tabs and rejects other protocols', () => {
  const messages = [];
  let click;
  const context = {
    URL, window: {}, location: { href: 'http://localhost/navigation/index.html', origin: 'http://localhost' },
    parent: { postMessage: (message, origin) => messages.push({ ...message, origin }) },
    document: { addEventListener: (_, handler) => { click = handler; } },
  };
  vm.runInNewContext(readFileSync(new URL('../public/navigation/bridge.js', import.meta.url), 'utf8'), context);
  context.window.open('https://example.com/search?q=hello');
  context.window.open('javascript:alert(1)');
  context.window.open('file:///secret');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].url, 'https://example.com/search?q=hello');
  assert.equal(messages[0].origin, 'http://localhost');
  let prevented = false;
  click({ target: { closest: () => ({ getAttribute: () => 'https://github.com', href: 'https://github.com/' }) }, preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  assert.equal(messages[1].url, 'https://github.com/');
});

test('GitHub synchronization round-trips Chinese data and preserves conflict checking', async () => {
  const source = readFileSync(new URL('../public/navigation/js/githubClient.js', import.meta.url), 'utf8');
  const { GitHubClient } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = { atob, btoa };
  const data = { customUserSites: { categoryName: '我的导航', sites: [{ title: '开发文档' }] } };
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: btoa(unescape(encodeURIComponent(JSON.stringify(data)))), sha: 'current-sha' }) });
    const client = new GitHubClient();
    client.setToken('test-token');
    client.setRepo('user/navhub-data');
    const remote = await client.getFile('navhub-data.json');
    assert.deepEqual(remote.content, data);
    globalThis.fetch = async (_, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.sha, 'current-sha');
      assert.deepEqual(JSON.parse(decodeURIComponent(escape(atob(body.content)))), data);
      return { ok: false, status: 409 };
    };
    await assert.rejects(client.saveFile('navhub-data.json', data, remote.sha), /版本冲突/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});


test('different sources retain debounced saves and uploads use sequential SHAs', async () => {
  const timers = new Map(), storage = new Map(), uploads = [];
  let timerId = 0, release;
  const source = readFileSync(new URL('../public/navigation/js/dataManager.js', import.meta.url), 'utf8')
    .replace(/^import .*;.*$/gm, '').replace(/export /g, '');
  const context = {
    Map, JSON, Date, console,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    CustomEvent: class {}, window: { dispatchEvent() {}, matchMedia: () => ({ matches: false }) },
    githubClient: {
      getFile: async () => ({ sha: 'initial' }),
      saveFile: async (_path, data, sha) => {
        uploads.push({ data, sha });
        if (uploads.length === 1) await new Promise(resolve => { release = resolve; });
        return { content: { sha: `sha-${uploads.length}` } };
      },
    },
  };
  vm.runInNewContext(source + '\nglobalThis.api = { state, saveNavData, NAV_CUSTOM_SOURCES_KEY };', context);
  const { state, saveNavData, NAV_CUSTOM_SOURCES_KEY } = context.api;
  state.github.token = 'token'; state.github.repo = 'repo';
  state.allSiteDataSources = [{ name: 'A' }, { name: 'B' }];
  storage.set(NAV_CUSTOM_SOURCES_KEY, JSON.stringify(state.allSiteDataSources));
  state.siteData = { categories: [{ categoryId: 'a', sites: [{ id: 'a' }] }] };
  saveNavData('A');
  state.siteData = { categories: [{ categoryId: 'b', sites: [{ id: 'b' }] }] };
  saveNavData('B');
  assert.equal(timers.size, 2);
  for (const callback of [...timers.values()]) callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(uploads.length, 1, 'uploads cannot race on the same SHA');
  assert.equal(uploads[0].data.customSources[0].data.categories[0].sites[0].id, 'a');
  assert.equal(uploads[0].data.customSources[1].data.categories[0].sites[0].id, 'b');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1].sha, 'sha-1');
});


test('deferred IME commit cannot use a changed file path with the same tab id', () => {
  const source = readFileSync(new URL('../src/components/editor/CodeMirrorEditor.tsx', import.meta.url), 'utf8');
  const body = source.split('compositionend: (_event, view) => {')[1].split('          dblclick:')[0].trim().replace(/},$/, '}');
  const calls = [];
  let callback;
  const view = { state: { doc: '??', selection: { main: { head: 2 } } } };
  const context = {
    composing: { current: true }, activeTabIdRef: { current: 'same-id' },
    tabRef: { current: { id: 'same-id', path: 'old.md' } }, viewRef: { current: view },
    syncingContent: { current: false }, pendingCompositionFlush: { current: false }, pane: 'left',
    clearTimeout() {}, setTimeout: fn => { callback = fn; return 1; },
    queueEditorContent: (...args) => calls.push(args), pushNavLocation: (...args) => calls.push(args),
    updateLinkState() {}, flushEditorContent() {}, view,
  };
  vm.runInNewContext('let compositionTimer; const end = (_event, view) => {' + body + '; end(null, view);', context);
  context.tabRef.current = { id: 'same-id', path: 'new.md' };
  callback();
  assert.deepEqual(calls, []);
});
