import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync('src/components/editor/BrowserEditor.tsx', 'utf8');
const start = source.indexOf('    let disposed = false;');
const end = source.indexOf('  }, [tab.id', start);
const compiled = ts.transpileModule(`(() => {${source.slice(start, end)}})()`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const loaded of [false, true]) {
  test(`closing a tab during ${loaded ? 'history synchronization' : 'creation'} cannot install late observers`, async () => {
    let finish;
    const paused = new Promise(resolve => { finish = resolve; });
    const calls = [], ready = [], errors = [];
    const retainedViews = { current: [] };
    const context = {
      setReady: value => ready.push(value), pendingView: {}, retainedViews,
      retainedIndex: {}, labelRef: {}, activeRef: { current: true },
      initialUrl: 'https://example.com', setNativeHistory: () => {}, refreshNativeHistory: { current: () => {} },
      performance: { now: () => 0 }, browserDiagnosticUrl: value => value,
      tab: { id: 'tab', browser: { root: 'project', url: 'https://example.com' } },
      reserveBrowser: () => ({ label: 'main-browser-test', warm: loaded, loaded }),
      getCurrentWindow: () => ({ listen: async () => () => {}, onFocusChanged: async () => () => {} }),
      host: { current: { getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 600 }) } },
      browserVisibility: () => ({ visible: true }),
      invoke: (command, args) => {
        calls.push({ command, ...args });
        return command === 'create_browser' || args.action === 'sync' ? paused : Promise.resolve();
      },
      switching: {}, setError: value => errors.push(value),
      ResizeObserver: class { constructor() { assert.fail('observer installed after disposal'); } },
    };
    const cleanup = vm.runInNewContext(compiled, context);
    await new Promise(setImmediate);
    assert.equal(calls.length, 1);
    retainedViews.current = []; // Component unmount closes its retained native views first.
    cleanup();
    finish();
    await new Promise(setImmediate);
    assert.equal(ready.includes(true), false);
    assert.equal(calls.some(call => call.command === 'browser_layout'), false);
    assert.deepEqual(errors, []);
  });
}
