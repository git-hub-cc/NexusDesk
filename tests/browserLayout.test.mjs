import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/editor/BrowserEditor.tsx', import.meta.url), 'utf8');
const start = source.indexOf('      let previousX');
const end = source.indexOf('      const resizeObserver', start);
const compiled = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const visibilityCompiled = ts.transpileModule(
  readFileSync(new URL('../src/lib/browserVisibility.ts', import.meta.url), 'utf8').replace(/export /g, ''),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const musicEditorSource = readFileSync(new URL('../src/components/music/MusicEditor.tsx', import.meta.url), 'utf8');
const gitPanelSource = readFileSync(new URL('../src/components/git/GitPanel.tsx', import.meta.url), 'utf8');

function harness() {
  let rect = { x: 10, y: 20, width: 800, height: 600 }, reads = 0;
  const frames = [], calls = [], completions = [];
  const timers = new Map();
  let timerId = 0;
  const context = {
    disposed: false, fullscreen: false, label: 'browser-test',
    host: { current: { getBoundingClientRect() { reads++; return rect; } } },
    activeRef: { current: true }, syncLayout: {},
    document: { hidden: false, querySelectorAll: () => [] },
    getComputedStyle: element => element.style,
    window: { innerWidth: 1920, innerHeight: 1080,
      setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
      clearTimeout: id => timers.delete(id),
    },
    requestAnimationFrame: callback => frames.push(callback),
    cancelAnimationFrame: () => {},
    setError: error => assert.fail(error),
    invoke(command, values) {
      calls.push({ command, ...values });
      return new Promise(resolve => completions.push(resolve));
    },
  };
  const sandbox = vm.createContext(context);
  context.browserVisibility = vm.runInContext(`(() => { ${visibilityCompiled}; return browserVisibility; })()`, sandbox);
  vm.runInContext(compiled, sandbox);
  return { context, frames, calls, get reads() { return reads; },
    resize(width) { rect = { ...rect, width }; },
    schedule() { vm.runInContext('scheduleLayout()', sandbox); },
    restore() { context.syncLayout.current(); },
    fallback() { const queued = [...timers.values()]; timers.clear(); queued.forEach(callback => callback()); },
    frame() { const queued = frames.splice(0); queued.forEach(callback => callback()); },
    async complete() { completions.shift()(); await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('layout bursts measure once per frame and unchanged bounds skip IPC', async () => {
  const h = harness();
  for (let i = 0; i < 50; i++) h.schedule();
  assert.equal(h.reads, 0);
  assert.equal(h.frames.length, 1);
  h.frame();
  assert.equal(h.reads, 1);
  assert.equal(h.calls.length, 1);
  await h.complete();
  h.schedule(); h.frame();
  assert.equal(h.calls.length, 1);
  h.context.activeRef.current = false;
  h.schedule(); h.frame();
  assert.equal(h.calls.at(-1).visible, false);
});

test('a hidden HTML document still shows an active native browser without animation frames', async () => {
  const h = harness();
  h.context.document.hidden = true;
  h.schedule(); h.fallback();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].visible, true);
  assert.equal(h.calls[0].reason, 'visible');
  assert.equal(h.calls[0].documentHidden, true);
  await h.complete();
});

test('only a visible overlay hides the browser and restoration forces a fresh show', async () => {
  const h = harness();
  const overlay = { style: { visibility: 'visible', opacity: '1' }, parentElement: null,
    getClientRects: () => [], getAttribute: () => 'dialog' };
  h.context.document.querySelectorAll = () => [overlay];
  h.schedule(); h.frame();
  assert.equal(h.calls.at(-1).visible, true);
  await h.complete();
  overlay.getClientRects = () => [{}];
  h.schedule(); h.frame();
  assert.equal(h.calls.at(-1).reason, 'overlay:dialog');
  assert.equal(h.calls.at(-1).visible, false);
  await h.complete();
  overlay.style.visibility = 'hidden';
  h.schedule(); h.frame();
  assert.equal(h.calls.at(-1).visible, true);
  await h.complete();
  const count = h.calls.length;
  h.restore(); h.frame();
  assert.equal(h.calls.length, count + 1);
  assert.equal(h.calls.at(-1).visible, true);
  await h.complete();
});

test('panel context menus do not hide the native browser', async () => {
  assert.equal((musicEditorSource.match(/ContextMenu\.Content data-panel-menu/g) ?? []).length, 2);
  assert.match(gitPanelSource, /role="menu" data-panel-menu aria-label="提交操作"/);
  const h = harness();
  const panelMenu = { style: { visibility: 'visible', opacity: '1' }, parentElement: null,
    getClientRects: () => [{}], getAttribute: name => name === 'role' ? 'menu' : 'true' };
  h.context.document.querySelectorAll = selector => {
    return selector.includes(':not([data-panel-menu])') ? [] : [panelMenu];
  };
  h.schedule(); h.frame();
  assert.equal(h.calls.at(-1).visible, true);
  assert.equal(h.calls.at(-1).reason, 'visible');
  await h.complete();
});

test('transparent and hidden overlay ancestors do not block the native browser', async () => {
  const h = harness();
  const parent = { style: { opacity: '0' }, parentElement: null };
  const overlay = { style: { visibility: 'visible', opacity: '1' }, parentElement: parent,
    getClientRects: () => [{}], getAttribute: () => 'menu' };
  h.context.document.querySelectorAll = () => [overlay];
  h.schedule(); h.frame();
  assert.equal(h.calls.at(-1).visible, true);
  await h.complete();
  parent.style.opacity = '1'; parent.hidden = true;
  h.schedule(); h.frame();
  assert.equal(h.calls.length, 1);
  parent.hidden = false;
  h.schedule(); h.frame();
  assert.equal(h.calls.at(-1).visible, false);
  await h.complete();
});

test('in-flight layout coalesces changes and submits latest bounds on a later frame', async () => {
  const h = harness();
  h.schedule(); h.frame();
  h.resize(900); h.schedule(); h.frame();
  h.resize(1000); h.schedule(); h.frame();
  assert.equal(h.calls.length, 1);
  assert.equal(h.reads, 1);
  await h.complete();
  assert.equal(h.frames.length, 1);
  h.frame();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].width, 1000);
  h.context.disposed = true;
  await h.complete();
  h.schedule();
  assert.equal(h.frames.length, 0);
});
