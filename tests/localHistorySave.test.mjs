import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { paths } from "./helpers/loadSource.mjs";

const source = readFileSync(new URL("../src/components/editor/LocalHistoryDialog.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("LocalHistoryDialog.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "handleChange") handler = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);

function harness(leftTabs, rightTabs = []) {
  const updates = [];
  const writes = [];
  const errors = [];
  const pending = { current: Promise.resolve() };
  const state = { leftTabs, rightTabs, updateTabContent: (...args) => updates.push(args) };
  const context = {
    path: "C:/project/note.md", samePath: paths.samePath,
    useWorkspaceStore: { getState: () => state }, writes: pending,
    diskVersion: { current: "baseline" }, setError: error => errors.push(error),
    fsApi: { writeFileSnapshot: async (...args) => {
      writes.push(args);
      return { version: `saved-${writes.length}` };
    } },
  };
  const change = vm.runInNewContext(ts.transpile(`(${handler})`, { target: ts.ScriptTarget.ES2022 }), context);
  return { change, updates, writes, errors, pending, context };
}

const tab = flags => ({ id: "note", path: "C:/project/note.md", ...flags });

test("local history saves with version checks when only noneditable tabs are open", async () => {
  for (const flags of [{ diffStaged: true }, { diffReadOnly: true }, { readOnly: true }, { revision: "HEAD" }, { browser: {} }]) {
    const h = harness([tab(flags)]);
    h.change("first edit");
    h.change("latest edit");
    await h.pending.current;
    assert.deepEqual(h.updates, []);
    assert.deepEqual(h.writes, [
      ["C:/project/note.md", "first edit", "baseline"],
      ["C:/project/note.md", "latest edit", "saved-1"],
    ]);
    assert.deepEqual(h.errors, []);
  }
});

test("local history finds an editable tab after a staged tab and uses its actual pane", async () => {
  for (const flags of [{}, { diff: "worktree patch" }]) {
    const h = harness([tab({ diffStaged: true })], [tab({ ...flags, path: "c:\\PROJECT\\note.md" })]);
    h.change("edited");
    await h.pending.current;
    assert.deepEqual(h.updates, [["note", "edited", "right"]]);
    assert.deepEqual(h.writes, []);
  }
});

test("local history reports conflicts from its independent save path", async () => {
  const h = harness([tab({ diffStaged: true })]);
  h.context.fsApi.writeFileSnapshot = async () => { throw new Error("FILE_CONFLICT: changed on disk"); };
  h.change("edited");
  await h.pending.current;
  assert.match(h.errors[0], /FILE_CONFLICT:/);
  assert.equal(h.context.diskVersion.current, "baseline");
});
