import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const script = readFileSync(new URL('../src-tauri/src/commands/browser_extensions.js', import.meta.url), 'utf8');

test('native extension settings requests open a workspace browser tab', async () => {
  const source = readFileSync(new URL('../src/components/editor/BrowserEditor.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('      unlistenNewTab = await');
  const end = source.indexOf('      if (disposed) { unlistenNewTab();', start);
  const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let handler;
  const tabs = [];
  const context = { URL, disposed: false, label: 'main-browser-one', tab: { browser: { root: 'C:/project' } },
    crypto: { randomUUID: () => 'new-tab' }, useWorkspaceStore: { getState: () => ({ openTab: tab => tabs.push(tab) }) },
    getCurrentWindow: () => ({ listen: async (event, callback) => { assert.equal(event, 'browser-new-tab-main-browser-one'); handler = callback; return () => {}; } }),
  };
  await vm.runInNewContext(`(async () => { let unlistenNewTab; ${compiled} })()`, context);
  const url = `chrome-extension://${'a'.repeat(32)}/pages/options.html#general`;
  handler({ payload: url });
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].browser.url, url);
  assert.equal(tabs[0].browser.root, 'C:/project');
  handler({ payload: 'javascript:alert(1)' });
  assert.equal(tabs.length, 1);
});
function page(hostname = 'chromewebstore.google.com', framed = false) {
  const handlers = {};
  const window = { addEventListener: (type, callback, capture) => { assert.equal(capture, true); handlers[type] = callback; } };
  window.top = framed ? {} : window;
  const location = { hostname, pathname: `/detail/test/${'a'.repeat(32)}`, href: `https://${hostname}/detail/test/${'a'.repeat(32)}?hl=zh-CN` };
  vm.runInNewContext(script, { window, location, encodeURIComponent });
  return { handlers, location };
}
function click(page, text, disabled = false) {
  let prevented = false, stopped = false;
  const button = { matches: () => true, disabled, getAttribute: () => null, textContent: text };
  page.handlers.click({ composedPath: () => [{}, button], preventDefault: () => prevented = true, stopImmediatePropagation: () => stopped = true });
  return { prevented, stopped };
}

test('store install clicks suppress native behavior and preserve the full source URL', () => {
  for (const text of ['Add to Chrome', '添加至 Chrome', '添加扩展程序']) {
    const view = page(), source = view.location.href;
    assert.deepEqual(click(view, text), { prevented: true, stopped: true });
    assert.equal(new URL(view.location.href).searchParams.get('source'), source);
  }
});

test('store interception ignores other buttons, disabled installs, frames and other origins', () => {
  assert.equal(page('example.com').handlers.click, undefined);
  assert.equal(page('chromewebstore.google.com', true).handlers.click, undefined);
  const view = page();
  assert.equal(click(view, 'Remove from Chrome').prevented, false);
  assert.equal(click(view, 'Add to Chrome', true).prevented, false);
  view.location.pathname = '/category/extensions';
  assert.equal(click(view, 'Add to Chrome').prevented, false);
});

test('store interception follows SPA detail route changes', () => {
  const view = page();
  view.location.pathname = `/detail/new/${'b'.repeat(32)}`;
  view.location.href = `https://chromewebstore.google.com${view.location.pathname}`;
  const source = view.location.href;
  click(view, 'Add to Chrome');
  assert.equal(new URL(view.location.href).searchParams.get('source'), source);
});
