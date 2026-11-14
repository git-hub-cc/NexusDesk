import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';


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
