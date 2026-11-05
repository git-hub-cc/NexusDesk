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
  useLayoutStore: { setState: () => {} }, showError: () => {},
  gitApi: { status: async () => { throw new Error("No repository"); } },
  create, debounce, persist: creator => creator, globalJsonStorage: undefined,
  fsApi: { readDirectory: async () => [], initProjectDb: async () => {}, syncProjectIndex: async () => {}, touchFile: async path => touched.push(path), writeFile: async path => written.push(path) },
};
const source = readFileSync(new URL("../src/store/workspaceStore.ts", import.meta.url), "utf8").replace(/^import .*;$/gm, "");
const compiled = ts.transpileModule("const { create, debounce, persist, fsApi, isSnapshot, isRemotePath, useTerminalStore, useLayoutStore, showError, gitApi, globalJsonStorage } = globalThis.__browserTest;\n" + source,
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
