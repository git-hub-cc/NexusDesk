import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("saved expansion loads nested lazy directories and keeps collapsed branches unloaded", async () => {
  let effect;
  const calls = [];
  const saved = { parent: true, "parent/child": true, "closed/child": true };
  const state = {
    projectTreeOpenState: { project: { physical: saved, logical: { category: true, "category:folder": true } } },
    loadDirectory: (...args) => calls.push(args),
    setTreeNodeOpen: (...args) => calls.push(args),
  };
  const useWorkspaceStore = selector => selector(state);
  useWorkspaceStore.getState = () => state;
  globalThis.__treeOpenTest = { useEffect: fn => { effect = fn; }, useWorkspaceStore };
  const source = readFileSync(new URL("../src/components/explorer/useTreeOpenState.ts", import.meta.url), "utf8")
    .replace(/^import .*;$/gm, "");
  const compiled = ts.transpileModule("const { useEffect, useWorkspaceStore } = globalThis.__treeOpenTest;\n" + source,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  try {
    const { useTreeOpenState } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
    const tree = { current: { isOpen: () => false } };
    const parent = { id: "parent", children: [] };
    const closed = { id: "closed", children: [{ id: "closed/child", children: [] }] };
    const props = useTreeOpenState(tree, "project", "physical", [parent, closed]);
    assert.equal(props.initialOpenState, saved);
    effect();
    assert.deepEqual(calls.splice(0), [["parent", false]]);
    parent.children.push({ id: "parent/child", children: [] });
    useTreeOpenState(tree, "project", "physical", [parent, closed]);
    effect();
    assert.deepEqual(calls.splice(0), [["parent", false], ["parent/child", false]]);
    props.onToggle("parent");
    assert.deepEqual(calls.splice(0), [["project", "physical", "parent", false]]);
    useTreeOpenState(tree, "project", "logical", [{ id: "category", children: [{ id: "folder", children: [] }] }]);
    effect();
    assert.deepEqual(calls, [["folder", true]]);
  } finally {
    delete globalThis.__treeOpenTest;
  }
});
