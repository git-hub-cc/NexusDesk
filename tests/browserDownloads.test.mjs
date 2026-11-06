import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/editor/BrowserDownloads.tsx', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('export function downloadSize'), source.indexOf('export function BrowserDownloads'));
const compiled = ts.transpileModule(helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { downloadSize, mergeDownload, isFailedExtensionDownload } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('only failed extension files offer extension installation recovery', () => {
  assert.equal(isFailedExtensionDownload({ state: 'failed', name: 'extension.CRX', path: '' }), true);
  assert.equal(isFailedExtensionDownload({ state: 'failed', name: 'download', path: 'C:\\Downloads\\extension.crx' }), true);
  assert.equal(isFailedExtensionDownload({ state: 'failed', name: 'file.zip', path: '' }), false);
  assert.equal(isFailedExtensionDownload({ state: 'completed', name: 'extension.crx', path: '' }), false);
});

test('download sizes stay readable for unknown, small and large files', () => {
  assert.equal(downloadSize(0), '0 B');
  assert.equal(downloadSize(512), '512 B');
  assert.equal(downloadSize(1024), '1.0 KB');
  assert.equal(downloadSize(1024 ** 3 * 1.5), '1.5 GB');
});

test('a late snapshot cannot overwrite newer progress or a completed download', () => {
  const active = { id: 'one', revision: 2, state: 'downloading', received: 50 };
  let items = mergeDownload([], active);
  assert.equal(mergeDownload(items, { ...active, revision: 1, received: 0 }), items);
  items = mergeDownload(items, { ...active, revision: 3, state: 'completed', received: 100 });
  assert.equal(mergeDownload(items, active), items);
  items = mergeDownload(items, { id: 'two', revision: 1 });
  assert.equal(items.length, 2);
  assert.equal(items.find(item => item.id === 'one').state, 'completed');
});

test('a one MB download closes after snapshot reconciliation when its completion event is lost', async () => {
  const slots = [], effects = [], timers = new Map(), intervals = new Map();
  let cursor = 0, nextTimer = 0, listener;
  let snapshot = [{ id: 'fast', label: 'browser', name: 'small.bin', state: 'downloading', received: 0, total: 1048576, revision: 1 }];
  const depsChanged = (before, after) => !before || after.some((value, index) => value !== before[index]);
  globalThis.__downloadHooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(effect, deps) {
      const index = cursor++;
      if (depsChanged(slots[index]?.deps, deps)) effects.push(() => {
        slots[index]?.cleanup?.();
        slots[index] = { deps, cleanup: effect() };
      });
    },
    invoke: async () => snapshot,
    getCurrentWindow: () => ({ listen: async (_, callback) => { listener = callback; return () => {}; } }),
    revealItemInDir() {}, Download() {}, FolderOpen() {}, X() {},
    h: (type, props, ...children) => ({ type, props, children }),
    window: {
      setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
      setInterval(callback) { const id = ++nextTimer; intervals.set(id, callback); return id; },
      clearInterval(id) { intervals.delete(id); },
    },
  };
  const bindings = `const { ${Object.keys(globalThis.__downloadHooks).join(', ')} } = globalThis.__downloadHooks;\n`;
  const componentCode = ts.transpileModule(bindings + source.replace(/^import .*;\r?$/gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'h' },
  }).outputText;
  const { BrowserDownloads } = await import(`data:text/javascript;base64,${Buffer.from(componentCode).toString('base64')}`);
  const render = () => {
    cursor = 0;
    const result = BrowserDownloads({ labels: ['browser'] });
    while (effects.length) effects.shift()();
    return result;
  };
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  render(); await settle();
  assert.ok(render());
  assert.equal(typeof listener, 'function');
  // No StateChanged/browser-download event is delivered to the component.
  snapshot = [{ ...snapshot[0], state: 'completed', received: 1048576, revision: 2 }];
  for (const poll of intervals.values()) poll();
  await settle(); render();
  assert.equal(timers.size, 1);
  // More polling must not keep restarting the dismissal timer.
  for (const poll of intervals.values()) poll();
  await settle(); render();
  assert.equal(timers.size, 1);
  for (const complete of [...timers.values()]) complete();
  assert.equal(render(), null);
  for (const slot of slots) slot?.cleanup?.();
  assert.equal(intervals.size, 0);
  delete globalThis.__downloadHooks;
});
