import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src-tauri/src/commands/browser_gemini.js', import.meta.url), 'utf8');
function page({ hostname = 'gemini.google.com', search = '?prompt=hello', text = '', available = true, native = true, frame = false } = {}) {
  let changed, stopped = false, focused = false, inserted;
  const events = [];
  const editor = {
    textContent: text, getClientRects: () => [1], getAttribute: () => null,
    focus: () => { focused = true; }, dispatchEvent: event => events.push(event),
  };
  const window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
  window.top = frame ? {} : window;
  vm.runInNewContext(source, {
    window, location: { hostname, search }, URLSearchParams,
    document: {
      readyState: 'complete', documentElement: {},
      querySelector: () => available ? editor : null,
      createRange: () => ({ selectNodeContents() {} }),
      execCommand: (command, ui, value) => { inserted = value; return native; },
    },
    MutationObserver: class {
      constructor(callback) { changed = callback; }
      observe() {}
      disconnect() { stopped = true; }
    },
    InputEvent: class { constructor(type, options) { Object.assign(this, { type }, options); } },
    setTimeout: () => 1, clearTimeout() {},
  });
  return { editor, events, inserted: () => inserted, focused: () => focused, stopped: () => stopped,
    render() { available = true; changed?.(); } };
}

test('Gemini prompt decodes Unicode, newlines and URL punctuation and waits for the editor', () => {
  const prompt = '你好\nC++ & 100% ? #';
  const view = page({ search: `?prompt=${encodeURIComponent(prompt)}`, available: false });
  assert.equal(view.focused(), false);
  view.render();
  assert.equal(view.inserted(), prompt);
  assert.equal(view.focused(), true);
  assert.equal(view.stopped(), true);
});

test('fallback insertion notifies the editor without sending the prompt', () => {
  const view = page({ native: false });
  assert.equal(view.editor.textContent, 'hello');
  assert.deepEqual(view.events.map(event => [event.type, event.inputType, event.data]), [['input', 'insertText', 'hello']]);
});

test('unrelated pages, frames, missing and blank prompts do nothing', () => {
  for (const options of [{ hostname: 'example.com' }, { hostname: 'gemini.google.com.evil.test' }, { frame: true }, { search: '?q=hello' }, { search: '?prompt=%20' }]) {
    assert.equal(page(options).focused(), false);
  }
});

test('existing user text is preserved', () => {
  const view = page({ text: 'draft' });
  assert.equal(view.editor.textContent, 'draft');
  assert.equal(view.focused(), false);
  assert.equal(view.stopped(), true);
});
