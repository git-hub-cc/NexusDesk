import { pathDeclarations } from "./helpers/loadSource.mjs";
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
  textVersion: async content => `version:${content}`,
  readFileSnapshot: async path => ({ content: await globalThis.__saveTest.fsApi.readFile(path), version: "read-version" }),
  inspectFileSnapshot: (...args) => globalThis.__saveTest.fsApi.readFileSnapshot(...args),
  writeFileSnapshot: async (path, content, version) => ({ logicalChanged: await write(path, content, version), version: `version:${content}` }),
  touchFile: async () => {},
  readDirectory: async path => [{ id: `${path}/child.txt`, name: 'child.txt' }],
} };
const source = pathDeclarations + readFileSync(new URL("../src/store/workspaceStore.ts", import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "");
const compiled = ts.transpileModule("const isSnapshot = false; const isTauri = () => false; const window = { dispatchEvent() {} }; const globalJsonStorage = undefined; const settingsStorage = { getItem: () => null }; const { fileOperationHistory, create, debounce, fsApi, persist, isRemotePath, remotePath, tauriInvoke, useTerminalStore, useLayoutStore, restoreProjectLayout, showError } = globalThis.__saveTest;\n" + source,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { useWorkspaceStore: store, flushPendingWrites, retryFileSave, queueEditorContent, refreshOpenFiles, resolveFileConflict, restoreLocalVersion } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const edit = content => store.getState().updateTabContent("a", content, "left");
const current = () => store.getState().leftTabs[0];
store.setState({ leftTabs: [{ id: "a", path: "a.md", title: "a", content: "initial" }], rightTabs: [{ id: "a", path: "a.md", title: "a", content: "initial" }] });

test("store deduplicates Windows aliases and resolves split titles by file identity", () => {
  const path = "C:/project/notes/a.md";
  const alias = String.raw`\\?\C:\project\notes\a.md`;
  const tab = { id: "ordinary", path, title: "a.md", content: "unsaved", isDirty: true };
  store.setState({ rootPath: "C:/project", focusedPane: "left", leftTabs: [tab], rightTabs: [], activeLeftTabId: tab.id });
  store.getState().openTab({ id: alias, path: alias, title: "a.md", content: "disk" });
  assert.equal(store.getState().leftTabs.length, 1);
  assert.equal(store.getState().activeLeftTabId, tab.id);
  assert.equal(store.getState().leftTabs[0].content, "unsaved");
  store.getState().openTab({ id: alias, path: alias, title: "a.md", content: "unsaved" }, { pane: "right" });
  assert.equal(store.getState().rightTabs[0].title, "a.md");
  assert.equal(store.getState().rightTabs[0].isExternal, false);
  store.getState().openTab({ id: "other", path: "C:/project/drafts/a.md", title: "a.md", content: "other" });
  assert.equal(store.getState().rightTabs[0].title, "notes/a.md");
  assert.equal(store.getState().leftTabs.find(tab => tab.id === "ordinary").title, "notes/a.md");
  store.setState({ rootPath: null, leftTabs: [{ id: "a", path: "a.md", title: "a", content: "initial" }], rightTabs: [{ id: "a", path: "a.md", title: "a", content: "initial" }] });
});

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
  assert.deepEqual(store.getState().logicalTreeData, [{ id: "updated" }]);
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
  await store.getState().fetchLogicalTree();
  const logicalTreeBeforeSave = store.getState().logicalTreeData;
  edit("one"); edit("two"); edit("three");
  assert.equal(writes.length, 0);
  await new Promise(resolve => setTimeout(resolve, 550));
  await flushPendingWrites();
  assert.deepEqual(writes, [["a.md", "three"]]);
  assert.equal(current().isDirty, false);
  assert.equal(store.getState().logicalTreeData, logicalTreeBeforeSave, "body edits do not rebuild the logical tree");
  assert.ok(store.getState().indexRevision > 0, "link views still refresh after saves");
  edit("temporary"); edit("three");
  await flushPendingWrites();
  assert.equal(writes.length, 1, "returning to saved content avoids I/O");
  let release;
  write = async (path, content) => { writes.push([path, content]); if (content === "older") await new Promise(resolve => { release = resolve; }); };
  edit("older");
  const flushing = flushPendingWrites();
  await new Promise(resolve => setTimeout(resolve, 0));
  edit("newer");
  release();
  await flushing;
  assert.equal(current().isDirty, false);
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


test("category changes refresh the logical tree after a successful save", async () => {
  const original = write;
  write = async (path, content) => { writes.push([path, content]); return true; };
  try {
    edit("---\ntype: notes\n---\nchanged category");
    await flushPendingWrites();
    assert.deepEqual(store.getState().logicalTreeData, [{ id: "updated" }]);
  } finally { write = original; }
});

test("logical tree requests coalesce and repeat once if data changes during a read", async () => {
  const api = globalThis.__saveTest.fsApi;
  const original = api.getLogicalTree;
  let reads = 0;
  let release;
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  api.getLogicalTree = async () => {
    if (++reads === 1) { started(); await new Promise(resolve => { release = resolve; }); }
    return [{ id: `revision-${reads}` }];
  };
  try {
    const first = store.getState().fetchLogicalTree();
    const burst = store.getState().fetchLogicalTree();
    await reading;
    const newer = store.getState().fetchLogicalTree();
    store.getState().fetchLogicalTree();
    release();
    await Promise.all([first, burst, newer]);
    assert.equal(reads, 2);
    assert.deepEqual(store.getState().logicalTreeData, [{ id: "revision-2" }]);
  } finally { api.getLogicalTree = original; }
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

test("closing the active tab selects its right neighbor before its left neighbor", () => {
  const tab = id => ({ id, path: `${id}.md`, title: id, content: id });
  store.setState({
    leftTabs: [tab("left"), tab("active"), tab("right")],
    rightTabs: [],
    activeLeftTabId: "active",
    activeRightTabId: null,
    isSplitMode: false,
  });

  store.getState().closeTab("active", "left");
  assert.equal(store.getState().activeLeftTabId, "right");

  store.setState({
    leftTabs: [tab("left"), tab("active")],
    activeLeftTabId: "active",
  });
  store.getState().closeTab("active", "left");
  assert.equal(store.getState().activeLeftTabId, "left");
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

test("file tabs reuse Windows aliases without merging case-sensitive remote or POSIX files", () => {
  const api = globalThis.__saveTest.fsApi;
  const originalTouch = api.touchFile;
  api.touchFile = async () => {};
  try {
    for (const [first, second, expected] of [
      ["C:\\notes\\A.md", "c:/notes/a.md", 1],
      ["/notes/A.md", "/notes/a.md", 2],
      ["sftp://one/A.md", "sftp://one/a.md", 2],
    ]) {
      store.setState({ leftTabs: [], rightTabs: [], focusedPane: "left" });
      store.getState().openTab({ id: "first", path: first, title: "A", content: "unsaved", isDirty: true });
      store.getState().openTab({ id: "second", path: second, title: "a", content: "disk" });
      assert.equal(store.getState().leftTabs.length, expected);
      if (expected === 1) {
        assert.equal(store.getState().activeLeftTabId, "first");
        assert.equal(store.getState().leftTabs[0].content, "unsaved");
      }
    }
  } finally { api.touchFile = originalTouch; }
});

test("conflicts pause autosave, preserve further edits and require an explicit resolution", async () => {
  const api = globalThis.__saveTest.fsApi;
  const original = { write: api.writeFileSnapshot, read: api.readFileSnapshot, compare: api.compareText };
  const originalError = console.error;
  let disk = "initial";
  let attempts = 0;
  const tab = { id: "conflict", path: "conflict.md", title: "conflict", content: disk, diskVersion: `version:${disk}` };
  store.setState({ rootPath: "conflict-project", leftTabs: [tab], rightTabs: [], focusedPane: "left" });
  api.readFileSnapshot = async () => ({ content: disk, version: `version:${disk}` });
  api.compareText = async (left, right) => `${left} -> ${right}`;
  api.writeFileSnapshot = async (_path, content, expected) => {
    attempts++;
    if (expected !== `version:${disk}` && disk !== content) throw new Error("FILE_CONFLICT: external edit");
    disk = content;
    return { logicalChanged: false, version: `version:${disk}` };
  };
  console.error = () => {};
  try {
    store.getState().updateTabContent(tab.id, "local edit", "left");
    disk = "external edit";
    await assert.rejects(flushPendingWrites(), /尚未保存/);
    assert.match(current().saveError, /FILE_CONFLICT/);
    assert.equal(disk, "external edit");
    store.getState().updateTabContent(tab.id, "further edit", "left");
    retryFileSave(tab.path);
    await assert.rejects(flushPendingWrites());
    assert.equal(attempts, 1, "typing and retry cannot override a conflict");
    await resolveFileConflict(tab.path, "compare");
    const comparison = store.getState().leftTabs.find(item => item.diff !== undefined);
    assert.equal(comparison.diff, "external edit -> further edit");
    assert.equal(comparison.diffReadOnly, true);
    assert.equal(disk, "external edit");
    await resolveFileConflict(tab.path, "overwrite");
    assert.equal(disk, "further edit");
    const resolved = store.getState().leftTabs.find(item => item.id === tab.id);
    assert.equal(resolved.isDirty, false);
    assert.equal(resolved.saveError, undefined);
  } finally {
    api.writeFileSnapshot = original.write; api.readFileSnapshot = original.read; api.compareText = original.compare;
    console.error = originalError;
  }
});

test("closing tabs preserves the last conflict editor, including batch closes", async () => {
  const api = globalThis.__saveTest.fsApi;
  const original = { write: api.writeFileSnapshot, read: api.readFileSnapshot };
  const originalError = console.error;
  const tab = { id: "close-conflict", path: "close-conflict.md", title: "conflict", content: "initial" };
  const other = { id: "other", path: "other.md", title: "other", content: "other" };
  api.writeFileSnapshot = async () => { throw new Error("FILE_CONFLICT: external edit"); };
  api.readFileSnapshot = async () => ({ content: "external", version: "external-version" });
  console.error = () => {};
  store.setState({ leftTabs: [tab, other], rightTabs: [], isSplitMode: false });
  try {
    store.getState().updateTabContent(tab.id, "local edit", "left");
    await assert.rejects(flushPendingWrites());
    for (const [method, id, tabs] of [
      ["closeTab", tab.id, [tab, other]],
      ["closeOtherTabs", other.id, [tab, other]],
      ["closeLeftTabs", other.id, [tab, other]],
      ["closeRightTabs", other.id, [other, tab]],
    ]) {
      const conflict = store.getState().leftTabs.find(item => item.id === tab.id);
      store.setState({ leftTabs: tabs.map(item => item.id === tab.id ? conflict : item) });
      assert.throws(() => store.getState()[method](id, "left"), /请先处理.*保存冲突/);
      assert.equal(store.getState().leftTabs.find(item => item.id === tab.id).content, "local edit");
    }
    await resolveFileConflict(tab.path, "reload");
    await flushPendingWrites();
    store.getState().closeTab(tab.id, "left");
    assert.ok(!store.getState().leftTabs.some(item => item.id === tab.id));
  } finally {
    api.writeFileSnapshot = original.write; api.readFileSnapshot = original.read;
    console.error = originalError;
  }
});

test("a conflict returned after closing the last tab restores an actionable editor", async () => {
  const api = globalThis.__saveTest.fsApi;
  const original = { write: api.writeFileSnapshot, read: api.readFileSnapshot, touch: api.touchFile };
  const originalError = console.error;
  const tab = { id: "late-conflict", path: "late-conflict.md", title: "late", content: "initial" };
  let rejectWrite;
  api.writeFileSnapshot = () => new Promise((_resolve, reject) => { rejectWrite = reject; });
  api.readFileSnapshot = async () => ({ content: "external", version: "external-version" });
  api.touchFile = async () => {};
  console.error = () => {};
  store.setState({ leftTabs: [tab], rightTabs: [], isSplitMode: false });
  try {
    store.getState().updateTabContent(tab.id, "recoverable edit", "left");
    const saving = assert.rejects(flushPendingWrites());
    await new Promise(resolve => setImmediate(resolve));
    store.getState().closeTab(tab.id, "left");
    rejectWrite(new Error("FILE_CONFLICT: external edit"));
    await saving;
    assert.equal(current().content, "recoverable edit");
    assert.match(current().saveError, /FILE_CONFLICT/);
    assert.equal(current().isDirty, true);
    store.getState().closeTab(tab.id, "left");
    await assert.rejects(store.getState().setProject("next-project"), /late-conflict.md/);
    assert.ok(store.getState().leftTabs.some(item => item.path === tab.path), "blocked project changes restore and focus the failed file");
    await resolveFileConflict(tab.path, "reload");
    await flushPendingWrites();
    assert.equal(current().content, "external");
  } finally {
    api.writeFileSnapshot = original.write; api.readFileSnapshot = original.read; api.touchFile = original.touch;
    console.error = originalError;
  }
});

test("watcher checks content after own saves and reloads a conflict with the latest disk version", async () => {
  const api = globalThis.__saveTest.fsApi;
  const original = { write: api.writeFileSnapshot, read: api.readFileSnapshot };
  let disk = "baseline";
  const tab = { id: "watched", path: "watched.md", title: "watched", content: disk, diskVersion: `version:${disk}` };
  store.setState({ rootPath: "watched-project", leftTabs: [tab], rightTabs: [] });
  api.readFileSnapshot = async () => ({ content: disk, version: `version:${disk}` });
  api.writeFileSnapshot = async (_path, content, expected) => {
    assert.equal(expected, `version:${disk}`);
    disk = content;
    return { logicalChanged: false, version: `version:${disk}` };
  };
  try {
    store.getState().updateTabContent(tab.id, "saved", "left");
    await flushPendingWrites();
    assert.deepEqual(await refreshOpenFiles([tab.path]), [], "own saves do not trigger duplicate indexing");
    disk = "other";
    assert.deepEqual(await refreshOpenFiles([tab.path]), [tab.path]);
    assert.equal(current().content, "other", "same-size edits immediately after a save remain visible");
    store.getState().updateTabContent(tab.id, "unsaved", "left");
    disk = "third";
    await refreshOpenFiles([tab.path]);
    assert.equal(current().content, "unsaved");
    assert.match(current().saveError, /FILE_CONFLICT/);
    await resolveFileConflict(tab.path, "reload");
    assert.equal(current().content, "third");
    assert.equal(current().isDirty, false);
    store.getState().updateTabContent(tab.id, "after reload", "left");
    await flushPendingWrites();
    assert.equal(disk, "after reload");
  } finally { api.writeFileSnapshot = original.write; api.readFileSnapshot = original.read; }
});

test("slow saves coalesce pending edits and use the version returned by the previous write", async () => {
  const api = globalThis.__saveTest.fsApi;
  const original = api.writeFileSnapshot;
  const tab = { id: "slow", path: "C:/slow.md", title: "slow", content: "initial", diskVersion: "v0" };
  store.setState({ rootPath: "slow-project", leftTabs: [tab], rightTabs: [{ ...tab, id: "alias", path: "c:\\SLOW.md" }] });
  const calls = [];
  let release;
  api.writeFileSnapshot = async (path, content, expected) => {
    calls.push({ path, content, expected });
    if (calls.length === 1) await new Promise(resolve => { release = resolve; });
    return { logicalChanged: false, version: `v${calls.length}` };
  };
  try {
    store.getState().updateTabContent(tab.id, "first", "left");
    const saving = flushPendingWrites();
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 20; i++) store.getState().updateTabContent("alias", `edit ${i}`, "right");
    retryFileSave(tab.path);
    release();
    await saving;
    assert.deepEqual(calls.map(({ content, expected }) => [content, expected]), [["first", "v0"], ["edit 19", "v1"]]);
    assert.ok(store.getState().leftTabs.every(item => !item.isDirty && item.diskVersion === "v2"));
    assert.ok(store.getState().rightTabs.every(item => !item.isDirty && item.diskVersion === "v2"));
  } finally { api.writeFileSnapshot = original; }
});

test("a watcher read started before saving cannot overwrite edits or report a stale conflict", async () => {
  const api = globalThis.__saveTest.fsApi;
  const original = { write: api.writeFileSnapshot, read: api.readFileSnapshot };
  const tab = { id: "race", path: "race.md", title: "race", content: "initial", diskVersion: "v0" };
  store.setState({ rootPath: "race-project", leftTabs: [tab], rightTabs: [] });
  let releaseRead;
  api.readFileSnapshot = () => new Promise(resolve => { releaseRead = resolve; });
  let version = 0;
  api.writeFileSnapshot = async (_path, _content, expected) => {
    assert.equal(expected, `v${version}`);
    return { logicalChanged: false, version: `v${++version}` };
  };
  try {
    const refreshing = refreshOpenFiles([tab.path]);
    store.getState().updateTabContent(tab.id, "first", "left");
    await flushPendingWrites();
    store.getState().updateTabContent(tab.id, "second", "left");
    releaseRead({ content: "initial", version: "v0" });
    await refreshing;
    assert.equal(current().content, "second");
    assert.equal(current().saveError, undefined);
    await flushPendingWrites();
    assert.equal(version, 2);
  } finally { api.writeFileSnapshot = original.write; api.readFileSnapshot = original.read; }
});

test("local history recreates deleted files and rejects concurrent external creation", async () => {
  const api = globalThis.__saveTest.fsApi;
  const original = { read: api.readFileSnapshot, write: api.writeFileSnapshot };
  const tab = { id: "deleted-history", path: "deleted-history.md", title: "deleted", content: "old" };
  let disk;
  let createDuringRestore = false;
  store.setState({ rootPath: "history-project", leftTabs: [tab], rightTabs: [] });
  api.readFileSnapshot = async (_path, allowMissing) => {
    if (disk === undefined && !allowMissing) throw new Error("File not found");
    return { content: disk ?? "", version: disk === undefined ? "missing" : `version:${disk}` };
  };
  api.writeFileSnapshot = async (_path, content, expected) => {
    if (createDuringRestore) disk = "external";
    const version = disk === undefined ? "missing" : `version:${disk}`;
    if (expected !== version) throw new Error("FILE_CONFLICT: external creation");
    disk = content;
    return { logicalChanged: true, version: `version:${content}` };
  };
  try {
    await restoreLocalVersion(tab.path, "restored");
    assert.equal(disk, "restored");
    assert.equal(current().content, "restored");
    assert.equal(current().diskVersion, "version:restored");
    assert.equal(current().isDirty, false);
    disk = undefined;
    createDuringRestore = true;
    await assert.rejects(restoreLocalVersion(tab.path, "older history"), /FILE_CONFLICT/);
    assert.equal(disk, "external");
    assert.equal(current().content, "restored");
  } finally { api.readFileSnapshot = original.read; api.writeFileSnapshot = original.write; }
});
