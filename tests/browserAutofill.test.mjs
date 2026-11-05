import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src-tauri/src/commands/browser_autofill.js', import.meta.url), 'utf8');
function page({ entries = [{ username: 'alice', password: 'secret' }], origin = 'https://example.com', typed = '', signup = false, delayed = false, identifierOnly = false } = {}) {
  const events = [];
  const observations = [];
  class Input {
    constructor(type, value = '') { this.type = type; this.value = value; this.autocomplete = ''; this.parentElement = {}; }
    get value() { return this.current; }
    set value(value) { this.current = value; }
    getClientRects() { return [1]; }
    compareDocumentPosition() { return 4; }
    dispatchEvent(event) { events.push(event.type); }
    insertAdjacentElement(_, element) { this.select = element; }
  }
  const username = new Input('text', typed), password = new Input('password');
  username.autocomplete = 'username';
  let present = !delayed, mutation;
  const listeners = {};
  const document = {
    documentElement: {},
    querySelectorAll(selector) { return !present ? [] : selector === 'input' ? (identifierOnly ? [username] : [username, password]) : (identifierOnly ? [] : [password]); },
    querySelector() { return signup ? {} : null; },
    addEventListener(name, callback) { listeners[name] = callback; }, removeEventListener() {},
    createElement() { return { options: [], style: {}, setAttribute() {}, add(option) { this.options.push(option); }, addEventListener(_, fn) { this.change = fn; }, remove() {} }; },
  };
  const window = {}; window.top = window;
  const context = { window, document, location: { origin }, HTMLInputElement: Input, Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, Event: class { constructor(type) { this.type = type; } },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    MutationObserver: class { constructor(fn) { mutation = fn; } observe(target, options) { observations.push({ target, options }); } disconnect() {} }, setTimeout(fn) { fn(); }, clearTimeout() {},
    site: 'https://example.com', entries,
  };
  vm.runInNewContext(`(() => { ${source} })()`, context);
  return { username, password, events, observations, location: context.location,
    submit() { listeners.submit({ isTrusted: true, type: 'submit' }); },
    change(trusted = true) { listeners.change({ isTrusted: trusted, type: 'change', target: password }); },
    showPassword() { identifierOnly = false; mutation(); },
    hide() { present = false; mutation(); },
    show() { present = true; mutation(); }, focus() { listeners.focusin?.(); } };
}

test('fills a login form and dispatches framework input/change events', () => {
  const p = page(); assert.equal(p.username.value, 'alice'); assert.equal(p.password.value, 'secret');
  assert.deepEqual(p.events, ['input', 'change', 'input', 'change']);
  p.password.value = ''; p.focus(); assert.equal(p.password.value, '');
});
test('does not overwrite another account or fill registration / different origins', () => {
  assert.equal(page({ typed: 'bob' }).password.value, '');
  assert.equal(page({ signup: true }).password.value, '');
  assert.equal(page({ origin: 'https://evil.example.com' }).password.value, '');
});
test('fills dynamically inserted login fields', () => {
  const p = page({ delayed: true }); assert.equal(p.password.value, '');
  p.show(); assert.equal(p.password.value, 'secret');
});
test('multiple accounts require selection before filling', () => {
  const p = page({ entries: [{ username: 'alice', password: 'one' }, { username: 'bob', password: 'two' }] });
  assert.equal(p.password.value, ''); assert.equal(p.password.select.options.length, 3);
  p.password.select.value = '1'; p.password.select.change();
  assert.equal(p.username.value, 'bob'); assert.equal(p.password.value, 'two');
});

test('fills identifier first and the password when the next step appears', () => {
  const p = page({ identifierOnly: true });
  assert.equal(p.username.value, 'alice');
  assert.equal(p.password.value, '');
  p.showPassword();
  assert.equal(p.password.value, 'secret');
});

test('preserves account choice between identifier and password steps', () => {
  const p = page({ identifierOnly: true, entries: [{ username: 'alice', password: 'one' }, { username: 'bob', password: 'two' }] });
  p.username.select.value = '1'; p.username.select.change();
  p.showPassword();
  assert.equal(p.password.value, 'two');
});

test('captures trusted edits and commits only after login controls disappear', () => {
  const p = page();
  p.password.value = 'updated';
  p.change(false);
  assert.equal(p.location.href, undefined);
  p.change();
  assert.match(p.location.href, /^noteide-password:\/\/capture\//);
  p.hide();
  assert.equal(p.location.href, 'noteide-password://commit/');
  p.location.href = 'https://example.com/accountchooser';
  p.hide();
  assert.equal(p.location.href, 'https://example.com/accountchooser');
});

test('account chooser and logout pages never navigate to commit without a captured edit', () => {
  const p = page({ delayed: true });
  assert.equal(p.location.href, undefined);
  p.hide();
  assert.equal(p.location.href, undefined);
  const login = page();
  login.hide();
  assert.equal(login.location.href, undefined);
});


test('pages without login controls install no DOM observers and discover login on focus', () => {
  const p = page({ delayed: true });
  assert.equal(p.observations.length, 0);
  p.show();
  p.focus();
  assert.equal(p.password.value, 'secret');
  assert.ok(p.observations.length > 0);
});

test('login observers exclude global class/style attribute changes', () => {
  const p = page();
  assert.ok(p.observations.length > 0);
  for (const { options } of p.observations) {
    assert.ok(!options.attributeFilter?.includes('class'));
    assert.ok(!options.attributeFilter?.includes('style'));
  }
});
