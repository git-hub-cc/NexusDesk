import { pathDeclarations } from "./helpers/loadSource.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { create } from "zustand";
import debounce from "lodash/debounce.js";

const touched = [];
const removed = [];
const terminal = { sessions: [{ id: "old-session" }], removeSession: id => removed.push(id) };
const written = [];
globalThis.__browserTest = {
  isSnapshot: false, isRemotePath: () => false, useTerminalStore: { getState: () => terminal },
  isTauri: () => true,
  tauriInvoke: async () => true,
  restoreProjectLayout: () => null,
  useLayoutStore: { setState: () => {} }, showError: () => {},
  gitApi: { status: async () => { throw new Error("No repository"); } },
  create, debounce, persist: creator => creator, globalJsonStorage: undefined,
  fsApi: { readDirectory: async () => [], readFile: async () => "restored content", initProjectDb: async () => {}, syncProjectIndex: async () => {}, touchFile: async path => touched.push(path), writeFile: async path => written.push(path) },
};
const source = pathDeclarations + readFileSync(new URL("../src/store/workspaceStore.ts", import.meta.url), "utf8").replace(/^import .*;$/gm, "");
const compiled = ts.transpileModule("const { create, debounce, persist, fsApi, isSnapshot, isRemotePath, isTauri, tauriInvoke, restoreProjectLayout, useTerminalStore, useLayoutStore, showError, gitApi, globalJsonStorage } = globalThis.__browserTest;\n" + source,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { useWorkspaceStore: store, flushPendingWrites } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("browser tabs preserve metadata and never enter file history or autosave", async () => {
  store.setState({ rootPath: "C:/project", leftTabs: [], rightTabs: [], focusedPane: "left" });
  const tab = { id: "browser:one", path: "browser:one", title: "网页", browser: { root: "C:/project", url: "https://git-hub-cc.github.io/" } };
  store.getState().openTab(tab);
  store.getState().setActiveTab(tab.id, "left");
  assert.equal(store.getState().leftTabs[0].title, "网页");
  assert.equal(store.getState().leftTabs[0].isExternal, false);
  store.getState().updateTabContent(tab.id, "should not be saved", "left");
  await flushPendingWrites();
  assert.deepEqual(touched, []);
  assert.deepEqual(written, []);
  store.getState().splitRight(tab.id, "left");
  assert.deepEqual(store.getState().rightTabs[0].browser, tab.browser);
  store.getState().closeTab(tab.id, "right");
  assert.equal(store.getState().rightTabs.length, 0);
});

test("background browser tabs open in the source pane without changing active tabs or focus", () => {
  const left = { id: "browser:left", path: "browser:left", title: "Left", browser: { root: "C:/project", url: "https://example.com/left" } };
  const right = { ...left, id: "browser:right", path: "browser:right" };
  const background = { ...left, id: "browser:background", path: "browser:background" };
  store.setState({ rootPath: "C:/project", leftTabs: [left], rightTabs: [right], activeLeftTabId: left.id, activeRightTabId: right.id, focusedPane: "right", isSplitMode: true });
  store.getState().openTab(background, { background: true, pane: "left" });
  assert.equal(store.getState().leftTabs.some(tab => tab.id === background.id), true);
  assert.equal(store.getState().rightTabs.length, 1);
  assert.equal(store.getState().activeLeftTabId, left.id);
  assert.equal(store.getState().activeRightTabId, right.id);
  assert.equal(store.getState().focusedPane, "right");
  store.getState().openTab(background, { background: true, pane: "left" });
  assert.equal(store.getState().leftTabs.filter(tab => tab.id === background.id).length, 1);
  store.getState().openTab(background, { pane: "left" });
  assert.equal(store.getState().activeLeftTabId, background.id);
});


test("switching project removes terminal sessions, reopening the same project preserves them", async () => {
  store.setState({ rootPath: "C:/project", leftTabs: [], rightTabs: [], refreshTreeStatuses: async () => {}, fetchLogicalTree: async () => {} });
  assert.equal(await store.getState().setProject("C:/project"), true);
  assert.deepEqual(removed, []);
  assert.equal(await store.getState().setProject("C:/other"), true);
  assert.deepEqual(removed, ["old-session"]);
});

test("switching project keeps browser tabs mounted while clearing project files", async () => {
  const browser = { id: "browser:startup", path: "browser:startup", title: "Startup page", browser: { root: "C:/project", url: "https://example.com/" } };
  const file = { id: "C:/project/note.md", path: "C:/project/note.md", title: "note.md" };
  store.setState({ rootPath: "C:/project", leftTabs: [file, browser], rightTabs: [], activeLeftTabId: browser.id, isSplitMode: false, focusedPane: "left", refreshTreeStatuses: async () => {}, fetchLogicalTree: async () => {} });

  assert.equal(await store.getState().setProject("C:/other"), true);
  assert.deepEqual(store.getState().leftTabs.map(tab => tab.id), [browser.id]);
  assert.equal(store.getState().activeLeftTabId, browser.id);
  assert.equal(store.getState().leftTabs[0].browser.url, browser.browser.url);
});

test("returning to a project restores files without duplicating a retained browser across panes", async () => {
  const browser = { id: "browser:retained", path: "browser:retained", title: "Browser", browser: { root: "C:/original", url: "https://example.com/" }, isPinned: true };
  const leftFile = { id: "C:/original/left.md", path: "C:/original/left.md", title: "left.md" };
  const rightFile = { id: "C:/original/right.md", path: "C:/original/right.md", title: "right.md" };
  store.setState({ rootPath: "C:/original", leftTabs: [leftFile], rightTabs: [rightFile, browser],
    activeLeftTabId: leftFile.id, activeRightTabId: browser.id, focusedPane: "right", isSplitMode: true,
    pinnedTabsRestored: true, projectSessions: {}, projectPinnedTabs: {},
    refreshTreeStatuses: async () => {}, fetchLogicalTree: async () => {} });

  for (let index = 0; index < 2; index++) {
    assert.equal(await store.getState().setProject("C:/destination"), true);
    const retained = store.getState().leftTabs.find(tab => tab.id === browser.id);
    assert.ok(retained);
    store.getState().leftTabs.find(tab => tab.id === browser.id).browser.url = "https://example.com/latest";
    assert.equal(await store.getState().setProject("C:/original"), true);
    const state = store.getState();
    assert.equal([...state.leftTabs, ...state.rightTabs].filter(tab => tab.id === browser.id).length, 1);
    assert.equal(state.leftTabs.find(tab => tab.id === browser.id).browser, retained.browser);
    assert.equal(state.leftTabs.find(tab => tab.id === browser.id).browser.url, "https://example.com/latest");
    assert.equal(state.leftTabs.find(tab => tab.id === browser.id).isPinned, true);
    assert.ok(state.leftTabs.some(tab => tab.id === leftFile.id));
    assert.ok(state.rightTabs.some(tab => tab.id === rightFile.id));
    assert.equal(state.isSplitMode, true);
  }
});
