import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import debounce from "lodash/debounce.js";

test("watcher skips own saves, merges external events and cancels pending work on cleanup", async () => {
  const listeners = new Map();
  const calls = [];
  let cleanup;
  const state = {
    rootPath: "project", fileTreeData: [],
    loadDirectory: async () => calls.push("directory"),
    refreshTreeStatuses: async () => calls.push("git"),
    fetchLogicalTree: async () => calls.push("logical"),
  };
  globalThis.__watcherTest = {
    useEffect: fn => { cleanup = fn(); }, debounce,
    listen: async (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); },
    useWorkspaceStore: { getState: () => state },
    isRecentlySavedPath: path => path === "own.md",
    refreshOpenFiles: async paths => calls.push(paths),
    fsApi: { invalidateTreeFiles() {}, syncProjectIndex: async () => calls.push("index") },
    window: { addEventListener() {}, removeEventListener() {} },
  };
  const source = readFileSync(new URL("../src/hooks/useWorkspaceWatcher.ts", import.meta.url), "utf8").replace(/^import .*;$/gm, "");
  const compiled = ts.transpileModule("const { useEffect, debounce, listen, useWorkspaceStore, isRecentlySavedPath, refreshOpenFiles, fsApi, window } = globalThis.__watcherTest;\n" + source,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const { useWorkspaceWatcher } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  useWorkspaceWatcher();
  const emit = paths => listeners.get("workspace-changed")({ payload: { root: "project", paths } });
  try {
    emit(["own.md"]);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.deepEqual(calls, []);
    emit(["own.md", "external.md"]);
    emit(["external.md", "other.md"]);
    assert.deepEqual(calls, []);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.deepEqual(calls, ["directory", "git", ["external.md", "other.md"], "index", "logical"]);
    calls.length = 0;
    emit(["later.md"]);
    cleanup();
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.deepEqual(calls, []);
  } finally {
    cleanup();
    delete globalThis.__watcherTest;
  }
});
