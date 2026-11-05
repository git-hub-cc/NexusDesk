import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const script = readFileSync(new URL('../src-tauri/src/commands/browser_suggestions.js', import.meta.url), 'utf8');

function page() {
  const handlers = {}, rootHandlers = {};
  const panel = { style: {} };
  let removed = 0, created = 0, host;
  const root = { innerHTML: '', addEventListener: (name, fn) => rootHandlers[name] = fn, querySelector: () => panel };
  const window = {}; window.top = window;
  const location = { href: 'https://example.com/' };
  const document = {
    documentElement: { append: () => {} },
    createElement() { created++; host = { style: {}, setAttribute() {}, attachShadow: () => root, remove() { removed++; }, showPopover() {} }; return host; },
    addEventListener: (name, fn) => handlers[name] = fn,
  };
  vm.runInNewContext(script, { window, document, location, URLSearchParams, innerWidth: 800 });
  return { window, location, handlers, rootHandlers, root, panel, host: () => host, removed: () => removed, created: () => created };
}

test('injected panel updates one closed shadow root and ignores obsolete cleanup', () => {
  const view = page();
  view.window.__noteideSuggestions({ request: 'first', html: '<div class="native-menu">one</div>', x: 20, width: 1000 });
  view.window.__noteideSuggestions({ request: 'second', html: '<div class="native-menu">two</div>', x: 20, width: 1000 });
  assert.equal(view.created(), 1);
  assert.ok(view.panel.style.cssText.includes('width:780px'));
  view.window.__noteideSuggestions({ request: 'first', html: '' });
  assert.equal(view.removed(), 0);
  view.window.__noteideSuggestions({ request: 'second', html: '' });
  assert.equal(view.removed(), 1);
});

test('injected delete preserves URL encoding and outside presses dismiss', () => {
  const view = page();
  view.window.__noteideSuggestions({ request: 'token', html: '<div class="native-menu"></div>', x: 0, width: 300 });
  const url = 'https://example.com/path?q=a%20b&x=??#part';
  view.rootHandlers.click({ target: { closest: () => ({ dataset: { action: 'browser-history-remove', value: url } }) }, stopPropagation() {} });
  const message = new URL(view.location.href);
  assert.equal(message.protocol, 'noteide-suggestion:');
  assert.equal(message.searchParams.get('value'), url);
  assert.equal(message.searchParams.get('request'), 'token');
  view.handlers.pointerdown({ composedPath: () => [view.host()] });
  assert.equal(view.removed(), 0);
  view.handlers.pointerdown({ composedPath: () => [] });
  assert.equal(new URL(view.location.href).searchParams.get('id'), 'close');
  assert.equal(view.removed(), 1);
});
