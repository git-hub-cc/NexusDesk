import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { moduleUrl } from "./helpers/loadSource.mjs";

const { originalFromPatch } = await import(moduleUrl("lib/gitDiff.ts"));
const comparisonSource = readFileSync(new URL("../src/components/editor/GitComparison.tsx", import.meta.url), "utf8");
const comparisonCode = ts.transpileModule(comparisonSource.replace(/^import .*;$/gm, "").replace("export function", "function"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const editorSource = readFileSync(new URL("../src/components/editor/EditableGitDiff.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("EditableGitDiff.tsx", editorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initialization;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "init") {
    const statements = node.initializer.body.statements;
    const end = statements.findIndex(statement => ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === "refresh"));
    initialization = statements.slice(0, end).map(statement => statement.getText(ast)).join("\n");
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(initialization);

function render(tab) {
  const updates = [];
  const state = { leftTabs: [tab], rightTabs: [] };
  const dependencies = {
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    useRef: value => ({ current: value }), useState: value => [value, () => {}],
    EditableGitDiff: "editable", GitDiffEditor: "readonly",
    useWorkspaceStore: { setState(update) { Object.assign(state, update(state)); } },
  };
  const component = new Function(...Object.keys(dependencies), `${comparisonCode}\nreturn GitComparison;`)(...Object.values(dependencies));
  const tree = component({ tab, pane: "left", onChange: text => updates.push(text) });
  return { props: tree.children[0].props, state, updates };
}

async function initialize(props, disk) {
  const reads = [];
  const dependencies = {
    ...props, contents: undefined, disposed: false, originalFromPatch,
    fsApi: { async readFileSnapshot(...args) { reads.push(args); return disk; } },
  };
  const code = ts.transpile(`return (async () => { ${initialization}\nreturn { left, right }; })();`, {
    target: ts.ScriptTarget.ES2022,
  });
  const result = await new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
  return { ...result, reads };
}

test("opening a conflict diff preserves edits, including an empty document, and its version baseline", async () => {
  for (const content of ["retained edit\n", ""]) {
    const tab = { id: "diff", path: "note.md", title: "note", diff: "@@ -1 +1 @@\n-base\n+disk\n",
      content, isDirty: true, saveError: "FILE_CONFLICT: external edit", diskVersion: "original-version" };
    const { props, state, updates } = render(tab);
    const loaded = await initialize(props, { content: "disk\n", version: "external-version" });
    assert.equal(loaded.right, content);
    assert.equal(loaded.left, "base\n");
    assert.equal(state.leftTabs[0].diskVersion, "original-version");
    assert.equal(state.leftTabs[0].content, content);
    props.onChange(`${loaded.right}continued`);
    assert.deepEqual(updates, [`${content}continued`]);
    assert.deepEqual(loaded.reads, [["note.md", true]]);
  }
});

test("clean diffs load current disk contents and establish the disk version", async () => {
  const tab = { id: "diff", path: "note.md", title: "note", diff: "", content: "stale" };
  const { props, state } = render(tab);
  const loaded = await initialize(props, { content: "current", version: "disk-version" });
  assert.equal(loaded.right, "current");
  assert.equal(state.leftTabs[0].content, "current");
  assert.equal(state.leftTabs[0].diskVersion, "disk-version");
  assert.deepEqual(loaded.reads, [["note.md", false]]);
});

test("a deleted disk file still displays retained conflict edits", async () => {
  const tab = { id: "diff", path: "deleted.md", title: "deleted", diff: "", content: "retained",
    isDirty: true, saveError: "FILE_CONFLICT: deleted", diskVersion: "original-version" };
  const { props, state } = render(tab);
  const loaded = await initialize(props, { content: "", version: "missing" });
  assert.equal(loaded.right, "retained");
  assert.equal(state.leftTabs[0].diskVersion, "original-version");
  assert.deepEqual(loaded.reads, [["deleted.md", true]]);
});
