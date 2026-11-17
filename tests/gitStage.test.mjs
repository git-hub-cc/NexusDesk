import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/git/GitPanel.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("GitPanel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let stageSource;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "stageMany") stageSource = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(stageSource);
const compiled = ts.transpileModule(`${stageSource}\nreturn stageMany;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

test("bulk selection uses one request, skips conflicts, saves first, and refreshes even after failure", async () => {
  for (const fail of [false, true]) {
    const calls = [];
    const errors = [];
    const pendingRef = { current: new Set() };
    const queue = { current: Promise.resolve() };
    const values = {
      locked: { current: false }, pendingRef, queue, mounted: { current: true }, root: "repo",
      setPending: () => {}, setError: value => errors.push(value),
      flushPendingWrites: async () => { calls.push("save"); },
      gitApi: { stageMany: async (_root, paths, staged) => {
        calls.push([paths.length, staged]);
        if (fail) throw new Error("stage failed");
      } },
      refreshStatus: async () => { calls.push("refresh"); },
    };
    const stage = new Function(...Object.keys(values), compiled)(...Object.values(values));
    stage([
      ...Array.from({ length: 10000 }, (_, index) => ({ path: `${index}.md`, staged: false, conflict: false })),
      { path: "conflict", conflict: true, staged: false },
      { path: "already-staged", conflict: false, staged: true },
    ], true);
    assert.equal(pendingRef.current.size, 10000);
    await queue.current;
    assert.deepEqual(calls, ["save", [10000, true], "refresh"]);
    assert.equal(pendingRef.current.size, 0);
    assert.equal(errors.at(-1), fail ? "Error: stage failed" : "");
  }
});
