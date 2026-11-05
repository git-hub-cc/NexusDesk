import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/hooks/useVirtualList.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source.replace(/^import .*;\r?\n/m, "").replace("export function", "function"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function mount() {
  const slots = [];
  let cursor = 0;
  let pending = [];
  let dirty = false;
  let resize;
  let frames = new Map();
  let frameId = 0;
  const listeners = new Map();
  const element = { scrollTop: 0, clientHeight: 600,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: type => listeners.delete(type),
  };
  const ref = { current: element };
  const state = { count: 10000, rowHeight: 60, active: true, key: "local", padding: 0 };
  const depsEqual = (a, b) => a && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: initial };
      return [slots[index].value, next => {
        const value = typeof next === "function" ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!depsEqual(slots[index]?.deps, deps)) slots[index] = { value: fn, deps };
      return slots[index].value;
    },
    useLayoutEffect(fn, deps) {
      const index = cursor++;
      if (depsEqual(slots[index]?.deps, deps)) return;
      pending.push(() => {
        slots[index]?.cleanup?.();
        slots[index] = { deps, cleanup: fn() };
      });
    },
    ResizeObserver: class {
      constructor(fn) { resize = fn; }
      observe() {}
      disconnect() { resize = null; }
    },
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const hook = new Function(...Object.keys(hooks), `${compiled}\nreturn useVirtualList;`)(...Object.values(hooks));
  let result;
  const render = () => {
    do {
      dirty = false;
      cursor = 0;
      result = hook(ref, state.count, state.rowHeight, state.active, state.key, state.padding);
      const effects = pending;
      pending = [];
      effects.forEach(fn => fn());
    } while (dirty);
    return result;
  };
  return { state, element, render, listeners, resize: () => resize?.(),
    flush() { const queued = frames; frames = new Map(); queued.forEach(fn => fn()); return render(); },
    frameCount: () => frames.size };
}

test("large lists mount only the viewport and buffer, including deep scrolling and the end", () => {
  const view = mount();
  let window = view.render();
  assert.equal(window.totalHeight, 600000);
  assert.deepEqual([window.start, window.end], [0, 16]);
  view.element.scrollTop = 300000;
  for (let i = 0; i < 20; i++) view.listeners.get("scroll")();
  assert.equal(view.frameCount(), 1, "scroll updates coalesce into one animation frame");
  window = view.flush();
  assert.deepEqual([window.start, window.end], [4994, 5016]);
  window.scrollToIndex(9999);
  window = view.render();
  assert.equal(view.element.scrollTop, 599400);
  assert.deepEqual([window.start, window.end], [9984, 10000]);
  window.scrollToIndex(0);
  assert.equal(view.element.scrollTop, 0);
});

test("resize, hidden pages, search reset, shrinking and empty lists stay bounded", () => {
  const view = mount();
  view.render();
  view.element.clientHeight = 300;
  view.resize();
  assert.equal(view.flush().end, 11);
  view.state.active = false;
  view.element.clientHeight = 0;
  view.render();
  assert.equal(view.listeners.size, 0);
  view.element.scrollTop = 300000;
  view.element.clientHeight = 600;
  view.state.active = true;
  assert.equal(view.render().start, 4994);
  view.state.key = "search:new";
  assert.equal(view.render().start, 0);
  assert.equal(view.element.scrollTop, 0);
  view.element.scrollTop = 300000;
  view.listeners.get("scroll")();
  view.flush();
  view.state.count = 3;
  assert.deepEqual([view.render().start, view.render().end], [0, 3]);
  view.state.count = 0;
  assert.equal(view.render().totalHeight, 0);
  assert.equal(view.render().end, 0);
});

test("video keyboard scrolling accounts for list padding and row height", () => {
  const view = mount();
  Object.assign(view.state, { rowHeight: 58, padding: 8 });
  const window = view.render();
  window.scrollToIndex(100);
  assert.equal(view.element.scrollTop, 101 * 58 + 16 - 600);
  assert.ok(view.render().start <= 100 && view.render().end > 100);
  window.scrollToIndex(5);
  assert.equal(view.element.scrollTop, 5 * 58);
  window.scrollToIndex(-1);
  assert.equal(view.element.scrollTop, 5 * 58);
});
