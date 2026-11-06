import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const markdown = readFileSync(new URL("../src/components/editor/MarkdownEditor.tsx", import.meta.url), "utf8");
const editor = readFileSync(new URL("../src/components/editor/CodeMirrorEditor.tsx", import.meta.url), "utf8");

function previewHarness() {
  let cleanup;
  const state = { rootPath: "project-a", leftTabs: [{ id: "a" }, { id: "b" }], rightTabs: [{ id: "a" }] };
  const disk = new Map();
  const positions = readFileSync(new URL("../src/components/editor/previewPositions.ts", import.meta.url), "utf8").replace(/^import .*;$/gm, "").replace("export const", "const");
  const source = positions + markdown.slice(markdown.indexOf("function MarkdownPreviewPane("), markdown.indexOf("const MarkdownPreview ="));
  const context = {
    React: { createElement() {} },
    useLayoutEffect: setup => { cleanup = setup(); },
    useWorkspaceStore: { getState: () => state },
    window: new EventTarget(),
    readUI: (root, category) => disk.get(`${root}:${category}`),
    writeUI: (root, category, value) => disk.set(`${root}:${category}`, value),
  };
  vm.runInNewContext(ts.transpile(source + "\nglobalThis.mount = MarkdownPreviewPane;", { jsx: ts.JsxEmit.React }), context);
  return {
    state,
    mount(pane, tabId) {
      const element = { scrollTop: 0, scrollLeft: 0 };
      context.mount({ pane, tabId, previewRef: { current: element } });
      return { element, unmount: cleanup };
    },
  };
}

test("Markdown tabs restore independent vertical and horizontal reading positions", () => {
  const harness = previewHarness();
  const a = harness.mount("left", "a");
  a.element.scrollTop = 1200;
  a.element.scrollLeft = 80;
  a.unmount();
  const b = harness.mount("left", "b");
  assert.equal(b.element.scrollTop, 0);
  b.element.scrollTop = 300;
  b.unmount();
  const restored = harness.mount("left", "a");
  assert.equal(restored.element.scrollTop, 1200);
  assert.equal(restored.element.scrollLeft, 80);
  restored.unmount();
  assert.equal(harness.mount("left", "b").element.scrollTop, 300);
});

test("preview positions survive media tabs and remain independent between panes", () => {
  const harness = previewHarness();
  const left = harness.mount("left", "a");
  left.element.scrollTop = 900;
  left.unmount();
  const right = harness.mount("right", "a");
  assert.equal(right.element.scrollTop, 0);
  right.element.scrollTop = 200;
  right.unmount();
  assert.equal(harness.mount("left", "a").element.scrollTop, 900);
  assert.equal(harness.mount("right", "a").element.scrollTop, 200);
});

test("closed previews retain their saved positions before reopening", () => {
  const harness = previewHarness();
  const a = harness.mount("left", "a");
  a.element.scrollTop = 600;
  harness.state.leftTabs = [{ id: "b" }];
  a.unmount();
  harness.state.leftTabs.push({ id: "a" });
  assert.equal(harness.mount("left", "a").element.scrollTop, 600);
});

test("preview reading positions stay isolated when projects share tab IDs", () => {
  const harness = previewHarness();
  const a = harness.mount("left", "a");
  a.element.scrollTop = 750;
  harness.state.rootPath = "project-b";
  a.unmount(); // Capture with the outgoing project's namespace.
  assert.equal(harness.mount("left", "a").element.scrollTop, 0);
  harness.state.rootPath = "project-a";
  assert.equal(harness.mount("left", "a").element.scrollTop, 750);
});

test("source location is captured on tab change before the outgoing DOM is hidden", () => {
  let listener;
  let saved;
  const view = { top: 1000, anchor: 2300 };
  const start = editor.indexOf("const unsubscribeLocation =");
  const source = editor.slice(start, editor.indexOf("    const snapshotLocation", start));
  vm.runInNewContext(source, {
    pane: "left", view, previousTabId: { current: "a" },
    useWorkspaceStore: { subscribe: callback => { listener = callback; } },
    saveLocation: (pane, id, view) => { saved = { pane, id, ...view }; },
  });
  listener({ activeLeftTabId: "b" }, { activeLeftTabId: "a" });
  view.top = 0; // React hides/removes the old editor after the store notification.
  assert.deepEqual(saved, { pane: "left", id: "a", top: 1000, anchor: 2300 });
  saved = undefined;
  listener({ activeLeftTabId: "b" }, { activeLeftTabId: "b" });
  assert.equal(saved, undefined, "autosave updates must not overwrite the cached location");
  listener({ activeLeftTabId: "c" }, { activeLeftTabId: "b" });
  assert.equal(saved, undefined, "background editors must not capture another tab's location");
});

function textTabHarness() {
  const source = readFileSync(new URL("../src/components/editor/EditorGroupPanel.tsx", import.meta.url), "utf8")
    .replace(/^import .*;\r?$/gm, "").replace("export const EditorGroupPanel", "const EditorGroupPanel");
  const refs = new Map();
  let rendering;
  const state = {
    leftTabs: ["txt", "ts", "json", "md", "html", "svg", "http", "rest"].map(ext => ({ id: ext, path: `file.${ext}` })),
    rightTabs: [], activeLeftTabId: "txt", activeRightTabId: null, setFocusedPane() {},
  };
  state.leftTabs.push({ id: "history", path: "old.txt", revision: "abc123" },
    { id: "diff", path: "file.txt", diff: "patch" }, { id: "video", path: "video.mp4" },
    { id: "image", path: "image.png" }, { id: "web", path: "browser", browser: {} });
  const context = {
    React: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) },
    MIRROR_HOME: "nexusdesk:mirror",
    MarkdownEditor: "MarkdownEditor", HttpEditor: "HttpEditor", BrowserEditor: "BrowserEditor",
    VideoTabPreview: "VideoTabPreview", ImageEditor: "ImageEditor",
    useRef: value => {
      if (!refs.has(rendering)) refs.set(rendering, { current: value });
      return refs.get(rendering);
    },
    useShallow: selector => selector, useDroppable: () => ({}),
    useWorkspaceStore: selector => selector(state),
    isImage: path => /\.(png|svg)$/.test(path), isVideo: path => path.endsWith(".mp4"),
  };
  vm.runInNewContext(ts.transpile(source + "\nglobalThis.group = EditorGroupPanel; globalThis.panel = TextTabPanel;", { jsx: ts.JsxEmit.React }), context);
  const flatten = node => Array.isArray(node) ? node.flatMap(flatten)
    : node && typeof node === "object" ? [node, ...flatten(node.children)] : [];
  return {
    state,
    panels() { return flatten(context.group({ groupId: "left" })).filter(node => node.type === context.panel); },
    render(node) { rendering = node.props.tab.id; return context.panel(node.props); },
  };
}

test("all text formats retain the same editor identity across text, media and browser tabs", () => {
  const harness = textTabHarness();
  const original = harness.panels();
  assert.deepEqual(original.map(node => node.props.tab.id), ["txt", "ts", "json", "md", "html", "svg", "http", "rest", "history", "diff"]);
  for (const tab of original) {
    harness.state.activeLeftTabId = tab.props.tab.id;
    const active = harness.panels().find(node => node.props.tab.id === tab.props.tab.id);
    const view = harness.render(active);
    assert.equal(view.props.style.visibility, "visible");
    assert.equal(view.props.inert, false);
    const editor = view.children[0];
    if (editor.type === "MarkdownEditor") assert.equal(editor.props.tabId, tab.props.tab.id);
    else assert.equal(editor.props.tab.id, tab.props.tab.id);
    for (const next of ["ts", "video", "image", "web"]) {
      harness.state.activeLeftTabId = next;
      const retained = harness.panels().find(node => node.props.tab.id === tab.props.tab.id);
      assert.equal(retained.type, active.type);
      assert.equal(retained.props.key, active.props.key);
      const hidden = harness.render(retained);
      assert.equal(hidden.children[0].type, editor.type);
      assert.equal(hidden.props.style.visibility, next === tab.props.tab.id ? "visible" : "hidden");
      assert.equal(hidden.props.style.display, next === tab.props.tab.id ? "block" : "none");
    }
  }
  harness.state.leftTabs = harness.state.leftTabs.filter(tab => tab.id !== "txt");
  assert.equal(harness.panels().some(node => node.props.tab.id === "txt"), false);
});

test("unvisited text tabs allocate their editor only when first opened", () => {
  const harness = textTabHarness();
  const initial = harness.panels().find(node => node.props.tab.id === "json");
  assert.equal(harness.render(initial), null);
  harness.state.activeLeftTabId = "json";
  assert.ok(harness.render(harness.panels().find(node => node.props.tab.id === "json")));
  harness.state.activeLeftTabId = "txt";
  assert.ok(harness.render(harness.panels().find(node => node.props.tab.id === "json")));
});

test("source editors stay bound to their own document when the active tab changes", () => {
  const ast = ts.createSourceFile("CodeMirrorEditor.tsx", editor, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = [];
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ["activeTabId", "activeTab"].includes(node.name.getText(ast))) declarations.push(node.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const state = { leftTabs: [{ id: "source", path: "source.ts", content: "original" }, { id: "other", content: "other" }], activeLeftTabId: "other" };
  const context = { tabId: "source", pane: "left", useWorkspaceStore: selector => selector(state) };
  vm.runInNewContext(declarations.map(text => `var ${text};`).join("\n"), context);
  assert.equal(context.activeTabId, "source");
  assert.equal(context.activeTab.content, "original");
});

test("source snapshots preserve a scrolled viewport even with the cursor at the start", () => {
  const source = editor.slice(editor.indexOf("function saveLocation("), editor.indexOf("export const CodeMirrorEditor"));
  const positions = { left: new Map(), right: new Map() };
  const state = { rootPath: "project", leftTabs: [{ id: "code" }], rightTabs: [] };
  let persisted;
  const context = { paneLocations: positions, useWorkspaceStore: { getState: () => state },
    projectKey: value => value, writeUI: (root, key, value) => { persisted = value; } };
  vm.runInNewContext(ts.transpile(source), context);
  const snapshot = { top: 3500, left: 400 };
  context.saveLocation("left", "code", { state: { selection: { main: { anchor: 0, head: 0 } } }, scrollSnapshot: () => snapshot,
    scrollDOM: { scrollTop: 3500, scrollLeft: 400 } });
  assert.equal(positions.left.get("project:code").scroll, snapshot);
  assert.equal(positions.left.get("project:code").anchor, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(persisted)), { anchor: 0, head: 0, top: 3500, left: 400 });
});
