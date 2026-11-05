import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/git/GitPanel.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("GitPanel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effectSource;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" &&
      ts.isArrowFunction(node.arguments[0]) && node.arguments[0].getText(ast).includes('"workspace-changed"')) {
    effectSource = node.arguments[0].getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(effectSource, "GitPanel should subscribe to workspace change events");
const compiled = ts.transpileModule(`const effect = ${effectSource};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function setup({ isRepository = true } = {}) {
  let handler;
  let unlistened = false;
  let statusRefreshes = 0;
  const errors = [];
  const values = {
    isRepository,
    listen: async (name, callback) => {
      assert.equal(name, "workspace-changed");
      handler = callback;
      return () => { unlistened = true; };
    },
    root: "project",
    locked: { current: false },
    pendingRef: { current: new Set() },
    refreshStatus: async () => { statusRefreshes++; },
    mounted: { current: true },
    setError: error => errors.push(error),
  };
  const runEffect = new Function(...Object.keys(values), `${compiled}\nreturn effect;`)(...Object.values(values));
  const cleanup = runEffect();
  return { values, get handler() { return handler; }, get unlistened() { return unlistened; }, get statusRefreshes() { return statusRefreshes; }, errors, cleanup };
}

test("GitPanel refreshes Git status for external deletions in the active repository", async () => {
  const f = setup();
  await Promise.resolve();
  f.handler({ payload: { root: "other-project", paths: ["deleted.md"] } });
  f.handler({ payload: { root: "project", paths: [] } });
  f.values.locked.current = true;
  f.handler({ payload: { root: "project", paths: ["deleted.md"] } });
  f.values.locked.current = false;
  f.values.pendingRef.current.add("deleted.md");
  f.handler({ payload: { root: "project", paths: ["deleted.md"] } });
  f.values.pendingRef.current.clear();
  f.handler({ payload: { root: "project", paths: ["deleted.md"] } });
  await Promise.resolve();

  assert.equal(f.statusRefreshes, 1);
  assert.deepEqual(f.errors, []);
  f.cleanup();
  assert.equal(f.unlistened, true);
});

test("GitPanel does not subscribe to workspace changes outside a Git repository", () => {
  const f = setup({ isRepository: false });
  assert.equal(f.handler, undefined);
  assert.equal(f.cleanup, undefined);
});
