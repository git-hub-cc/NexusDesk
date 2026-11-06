import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/git/GitPanel.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("GitPanel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let undoSource, shortcutSource;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "undoRevert") undoSource = node.getText(ast);
  if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(p => p.name?.getText(ast) === "ref" && p.initializer?.getText(ast) === "{panelRef}")) {
    shortcutSource = node.attributes.properties.find(p => p.name?.getText(ast) === "onKeyDown").initializer.expression.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
function compile(code, values, result) {
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(values), `${compiled}\nreturn ${result};`)(...Object.values(values));
}

test("undo revert flushes through the mutation runner, closes affected editors and reports restored files", async () => {
  const closed = [], notices = [];
  const state = {
    leftTabs: [{ id: "file", path: "C:\\repo\\note.md" }, { id: "other", path: "C:/repo/other.md" }],
    rightTabs: [{ id: "diff", path: "note.md" }, { id: "history", path: "note.md", revision: "commit" }],
    closeTab: (...args) => closed.push(args),
  };
  const undo = compile(undoSource, {
    run: async (action, mutate) => { assert.equal(mutate, true); await action(); },
    gitApi: { undoRevert: async root => { assert.equal(root, "C:/repo"); return ["note.md"]; } },
    root: "C:/repo", useWorkspaceStore: { getState: () => state }, setNotice: text => notices.push(text),
  }, "undoRevert");
  await undo();
  assert.deepEqual(closed, [["file", "left"], ["diff", "right"]]);
  assert.match(notices[0], /1/);
});

test("empty persisted history leaves editors open", async () => {
  const notices = [];
  const undo = compile(undoSource, {
    run: async action => action(), gitApi: { undoRevert: async () => [] }, root: "repo",
    useWorkspaceStore: { getState: () => assert.fail("must not close any tabs") }, setNotice: text => notices.push(text),
  }, "undoRevert");
  await undo();
  assert.equal(notices[0], "没有可撤销的文件回退");
});

test("version control Ctrl+Z and Command+Z restore reverts while text fields retain native undo", () => {
  let calls = 0;
  const handler = compile(`const handler = ${shortcutSource};`, {
    revision: null, isRepository: true, undoRevert: () => { calls++; },
  }, "handler");
  const event = overrides => ({
    key: "z", ctrlKey: true, nativeEvent: {}, target: { closest: () => null },
    preventDefault() { this.prevented = true; }, stopPropagation() {}, ...overrides,
  });
  handler(event({}));
  handler(event({ ctrlKey: false, metaKey: true, key: "Z" }));
  assert.equal(calls, 2);
  for (const overrides of [
    { target: { closest: () => ({}) } }, { shiftKey: true }, { altKey: true },
    { nativeEvent: { isComposing: true } }, { defaultPrevented: true }, { ctrlKey: false },
  ]) {
    const e = event(overrides);
    handler(e);
    assert.equal(e.prevented, undefined);
  }
  assert.equal(calls, 2);
});
