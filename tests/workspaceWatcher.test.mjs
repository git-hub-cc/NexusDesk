import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import debounce from "lodash/debounce.js";

async function fixture() {
  const listeners = new Map();
  const calls = [];
  let cleanup;
  const state = {
    rootPath: "project", fileTreeData: [],
    loadDirectory: async path => calls.push(["directory", path]),
    refreshTreeStatuses: async () => {},
    fetchLogicalTree: async () => calls.push("logical"),
  };
  globalThis.__watcherTest = {
    useEffect: fn => { cleanup = fn(); }, debounce,
    listen: async (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); },
    useWorkspaceStore: { getState: () => state },
    isRecentlySavedPath: path => path === "project/own.md",
    refreshOpenFiles: async paths => calls.push(["files", paths]),
    fsApi: { invalidateTreeFiles() {}, syncProjectIndex: async (root, paths) => calls.push(["index", root, paths]) },
    gitApi: { invalidateStatus() {} },
    isSnapshot: false,
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
  };
  const source = readFileSync(new URL("../src/hooks/useWorkspaceWatcher.ts", import.meta.url), "utf8").replace(/^import .*;$/gm, "");
  const compiled = ts.transpileModule("const { useEffect, debounce, listen, useWorkspaceStore, isRecentlySavedPath, refreshOpenFiles, fsApi, gitApi, window, isSnapshot } = globalThis.__watcherTest;\n" + source,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const { useWorkspaceWatcher } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}#${Math.random()}`);
  useWorkspaceWatcher();
  return { state, calls, cleanup, emit: paths => listeners.get("workspace-changed")({ payload: { root: "project", paths } }) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 350));

test("watcher skips own saves, merges external paths and cancels pending work", async () => {
  const f = await fixture();
  try {
    f.emit(["project/own.md"]);
    await settle();
    assert.deepEqual(f.calls, []);
    f.emit(["project/own.md", "project/external.md"]);
    f.emit(["project/external.md", "project/other.md"]);
    await settle();
    assert.deepEqual(f.calls, [["directory", "project"], ["files", ["project/external.md", "project/other.md"]],
      ["index", "project", ["project/external.md", "project/other.md"]], "logical"]);
    f.calls.length = 0;
    f.emit(["project/later.md"]);
    f.cleanup();
    await settle();
    assert.deepEqual(f.calls, []);
  } finally { f.cleanup(); }
});

test("only affected loaded directories refresh, including empty directories and renamed subtrees", async () => {
  const f = await fixture();
  f.state.fileTreeData = [
    { id: "project/empty", isLeaf: false, children: [] },
    { id: "project/other", isLeaf: false, children: [] },
    { id: "project/old", isLeaf: false, children: [{ id: "project/old/nested", isLeaf: false, children: [] }] },
  ];
  try {
    f.emit(["project/empty/new.md"]);
    await settle();
    assert.deepEqual(f.calls.filter(call => call[0] === "directory"), [["directory", "project/empty"]]);
    f.calls.length = 0;
    f.emit(["project/old", "project/renamed"]);
    await settle();
    assert.deepEqual(f.calls.filter(call => call[0] === "directory"), [
      ["directory", "project"], ["directory", "project/old"], ["directory", "project/old/nested"],
    ]);
  } finally { f.cleanup(); }
});

test("events arriving during indexing merge into one subsequent batch", async () => {
  const f = await fixture();
  let release;
  let indexes = 0;
  globalThis.__watcherTest.fsApi.syncProjectIndex = async (root, paths) => {
    f.calls.push(["index", root, paths]);
    if (++indexes === 1) await new Promise(resolve => { release = resolve; });
  };
  try {
    f.emit(["project/first.md"]);
    await settle();
    f.emit(["project/second.md"]);
    await settle();
    f.emit(["project/third.md"]);
    await settle();
    assert.equal(indexes, 1);
    release();
    await settle();
    assert.deepEqual(f.calls.filter(call => call[0] === "index").map(call => call[2]), [
      ["project/first.md"], ["project/second.md", "project/third.md"],
    ]);
  } finally { f.cleanup(); }
});
