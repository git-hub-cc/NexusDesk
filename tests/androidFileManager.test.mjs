import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8")
  .replace(/^import .*;\r?$/gm, "").replace(/^export /gm, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
const flatten = node => Array.isArray(node) ? node.flatMap(flatten)
  : node && typeof node === "object" ? [node, ...flatten(node.children)] : [];
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ confirmed = true, failDelete = false } = {}) {
  const states = [], refs = [], calls = [], tabs = [], confirmations = [];
  let si = 0, ri = 0;
  const bindings = {
    React, createContext: () => ({ Provider: "provider" }), useEffect() {},
    useState: initial => {
      const i = si++; if (!(i in states)) states[i] = initial;
      return [states[i], next => { states[i] = typeof next === "function" ? next(states[i]) : next; }];
    },
    useRef: initial => refs[ri++] ??= { current: initial },
    useElementSize: () => [null, { width: 300, height: 600 }],
    useDeleteConfirmation: () => ({ confirmDelete: async request => { confirmations.push(request); return confirmed; }, confirmationDialog: null }),
    useWorkspaceStore: { getState: () => ({ openTab: tab => tabs.push(tab) }) },
    CreateNameDialog: "create-name-dialog", validateEntryName: () => undefined,
    isImage: path => /\.(png|svg)$/i.test(path),
    topLevelPaths: paths => paths.filter(path => !paths.some(parent => parent !== path && path.startsWith(parent + "/"))),
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "mirror_delete_files" && failDelete) throw new Error("permission denied");
      if (command === "mirror_list_files") return [];
      return command === "mirror_read_image" ? "data:image/png;base64,AP+A" : "<svg/>";
    },
    ContextMenu: { Root: "menu", Trigger: "trigger", Portal: "portal", Content: "content", Item: "item" },
    ArrowUp: "up", ChevronRight: "right", FolderPlus: "folder-plus", RefreshCw: "refresh", X: "close", Tree: "tree",
  };
  const Component = new Function(...Object.keys(bindings), `${compile("../src/components/editor/AndroidFileManager.tsx")}\nreturn AndroidFileManager;`)(...Object.values(bindings));
  const render = () => { si = ri = 0; return flatten(Component({ serial: "phone", onClose() {} })); };
  const actions = () => render().find(node => node.type === "provider").props.value;
  return { render, actions, calls, tabs, confirmations };
}

test("Android images open with image data while SVG keeps editable source text", async () => {
  const h = harness();
  for (const name of ["中文.png", "icon.svg"]) {
    h.render().find(node => node.type === "tree").props.onActivate({ data: { name, path: `/sdcard/${name}`, is_dir: false } });
    await tick();
  }
  assert.deepEqual(h.calls.map(call => call.command), ["mirror_read_image", "mirror_read_file"]);
  assert.equal(h.tabs[0].content, "data:image/png;base64,AP+A");
  assert.equal(h.tabs[0].path, "android://phone/sdcard/中文.png");
  assert.equal(h.tabs[1].content, "<svg/>");
});

test("cancelling deletion sends no device command", async () => {
  const h = harness({ confirmed: false });
  h.actions().remove([{ path: "/sdcard/a" }]);
  await tick();
  assert.equal(h.confirmations[0].permanent, true);
  assert.deepEqual(h.calls, []);
});

test("confirmed deletion prunes nested selections and refreshes after success or failure", async () => {
  for (const failDelete of [false, true]) {
    const h = harness({ failDelete });
    const entries = ["/sdcard/a", "/sdcard/a/child", "/sdcard/b"].map(path => ({ path }));
    const select = () => h.render().find(node => node.type === "tree").props.onSelect(entries.map(data => ({ data })));
    select();
    h.render().find(node => node.props.tabIndex === 0).props.onKeyDown({ key: "Delete", preventDefault() {}, stopPropagation() {} });
    await tick();
    assert.deepEqual(h.calls[0], { command: "mirror_delete_files", args: { serial: "phone", paths: ["/sdcard/a", "/sdcard/b"] } });
    assert.deepEqual(h.calls[1], { command: "mirror_list_files", args: { serial: "phone", path: "/sdcard" } });
    if (failDelete) assert.match(h.render().find(node => node.props.role === "alert").children.join(""), /permission denied/);
  }
});

test("creating an Android folder invokes the device command and refreshes the current directory", async () => {
  const h = harness();
  const toolbar = h.render().find(node => node.props["aria-label"] === "新建文件夹");
  toolbar.props.onClick();
  await h.render().find(node => node.type === "create-name-dialog").props.onCreate("Notes");
  await tick();
  assert.deepEqual(h.calls.slice(-2), [
    { command: "mirror_create_folder", args: { serial: "phone", parent: "/sdcard", name: "Notes" } },
    { command: "mirror_list_files", args: { serial: "phone", path: "/sdcard" } },
  ]);
});
