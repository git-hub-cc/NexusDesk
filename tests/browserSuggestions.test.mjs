import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function editor(candidate) {
  const calls = [];
  const changes = [];
  const effects = [];
  const listeners = new Map();
  let stateIndex = 0;
  const source = readFileSync(new URL('../src/components/editor/BrowserEditor.tsx', import.meta.url), 'utf8')
    .replace(/^import .*;\r?$/gm, '')
    .replace('import.meta.env.BASE_URL', '"/"')
    + '\nexport { NativeBrowserEditor };';
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const context = {
    exports: {},
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    useEffect(effect) { effects.push(effect); }, useId: () => 'suggestions', useRef: value => ({ current: value }),
    document: {
      addEventListener(name, listener, capture) { listeners.set(name, { listener, capture }); },
      removeEventListener(name, listener, capture) {
        if (listeners.get(name)?.listener === listener && listeners.get(name)?.capture === capture) listeners.delete(name);
      },
    },
    useState(value) {
      const index = stateIndex++;
      return [index === 2 || index === 3 ? true : value, next => changes.push({ index, value: next })];
    },
    useBrowserHistoryStore: select => select({ entries: [] }), searchHistory: () => [],
    BrowserPasswords: 'passwords', BrowserSuggestionPopup: 'popup', BrowserDownloads: 'downloads',
    ArrowLeft: 'back', ArrowRight: 'forward', RotateCw: 'reload', House: 'home', Globe: 'globe',
    invoke(command, args) {
      calls.push({ command, args });
      return Promise.resolve();
    },
    takeSpeculativeBrowser: () => candidate,
    URL,
  };
  vm.runInNewContext(compiled, context);
  const tree = context.exports.NativeBrowserEditor({ tab: { id: 'browser:current', browser: { url: 'https://example.com/', root: '/' } }, active: true });
  function find(node, type) {
    if (!node || typeof node !== 'object') return;
    if (node.type === type) return node;
    return node.children?.flat(Infinity).map(child => find(child, type)).find(Boolean);
  }
  const input = find(tree, 'input');
  const anchor = find(tree, 'form').children.flat(Infinity).find(child => child?.props?.ref);
  return { input, anchor, effects, listeners, popup: find(tree, 'popup'), calls, changes };
}

test('outside presses close suggestions before resize handles suppress focus and propagation', () => {
  const view = editor();
  const inside = {};
  view.anchor.props.ref.current = { contains: target => target === inside };
  const cleanup = view.effects.find(effect => effect.toString().includes("dismissOutside"))();
  const handler = view.listeners.get('pointerdown');
  assert.equal(handler.capture, true);
  handler.listener({ target: inside });
  assert.equal(view.changes.length, 0, 'address presses keep suggestions open');
  handler.listener({ target: {}, defaultPrevented: true });
  assert.ok(view.changes.some(change => change.index === 3 && change.value === false));
  assert.ok(view.changes.some(change => change.index === 5 && change.value === -1));
  assert.equal(view.calls.length, 0, 'pressing a divider must never navigate');
  cleanup();
  assert.equal(view.listeners.size, 0);
});

test('native suggestion focus keeps selection listener alive and navigates the current view', async () => {
  const view = editor();
  view.input.props.onBlur({ relatedTarget: null });
  assert.equal(view.changes.length, 0);
  await new Promise(setImmediate);
  assert.equal(view.changes.length, 0, 'blur into popup must not close suggestions');
  view.popup.props.onSelect('https://example.org/selected?q=1');
  assert.equal(view.calls.at(-1).command, 'browser_action');
  assert.equal(view.calls.at(-1).args.action, 'navigate');
  assert.equal(view.calls.at(-1).args.url, 'https://example.org/selected?q=1');
  assert.ok(view.changes.some(change => change.index === 3 && change.value === false));
});

test('focus moving to host controls closes suggestions without pointer IPC', () => {
  const view = editor();
  view.input.props.onBlur({ relatedTarget: {} });
  assert.ok(view.changes.some(change => change.index === 3 && change.value === false));
  assert.equal(view.calls.length, 0);
});

test('Escape restores the current URL and closes suggestions without navigating', () => {
  const view = editor();
  let selected = false;
  let prevented = false;
  view.input.props.onChange({ target: { value: 'unfinished address' } });
  view.input.props.onKeyDown({
    key: 'Escape', nativeEvent: { isComposing: false },
    preventDefault() { prevented = true; },
    currentTarget: { select() { selected = true; } },
  });
  assert.ok(prevented && selected);
  assert.ok(view.changes.some(change => change.index === 0 && change.value === 'https://example.com/'));
  assert.equal(view.changes.filter(change => change.index === 3).at(-1).value, false);
  assert.equal(view.calls.length, 0);
});

test('selecting a speculative URL promotes its view without navigating it twice', () => {
  const view = editor({ label: 'main-browser-candidate', warm: true, loaded: true });
  view.popup.props.onSelect('https://example.org/ready');
  assert.equal(view.calls.filter(call => call.command === 'browser_action' && call.args.action === 'navigate').length, 0);
  assert.ok(view.changes.some(change => change.index === 2 && change.value === false));
  assert.ok(view.changes.some(change => change.index === 6 && typeof change.value === 'function'));
});
