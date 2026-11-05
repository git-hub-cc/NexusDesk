import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/androidTransfer.ts", import.meta.url), "utf8")
  .replace(/^import .*;\r?$/gm, "").replace(/^export /gm, "");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness({ local = [], text = "", failDownload = 0 } = {}) {
  const calls = [];
  let reads = 0, downloads = 0;
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "write_text_clipboard") { text = args.text; local = []; }
    if (command === "read_text_clipboard") { reads++; return text; }
    if (command === "mirror_download_file") {
      if (++downloads === failDownload) throw new Error("device disconnected");
      return `${args.localDir}/${args.remotePath.split("/").pop()}`;
    }
  };
  const api = new Function("invoke", "fsApi", "isRemotePath", `${code}\nreturn { parseAndroidFiles, topLevelPaths, copyAndroidFiles, readAndroidClipboard, downloadAndroidFiles, uploadLocalFiles, localDropPaths, pasteToAndroid };`)
    (invoke, { readFileClipboard: async () => ({ paths: local, cut: true }) }, path => path.startsWith("sftp:"));
  return { ...api, calls, reads: () => reads };
}

test("local clipboard uploads all selected files and directories without moving cut sources", async () => {
  const h = harness({ local: ["C:/notes/a.txt", "C:/notes/folder", "C:/notes/folder/nested.txt"] });
  await h.pasteToAndroid("phone", "/sdcard/Download");
  assert.deepEqual(h.calls.map(call => call.command), ["mirror_push_file", "mirror_push_file"]);
  assert.deepEqual(h.calls[1].args, { serial: "phone", localPath: "C:/notes/folder", remoteDir: "/sdcard/Download" });
  assert.equal(h.reads(), 0);
});

test("copying Android files replaces the local clipboard and retains device identity and special paths", async () => {
  const h = harness({ local: ["C:/stale.txt"] });
  const data = { serial: "phone", paths: ["/sdcard/中文 ' $.txt", "/sdcard/folder", "/sdcard/folder/nested"] };
  await h.copyAndroidFiles(data);
  const copied = await h.readAndroidClipboard();
  assert.deepEqual(copied, { serial: "phone", paths: data.paths.slice(0, 2) });
  assert.deepEqual(await h.downloadAndroidFiles(copied, "C:/downloads"), ["C:/downloads/中文 ' $.txt", "C:/downloads/folder"]);
  assert.equal(h.calls.filter(call => call.command === "mirror_download_file").length, 2);
});

test("Android paste copies on the same device and refuses a different device", async () => {
  const h = harness();
  await h.copyAndroidFiles({ serial: "phone", paths: ["/sdcard/a.txt"] });
  await h.pasteToAndroid("phone", "/sdcard/Download");
  assert.deepEqual(h.calls.find(call => call.command === "mirror_copy_file").args, { serial: "phone", sourcePath: "/sdcard/a.txt", remoteDir: "/sdcard/Download" });
  await assert.rejects(h.pasteToAndroid("other", "/sdcard"), /不同安卓设备/);
});

test("ordinary clipboard text does not trigger a download and malformed drag payloads are rejected", async () => {
  const h = harness({ text: "ordinary search text" });
  assert.equal(await h.readAndroidClipboard(), null);
  for (const value of ["{}", "null", "bad json", '{"serial":"phone","paths":["relative"]}', '{"serial":"phone","paths":[null]}']) {
    assert.equal(h.parseAndroidFiles(value), null);
  }
  const data = { "application/x-nexusdesk-files": JSON.stringify(["C:/a.txt", "C:/folder"]) };
  assert.deepEqual(h.localDropPaths({ getData: type => data[type] ?? "" }), ["C:/a.txt", "C:/folder"]);
  assert.throws(() => h.localDropPaths({ getData: () => "[123]" }), /无效/);
});

test("partial downloads report completed paths so the receiving tree can refresh after a disconnect", async () => {
  const h = harness({ failDownload: 2 });
  const completed = [];
  await assert.rejects(h.downloadAndroidFiles({ serial: "phone", paths: ["/sdcard/a", "/sdcard/b"] }, "C:/downloads", path => completed.push(path)), /disconnected/);
  assert.deepEqual(completed, ["C:/downloads/a"]);
  await assert.rejects(h.downloadAndroidFiles({ serial: "phone", paths: ["/sdcard/a"] }, "sftp:server/path"), /本地目录/);
});

test("selection pruning preserves case-sensitive Android paths and folds Windows paths", () => {
  const h = harness();
  assert.deepEqual(h.topLevelPaths(["/sdcard/A", "/sdcard/a", "/sdcard/A/child", "/sdcard/AB"]), ["/sdcard/A", "/sdcard/a", "/sdcard/AB"]);
  assert.deepEqual(h.topLevelPaths(["C:\\Notes", "c:/notes/child", "C:/notes"], true), ["C:/notes"]);
});

test("Android rows select on click, activate on double click, and drag the selected files as a copy", () => {
  const transpile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/^import .*;\r?$/gm, "").replace(/^export /gm, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const interaction = new Function(`${transpile("../src/components/explorer/treeInteraction.ts")}\nreturn { selectTreeNode, activateTreeFile };`)();
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
  const calls = [];
  const actions = { serial: "phone", disabled: false, remove: entries => calls.push(["remove", entries.map(entry => entry.path)]), dragOver: (_event, directory) => calls.push(["over", directory]), drop: (_event, directory) => calls.push(["drop", directory]) };
  const render = new Function("React", "createContext", "useContext", "ContextMenu", "FileIcon", "ChevronRight", "selectTreeNode", "activateTreeFile", "ANDROID_FILE_TYPE",
    `${transpile("../src/components/editor/AndroidFileManager.tsx")}\nreturn AndroidFileNode;`)
    (React, () => ({}), () => actions, { Root: "menu", Trigger: "trigger", Portal: "portal", Content: "content", Item: "item" }, "FileIcon", "ChevronRight", interaction.selectTreeNode, interaction.activateTreeFile, "application/x-nexusdesk-android-files");
  const data = { name: "a.txt", path: "/sdcard/folder/a.txt", is_dir: false };
  const node = { id: data.path, data, isLeaf: true, isSelected: true, tree: { props: {}, selectedNodes: [{ data }, { data: { path: "/sdcard/b.txt" } }] }, select: () => calls.push("select"), activate: () => calls.push("activate") };
  const rendered = render({ node, style: {} });
  const flatten = element => element && typeof element === "object" ? [element, ...(element.children ?? []).flatMap(flatten)] : [];
  const row = flatten(rendered).find(element => element.type === "div" && element.props.title === data.path);
  const event = { stopPropagation() {} };
  row.props.onClick(event);
  assert.deepEqual(calls, ["select"]);
  row.props.onDoubleClick(event);
  assert.deepEqual(calls, ["select", "activate"]);
  const dragData = {};
  const dataTransfer = { setData: (type, value) => { dragData[type] = value; } };
  row.props.onDragStart({ ...event, dataTransfer });
  assert.equal(dataTransfer.effectAllowed, "copy");
  assert.deepEqual(JSON.parse(dragData["application/x-nexusdesk-android-files"]), { serial: "phone", paths: [data.path, "/sdcard/b.txt"] });
  row.props.onDragOver(event); row.props.onDrop(event);
  assert.deepEqual(calls.slice(-2), [["over", "/sdcard/folder"], ["drop", "/sdcard/folder"]]);
  const deletion = flatten(rendered).find(element => element.type === "item" && element.children.includes("删除 "));
  deletion.props.onSelect();
  assert.deepEqual(calls.at(-1), ["remove", [data.path, "/sdcard/b.txt"]]);
});
