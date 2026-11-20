import test from "node:test";
import assert from "node:assert/strict";
import { moduleUrl, pathsUrl } from "./helpers/loadSource.mjs";

const { findGitTreeLocation } = await import(moduleUrl("utils/gitTreeLocation.ts", { "./paths": pathsUrl }));
const current = () => true;
const root = "C:\\Repo\\Docs";
const guide = { id: `${root}\\Guide`, isLeaf: false };
const file = { id: `${guide.id}\\Intro.md`, isLeaf: true };

test("Git paths resolve to the actual physical tree IDs, even in a project subdirectory", async () => {
  const reads = [];
  const read = async path => {
    reads.push(path);
    return path === root ? [guide] : [file];
  };
  assert.deepEqual(await findGitTreeLocation(root, "c:/repo/docs/guide/intro.md", read, current),
    { kind: "file", entry: file, parent: guide.id });
  assert.deepEqual(reads, [root, guide.id]);
  assert.deepEqual(await findGitTreeLocation(root, "c:/repo/docs-old/intro.md", read, current), { kind: "outside" });
  assert.deepEqual(reads, [root, guide.id]);
});

test("when a file and its parent have disappeared, locate the nearest visible directory", async () => {
  const read = async path => path === root ? [guide] : [];
  assert.deepEqual(await findGitTreeLocation(root, "c:/repo/docs/guide/old/intro.md", read, current),
    { kind: "missing", directory: guide });
  assert.deepEqual(await findGitTreeLocation(root, "c:/repo/docs/intro.md", read, current),
    { kind: "missing", directory: undefined });
});

test("an unreadable directory and a stale request are different from a missing file", async () => {
  const path = "c:/repo/docs/guide/intro.md";
  assert.deepEqual(await findGitTreeLocation(root, path, async () => undefined, current), { kind: "unavailable" });
  assert.deepEqual(await findGitTreeLocation(root, path, async () => [guide], () => false), { kind: "cancelled" });
});
