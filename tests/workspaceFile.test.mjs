import test from "node:test";
import assert from "node:assert/strict";
import { create } from "zustand";
import { moduleUrl, pathsUrl, assetsUrl } from "./helpers/loadSource.mjs";

const opened = [];
let read = async () => "disk";
let flush = () => {};
const store = create(() => ({}));
globalThis.__workspaceFileTest = {
  useWorkspaceStore: store, fsApi: { readFile: path => read(path) }, flushEditorContent: () => flush(),
};
const runtime = "data:text/javascript,export const { useWorkspaceStore, fsApi, flushEditorContent } = globalThis.__workspaceFileTest;";
const { openWorkspaceFile: open } = await import(moduleUrl("lib/workspaceFile.ts", {
  "./api": runtime, "./assets": assetsUrl, "./paths": pathsUrl,
  "./remote": moduleUrl("lib/remote.ts", { "@tauri-apps/api/core": "data:text/javascript,export const invoke = () => {};" }),
  "@/store/workspaceStore": runtime,
}));

function reset() {
  opened.length = 0;
  read = async () => "disk";
  flush = () => {};
  store.setState({ rootPath: "C:/project", focusedPane: "left", leftTabs: [], rightTabs: [], openTab: (tab, options) => opened.push({ tab, options }) }, true);
}

test("opening reuses buffered content across panes and ignores revision tabs", async () => {
  reset();
  read = () => { throw new Error("unexpected read"); };
  store.setState({ leftTabs: [{ id: "history", path: "C:/project/A.md", content: "history", revision: "abc" }],
    rightTabs: [{ id: "existing", path: "c:/PROJECT/a.md", content: "unsaved", isDirty: true, markdownMode: "source" }] });
  assert.equal(await open("C:\\project\\A.md"), true);
  assert.equal(opened[0].tab.id, "existing");
  assert.equal(opened[0].tab.content, "unsaved");
  assert.equal(opened[0].tab.isDirty, true);
  assert.equal(opened[0].options.pane, "left");
});

test("previews skip text reads, SVG remains editable, remote and unsupported binaries reject", async () => {
  reset();
  const reads = [];
  read = async path => { reads.push(path); return "<svg/>"; };
  for (const path of ["image.avif", "document.pdf", "movie.mp4"]) await open(path);
  assert.equal(reads.length, 0);
  await open("image.svg");
  assert.equal(opened.at(-1).tab.content, "<svg/>");
  await assert.rejects(open("sftp://one/document.pdf"));
  await assert.rejects(open("sftp://one/image.png"));
  await assert.rejects(open("archive.zip"));
  await open("sftp://one/note.md");
  assert.deepEqual(reads, ["image.svg", "sftp://one/note.md"]);
});

test("pending opens cannot cross project switches, even when returning to the original project", async () => {
  reset();
  let finish;
  read = () => new Promise(resolve => { finish = resolve; });
  const pending = open("a.md");
  store.setState({ rootPath: "other" });
  store.setState({ rootPath: "C:/project" });
  finish("old project");
  assert.equal(await pending, false);
  assert.equal(opened.length, 0);
});

test("opening flushes editor buffers and preserves edits made while a disk read is pending", async () => {
  reset();
  let flushed = false;
  flush = () => { flushed = true; };
  let finish;
  read = () => new Promise(resolve => { finish = resolve; });
  const pending = open("a.md");
  assert.ok(flushed);
  store.setState({ leftTabs: [{ id: "a", path: "a.md", content: "new edit", isDirty: true }] });
  finish("old disk");
  await pending;
  assert.equal(opened[0].tab.content, "new edit");
  assert.ok(opened[0].tab.isDirty);
});

test("caller cancellation prevents opening after a pending read", async () => {
  reset();
  let alive = true;
  read = async () => { alive = false; return "disk"; };
  assert.equal(await open("a.md", { isCurrent: () => alive }), false);
  assert.equal(opened.length, 0);
});
