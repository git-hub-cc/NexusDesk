import test from "node:test";
import assert from "node:assert/strict";
import { moduleUrl, pathsUrl } from "./helpers/loadSource.mjs";

const { createGraphDataResource } = await import(moduleUrl("lib/graphData.ts", {
  "./paths": pathsUrl,
  "./treeGraph": moduleUrl("lib/treeGraph.ts", { "d3-hierarchy": import.meta.resolve("d3-hierarchy") }),
}));

test("graph consumers share requests, deduplicate paths, skip missing files and prefer buffers", async () => {
  let scans = 0;
  const reads = [];
  const resource = createGraphDataResource({
    root: () => "project",
    categories: async () => { scans++; return [
      { name: "one", files: ["C:/a.tree", "C:/missing.tree", "C:/b.tree"], missingFiles: ["c:/MISSING.tree"] },
      { name: "two", files: ["c:/A.tree"], missingFiles: [] },
    ]; },
    content: path => path.toLowerCase() === "c:/a.tree" ? "shared\n  buffered" : undefined,
    read: async path => { reads.push(path); return "shared\n  disk"; },
  });
  const first = resource.refresh();
  assert.equal(first, resource.refresh());
  await first;
  const snapshot = resource.getSnapshot();
  assert.equal(scans, 1);
  assert.deepEqual(reads, ["C:/b.tree"]);
  assert.equal(snapshot.trees.length, 2);
  assert.equal(snapshot.counts.get("shared"), 2);
  assert.equal(snapshot.counts.get("buffered"), 1);
});

test("one failed file preserves successful trees and retries on refresh", async () => {
  let fail = true;
  const resource = createGraphDataResource({
    root: () => "project",
    categories: async () => [{ name: "one", files: ["a.tree", "b.tree"], missingFiles: [] }],
    content: () => undefined,
    read: async path => { if (fail && path === "b.tree") throw new Error("denied"); return "root"; },
  });
  await resource.refresh();
  assert.equal(resource.getSnapshot().trees.length, 1);
  assert.match(resource.getSnapshot().error, /b.tree: Error: denied/);
  fail = false;
  await resource.refresh();
  assert.equal(resource.getSnapshot().trees.length, 2);
  assert.equal(resource.getSnapshot().error, "");
});

test("invalidated reads and project switches cannot publish stale graph data", async () => {
  let root = "first";
  let finish;
  let scans = 0;
  const resource = createGraphDataResource({
    root: () => root,
    categories: async () => [{ name: root, files: ["a.tree"], missingFiles: [] }],
    content: () => undefined,
    read: () => ++scans === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve("fresh"),
  });
  const stale = resource.refresh();
  await Promise.resolve();
  resource.invalidate();
  await resource.refresh();
  finish("stale");
  await stale;
  assert.equal(resource.getSnapshot().trees[0].content, "fresh");
  root = "second";
  await resource.refresh();
  assert.equal(resource.getSnapshot().root, "second");
  assert.equal(resource.getSnapshot().categories[0].name, "second");
  root = null;
  await resource.refresh();
  assert.equal(resource.getSnapshot().trees.length, 0);
});
