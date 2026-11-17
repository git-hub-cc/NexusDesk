import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/gitFileTree.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { buildGitTree, summarizeGitTree } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("project root wraps sorted directories and files without changing repository paths", () => {
  const paths = ["z.md", "docs/b.md", "docs/a.md", "a.md"];
  const [root] = buildGitTree(paths, "NexusDesk");
  assert.equal(root.root, true);
  assert.equal(root.name, "NexusDesk");
  assert.deepEqual(root.children.map(node => node.name), ["docs", "a.md", "z.md"]);
  assert.deepEqual(root.children[0].children.map(node => node.path), ["docs/a.md", "docs/b.md"]);
  assert.deepEqual(buildGitTree(paths), root.children);
});

test("root and directory counts exclude conflicts and track partial selection and pending operations", () => {
  const nodes = buildGitTree(["docs/a", "docs/b", "conflict"], "project");
  const counts = summarizeGitTree(nodes, path => ({
    eligible: Number(path !== "conflict"), checked: Number(path === "docs/a"), pending: Number(path === "docs/b"),
  }));
  assert.deepEqual(counts.get(nodes[0].id), { total: 3, eligible: 2, checked: 1, pending: 1 });
  assert.deepEqual(counts.get("dir:docs"), { total: 2, eligible: 2, checked: 1, pending: 1 });
  assert.deepEqual(summarizeGitTree(buildGitTree([], "empty"), () => assert.fail()).get("git-project-root"),
    { total: 0, eligible: 0, checked: 0, pending: 0 });
});

test("large trees count each file once including files inside collapsed directories", () => {
  for (const size of [1000, 5000, 10000]) {
    const paths = Array.from({ length: size }, (_, index) => `dir-${index % 100}/file-${index}.md`);
    const nodes = buildGitTree(paths, "project");
    let visits = 0;
    const counts = summarizeGitTree(nodes, () => { visits++; return { eligible: 1, checked: 1, pending: 0 }; });
    assert.equal(visits, size);
    assert.deepEqual(counts.get(nodes[0].id), { total: size, eligible: size, checked: size, pending: 0 });
  }
});
