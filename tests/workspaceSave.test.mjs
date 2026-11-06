import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { create } from "zustand";
import debounce from "lodash/debounce.js";
import loadRemote from "./helpers/loadRemote.cjs";

// Exercise the real store with only its filesystem boundary replaced.
const writes = [];
let write = async (path, content) => { writes.push([path, content]); };
const closedConnections = [];
const removedSessions = [];
const layoutUpdates = [];
let sessions = [];
globalThis.__saveTest = { fileOperationHistory: { selectProject() {}, clear() {}, record() {} }, create, debounce, ...loadRemote(), tauriInvoke: async (command, args) => {
  if (command === 'reconnect_remote') return { trusted: true };
  closedConnections.push([command, args]);
},
  restoreProjectLayout: () => true,
  useLayoutStore: { setState(update) { layoutUpdates.push(update); } }, showError: error => { throw new Error(error); },
  useTerminalStore: { getState: () => ({ sessions, removeSession: id => { removedSessions.push(id); sessions = sessions.filter(session => session.id !== id); } }) },
  persist: (creator, options) => { globalThis.__saveTest.persistOptions = options; return creator; }, fsApi: {
  writeFile: (...args) => write(...args), getLogicalTree: async () => [{ id: "updated" }],
  readDirectory: async path => [{ id: `${path}/child.txt`, name: 'child.txt' }],
} };
const source = readFileSync(new URL("../src/store/workspaceStore.ts", import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "");
const compiled = ts.transpileModule("const isSnapshot = false; const globalJsonStorage = undefined; const settingsStorage = { getItem: () => null }; const { fileOperationHistory, create, debounce, fsApi, persist, isRemotePath, remotePath, tauriInvoke, useTerminalStore, useLayoutStore, restoreProjectLayout, showError } = globalThis.__saveTest;\n" + source,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { useWorkspaceStore: store, flushPendingWrites, retryFileSave, queueEditorContent } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const edit = content => store.getState().updateTabContent("a", content, "left");
const current = () => store.getState().leftTabs[0];
store.setState({ leftTabs: [{ id: "a", path: "a.md", title: "a", content: "initial" }], rightTabs: [{ id: "a", path: "a.md", title: "a", content: "initial" }] });

test("closing a project flushes edits, preserves its session and clears the workspace", async () => {
  store.setState({ rootPath: "close-project", pinnedTabsRestored: true, recentProjects: ["close-project"],
    leftTabs: [{ id: "close", path: "close.md", title: "close", content: "initial", isPinned: true }],
    rightTabs: [], activeLeftTabId: "close", searchScopePath: "close-project/sub", partitionSearchPaths: ["sub"] });
  sessions = [{ id: "close-terminal" }];
  queueEditorContent("close", { toString: () => "saved before closing" }, "left");
  await store.getState().closeProject();
  assert.deepEqual(layoutUpdates.pop(), { leftSidebarVisible: false, rightSidebarVisible: false, bottomPanelVisible: false });
  assert.deepEqual(writes.pop(), ["close.md", "saved before closing"]);
  const state = store.getState();
  assert.equal(state.rootPath, null);
  assert.deepEqual(state.leftTabs, []);
  assert.deepEqual(state.rightTabs, []);
  assert.deepEqual(state.fileTreeData, []);
  assert.equal(state.searchScopePath, null);
  assert.equal(state.partitionSearchPaths, null);
  assert.equal(sessions.length, 0);
  assert.deepEqual(removedSessions.splice(0), ["close-terminal"]);
  assert.equal(state.projectSessions["close-project"].activeLeft, "close");
  assert.equal(state.projectPinnedTabs["close-project"].left[0].id, "close");
  assert.deepEqual(state.recentProjects, ["close-project"]);
  await state.fetchLogicalTree();
  assert.deepEqual(store.getState().logicalTreeData, []);
  store.setState({ leftTabs: [{ id: "a", path: "a.md", title: "a", content: "initial" }],
    rightTabs: [{ id: "a", path: "a.md", title: "a", content: "initial" }] });
});

test("tree expansion persists separately for each project and tree mode", () => {
  store.setState({ rootPath: "C:\\project-a" });
  const toggle = store.getState().setTreeNodeOpen;
  toggle("C:\\project-a", "physical", "folder", true);
  toggle("C:\\project-a", "physical", "folder/nested", true);
  toggle("C:\\project-a", "logical", "category:folder", true);
  toggle("C:\\project-a", "physical", "folder", false);
  store.setState({ rootPath: "project-b" });
  toggle("project-b", "physical", "other", true);
  toggle("C:\\project-a", "physical", "stale", true);
  const saved = JSON.parse(JSON.stringify(globalThis.__saveTest.persistOptions.partialize(store.getState())));
  assert.deepEqual(saved.projectTreeOpenState, {
    "C:/project-a": { physical: { "folder/nested": true }, logical: { "category:folder": true } },
    "project-b": { physical: { other: true } },
  });
  store.setState({ rootPath: null });
});

test("pinned tabs reopen with current file content and their original panes", async () => {
  const api = globalThis.__saveTest.fsApi;
  api.readFile = async path => `current:${path}`;
  const tab = path => ({ id: path, path, title: path, isPinned: true });
  store.setState({ leftTabs: [], rightTabs: [], activeLeftTabId: null, activeRightTabId: null,
    rootPath: "sftp://server-1/project-a", pinnedTabsRestored: false,
    projectPinnedTabs: { "sftp://server-1/project-a": { left: [tab("left.md")], right: [tab("right.md")] } } });
  await store.getState().restorePinnedTabs();
  assert.equal(store.getState().leftTabs[0].content, "current:left.md");
  assert.equal(store.getState().rightTabs[0].content, "current:right.md");
  assert.equal(store.getState().leftTabs[0].isPinned, true);
  assert.equal(store.getState().rightTabs[0].isPinned, true);
  assert.equal(store.getState().isSplitMode, true);
  store.getState().toggleTabPin("left.md", "left");
  await store.getState().setProject("sftp://server-1/project-b");
  assert.deepEqual(store.getState().leftTabs, []);
  assert.deepEqual(store.getState().rightTabs, []);
  await store.getState().setProject("sftp://server-1/project-a");
  assert.deepEqual([...store.getState().leftTabs, ...store.getState().rightTabs].map(tab => tab.path),
    ["left.md", "right.md"], "ordinary and pinned tabs both restore with the project");
  assert.equal(store.getState().leftTabs[0].isPinned, false);
  assert.equal(store.getState().rightTabs[0].isPinned, true);
  store.setState({ rootPath: null, leftTabs: [], rightTabs: [], pinnedTabsRestored: false });
  await store.getState().restorePinnedTabs();
  assert.deepEqual(store.getState().rightTabs, [], "no project means no restoration");
  store.setState({ leftTabs: [{ id: "a", path: "a.md", title: "a", content: "initial" }],
    rightTabs: [{ id: "a", path: "a.md", title: "a", content: "initial" }] });
});

test("session restart restores ordinary tabs, order, active panes and current disk contents", async () => {
  const tab = id => ({ id, path: `${id}.md`, title: id, content: "stale content", markdownMode: "split" });
  store.setState({ rootPath: "restart-project", pinnedTabsRestored: true,
    leftTabs: [tab("first"), tab("active")], rightTabs: [{ ...tab("right"), isPinned: true }],
    activeLeftTabId: "active", activeRightTabId: "right", focusedPane: "right", isSplitMode: true, sidebarMode: "logical" });
  const saved = JSON.parse(JSON.stringify(globalThis.__saveTest.persistOptions.partialize(store.getState())));
  assert.equal(saved.projectSessions["restart-project"].left[0].content, undefined);
  store.setState({ ...saved, leftTabs: [], rightTabs: [], pinnedTabsRestored: false,
    activeLeftTabId: null, activeRightTabId: null, focusedPane: "left", isSplitMode: false, sidebarMode: "physical" });
  await store.getState().restorePinnedTabs();
  assert.deepEqual(store.getState().leftTabs.map(tab => tab.id), ["first", "active"]);
  assert.equal(store.getState().leftTabs[0].content, "current:first.md");
  assert.equal(store.getState().leftTabs[0].markdownMode, "split");
  assert.equal(store.getState().activeLeftTabId, "active");
  assert.equal(store.getState().activeRightTabId, "right");
  assert.equal(store.getState().focusedPane, "right");
  assert.equal(store.getState().isSplitMode, true);
  assert.equal(store.getState().sidebarMode, "logical");
  store.setState({ rootPath: null, pinnedTabsRestored: false,
    leftTabs: [{ id: "a", path: "a.md", title: "a", content: "initial" }],
    rightTabs: [{ id: "a", path: "a.md", title: "a", content: "initial" }] });
});

test("autosave coalesces edits, serializes writes, preserves dirty state and retries errors", async () => {
  store.setState({ rootPath: "autosave-project" });
  edit("one"); edit("two"); edit("three");
  assert.equal(writes.length, 0);
  await new Promise(resolve => setTimeout(resolve, 550));
  await flushPendingWrites();
  assert.deepEqual(writes, [["a.md", "three"]]);
  assert.equal(current().isDirty, false);
  assert.deepEqual(store.getState().logicalTreeData, [{ id: "updated" }]);
  edit("temporary"); edit("three");
  await flushPendingWrites();
  assert.equal(writes.length, 1, "returning to saved content avoids I/O");
  let release;
  write = async (path, content) => { writes.push([path, content]); await new Promise(resolve => { release = resolve; }); };
  edit("older");
  const flushing = flushPendingWrites();
  await new Promise(resolve => setTimeout(resolve, 0));
  edit("newer");
  release();
  await assert.rejects(flushing, /unsaved/);
  assert.equal(current().isDirty, true);
  write = async (path, content) => { writes.push([path, content]); };
  await flushPendingWrites();
  assert.equal(current().isDirty, false);
  assert.equal(store.getState().rightTabs[0].content, "newer");
  write = async () => { throw new Error("disk full"); };
  edit("recoverable");
  const originalError = console.error;
  console.error = () => {};
  try { await assert.rejects(flushPendingWrites()); } finally { console.error = originalError; }
  assert.match(current().saveError, /disk full/);
  assert.equal(current().isDirty, true);
  write = async (path, content) => { writes.push([path, content]); };
  retryFileSave("a.md");
  await flushPendingWrites();
  assert.equal(current().saveError, undefined);
  assert.equal(current().isDirty, false);
});


test("editor changes defer serialization and store updates, and flush before close or save", async () => {
  store.setState({ leftTabs: [{ id: "b", path: "b.md", title: "b", content: "initial" }], rightTabs: [], activeLeftTabId: "b" });
  let serialized = 0;
  let updates = 0;
  const unsubscribe = store.subscribe(() => updates++);
  const doc = content => ({ toString() { serialized++; return content; } });
  queueEditorContent("b", doc("older"), "left");
  queueEditorContent("b", doc("latest"), "left");
  assert.equal(serialized, 0);
  assert.equal(updates, 0);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(serialized, 1);
  assert.equal(store.getState().leftTabs[0].content, "latest");
  queueEditorContent("b", doc("save immediately"), "left");
  await flushPendingWrites();
  assert.deepEqual(writes.at(-1), ["b.md", "save immediately"]);
  queueEditorContent("b", doc("close immediately"), "left");
  store.getState().closeTab("b", "left");
  await flushPendingWrites();
  assert.deepEqual(writes.at(-1), ["b.md", "close immediately"]);
  assert.equal(store.getState().leftTabs.length, 0);
  unsubscribe();
});


test("same-file edits in separate panes are both flushed", async () => {
  const tab = { id: "shared", path: "shared.md", title: "shared", content: "initial" };
  store.setState({ leftTabs: [{ ...tab }], rightTabs: [{ ...tab }] });
  const serialized = [];
  const doc = content => ({ toString() { serialized.push(content); return content; } });
  queueEditorContent("shared", doc("left older"), "left");
  queueEditorContent("shared", doc("left latest"), "left");
  queueEditorContent("shared", doc("right latest"), "right");
  assert.deepEqual(serialized, []);
  await flushPendingWrites();
  assert.deepEqual(serialized, ["left latest", "right latest"]);
  assert.deepEqual(writes.at(-1), ["shared.md", "right latest"]);
});

test("remote project reuses tree loading and autosave, then disconnects only remote tabs and shells", async () => {
  assert.equal(await store.getState().setProject("sftp://server-1/home"), true);
  assert.equal(store.getState().fileTreeData[0].id, "sftp://server-1/home/child.txt");
  assert.ok(store.getState().recentProjects.includes("sftp://server-1/home"));
  sessions = [{ id: 'remote-shell', remoteId: 'server-1' }, { id: 'local-shell' }];
  const path = "sftp://server-1/home/child.txt";
  store.setState({ leftTabs: [{ id: path, path, title: "child.txt", content: "initial" }, { id: "local", path: "C:/local.txt", title: "local", content: "local" }], rightTabs: [] });
  store.getState().updateTabContent(path, "remote edit", "left");
  await flushPendingWrites();
  assert.deepEqual(writes.at(-1), [path, "remote edit"]);
  await store.getState().disconnectRemote();
  assert.equal(store.getState().rootPath, null);
  assert.deepEqual(store.getState().leftTabs.map(tab => tab.id), ["local"]);
  assert.deepEqual(removedSessions, ["remote-shell"]);
  assert.deepEqual(closedConnections, [["close_remote", { id: "server-1" }]]);
});

test("SFTP deletion refreshes after an older listing and supports the server root", async () => {
  const api = globalThis.__saveTest.fsApi;
  const originalRead = api.readDirectory;
  try {
    for (const root of ["sftp://server-1/home", "sftp://server-1/"]) {
      const path = `${root.replace(/\/$/, '')}/removed.txt`;
      const entry = { id: path, name: 'removed.txt' };
      store.setState({ rootPath: root, fileTreeData: [entry], leftTabs: [], rightTabs: [] });
      let release;
      let reads = 0;
      let deleted = false;
      api.readDirectory = async directory => {
        assert.equal(directory, root);
        if (++reads === 1) return new Promise(resolve => { release = () => resolve([entry]); });
        assert.ok(deleted);
        return [];
      };
      api.deleteEntry = async target => { assert.equal(target, path); deleted = true; };
      const olderListing = store.getState().loadDirectory(root, false, true);
      const deletion = store.getState().deletePhysicalEntry(path);
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(deleted);
      release();
      await Promise.all([olderListing, deletion]);
      assert.equal(reads, 2);
      assert.deepEqual(store.getState().fileTreeData, []);
    }
  } finally {
    api.readDirectory = originalRead;
    delete api.deleteEntry;
  }
});
