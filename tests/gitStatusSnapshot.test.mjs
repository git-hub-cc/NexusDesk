import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function fixture(invoke) {
  const context = { exports: {}, setTimeout, require: name => name === "./remote" ? { invokePathCommand: invoke } : {} };
  const source = readFileSync(new URL("../src/utils/api.ts", import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.exports.gitApi;
}

test("file tree and commit panel share one scan without caching completed status", async () => {
  let scans = 0;
  const api = fixture(async command => {
    assert.equal(command, "get_git_status_snapshot");
    scans++;
    return { files: [scans], tree: [scans] };
  });
  const [files, tree] = await Promise.all([api.status("repo"), api.treeStatus("repo")]);
  assert.deepEqual(files, [1]);
  assert.deepEqual(tree, [1]);
  assert.equal(scans, 1);
  assert.deepEqual(await api.status("repo"), [2]);
});

test("changes during a scan trigger one follow-up and all callers receive current status", async () => {
  let scans = 0;
  let started;
  let release;
  const scanning = new Promise(resolve => { started = resolve; });
  const api = fixture(async () => {
    if (++scans === 1) {
      started();
      await new Promise(resolve => { release = resolve; });
    }
    return { files: [scans], tree: [scans] };
  });
  const first = api.status("repo");
  await scanning;
  api.invalidateStatus("repo");
  api.invalidateStatus("repo");
  const second = api.treeStatus("repo");
  release();
  assert.deepEqual(await first, [2]);
  assert.deepEqual(await second, [2]);
  assert.equal(scans, 2);
});

test("failed scans release the shared request so a refresh can retry", async () => {
  let scans = 0;
  const api = fixture(async () => {
    if (++scans === 1) throw new Error("busy");
    return { files: [], tree: [] };
  });
  await assert.rejects(api.status("repo"), /busy/);
  assert.deepEqual(await api.treeStatus("repo"), []);
  assert.equal(scans, 2);
});
