import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { create } from "zustand";

function load(path, globals) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8").replace(/^import .*;$/gm, "");
  const context = { exports: {}, ...globals };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.exports;
}

function harness(disk = new Map(), isSnapshot = false) {
  let nextTimer = 0;
  const timers = new Map();
  const writes = [];
  const ui = load("../src/lib/uiPersistence.ts", {
    isSnapshot, setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    settingsStorage: {
      getItem: key => disk.get(key) ?? null,
      setItem: (key, value) => { writes.push([key, value]); disk.set(key, value); },
    },
  });
  const layout = load("../src/store/layoutStore.ts", { create, readUI: ui.readUI, writeUI: ui.writeUI });
  return { ...ui, ...layout, timers, writes, disk };
}

test("UI writes debounce, have a maximum delay, and flush the latest value on close", () => {
  const env = harness();
  env.writeUI("C:\\Project\\", "editor:left:a", { top: 100 });
  env.writeUI("c:/project", "editor:left:a", { top: 200 });
  assert.equal(env.writes.length, 0);
  assert.equal(env.readUI("C:/PROJECT", "editor:left:a").top, 200);
  assert.equal(env.timers.size, 2);
  [...env.timers.values()].find(timer => timer.delay === 2000).callback();
  assert.equal(env.writes.length, 1);
  assert.equal(JSON.parse(env.writes[0][1]).top, 200);
  env.writeUI("c:/project", "preview:right:a", { top: 800 });
  env.flushUIState();
  assert.equal(env.writes.length, 2);
  assert.equal(env.timers.size, 0);
});

test("layout panels and all split ratios survive restart and stay isolated per project", () => {
  const env = harness();
  env.restoreProjectLayout("A");
  env.useLayoutStore.getState().toggleLeftSidebar();
  env.useLayoutStore.getState().openBottomPanel("terminal");
  env.useLayoutStore.getState().toggleRightSidebar();
  env.useLayoutStore.getState().setLeftSidebarWidth(26);
  env.useLayoutStore.getState().setRightSidebarWidth(22);
  env.useLayoutStore.getState().setBottomPanelHeight(34);
  env.useLayoutStore.getState().setEditorSplitRatio(38);
  env.useLayoutStore.getState().setMarkdownSplitRatio(64);
  env.useLayoutStore.getState().setGitDiffSplitRatio(43);
  env.restoreProjectLayout("B");
  assert.equal(env.useLayoutStore.getState().bottomPanelVisible, false);
  env.useLayoutStore.getState().setMarkdownSplitRatio(30);
  env.flushUIState();
  const restarted = harness(env.disk);
  assert.equal(restarted.restoreProjectLayout("A"), true);
  const state = restarted.useLayoutStore.getState();
  assert.equal(state.leftSidebarVisible, true);
  assert.equal(state.rightSidebarVisible, true);
  assert.equal(state.bottomPanelVisible, true);
  assert.equal(state.bottomPanelTab, "terminal");
  for (const [key, value] of Object.entries({ leftSidebarWidth: 26, rightSidebarWidth: 22, bottomPanelHeight: 34,
    editorSplitRatio: 38, markdownSplitRatio: 64, gitDiffSplitRatio: 43 })) assert.equal(state[key], value);
  assert.equal(typeof state.toggleLeftSidebar, "function");
  restarted.restoreProjectLayout("B");
  assert.equal(restarted.useLayoutStore.getState().markdownSplitRatio, 30);
});

test("snapshot viewers cannot overwrite UI state and corrupt records use defaults", () => {
  const env = harness(new Map(), true);
  env.writeUI("A", "layout", { leftSidebarVisible: true });
  env.flushUIState();
  assert.equal(env.writes.length, 0);
  const normal = harness();
  normal.writeUI("A", "layout", { leftSidebarWidth: -4, bottomPanelTab: "invalid", markdownSplitRatio: 60, toggleLeftSidebar: false });
  normal.restoreProjectLayout("A");
  const state = normal.useLayoutStore.getState();
  assert.equal(state.leftSidebarWidth, 20);
  assert.equal(state.bottomPanelTab, "git");
  assert.equal(state.markdownSplitRatio, 60);
  assert.equal(typeof state.toggleLeftSidebar, "function");
});
