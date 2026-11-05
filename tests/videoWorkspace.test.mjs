import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("music and video pages follow the active browser tab when switching in either direction", () => {
  const source = readFileSync(new URL("../src/components/editor/BrowserEditor.tsx", import.meta.url), "utf8");
  const router = source.slice(source.indexOf("export function BrowserEditor"), source.indexOf("function NavigationEditor"))
    .replace("export function", "function");
  const compiled = ts.transpileModule(router, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const React = { createElement: (type, props) => ({ type, props }) };
  const render = new Function("React", "MUSIC_HOME", "VIDEO_HOME", "MusicEditor", "VideoEditor",
    `${compiled}\nreturn BrowserEditor;`)(React, "nexusdesk:music", "nexusdesk:video", "MusicEditor", "VideoEditor");
  const tabs = [
    { id: "music", browser: { url: "nexusdesk:music" } },
    { id: "video", browser: { url: "nexusdesk:video" } },
  ];
  for (const activeId of ["music", "video", "music", "video"]) {
    const pages = tabs.map(tab => render({ tab, active: tab.id === activeId }));
    assert.deepEqual(pages.map(page => page.type), ["MusicEditor", "VideoEditor"]);
    assert.deepEqual(pages.map(page => page.props.active), tabs.map(tab => tab.id === activeId));
  }
});

test("workspace preserves media and browser component identity when opening and closing a split", async () => {
  const state = {
    isSplitMode: false, activeLeftTabId: "video", activeRightTabId: "right-video",
    leftTabs: [{ id: "video", path: "a.mp4" }, { id: "note", path: "a.md" },
      { id: "music", path: "browser:music", browser: { url: "nexusdesk:music" } },
      { id: "website", path: "browser:website", browser: { url: "https://example.com/" } }],
    rightTabs: [{ id: "right-video", path: "b.mp4" }], setFocusedPane() {},
  };
  const bindings = {
    MIRROR_HOME: "nexusdesk:mirror", AndroidMirrorWorkspace: "AndroidMirrorWorkspace",
    openAiIcon: "openai.svg",
    React: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) },
    useEffect() {}, useLayoutEffect() {}, useRef: () => ({ current: null }), useState: () => [null, () => {}],
    sidebarMaxSize: 80,
    useDroppable: () => ({}), useSensor() {}, useSensors() {},
    useLayoutStore: () => ({}), useWorkspaceStore: selector => selector ? selector(state) : state,
    useShallow: selector => selector,
    isVideo: path => path.endsWith(".mp4"),
    isImage: () => false,
    Dialog: Object.fromEntries(["Root", "Portal", "Overlay", "Content", "Title", "Close", "Description"].map(name => [name, `Dialog.${name}`])),
  };
  for (const name of ["Bot", "Mic", "Package", "Panel", "PanelGroup", "PanelResizeHandle", "DndContext", "PointerSensor", "closestCenter", "DragOverlay", "Sidebar", "BottomPanel", "EditorTabs", "TabUI", "MarkdownEditor", "RelationalView", "VideoTabPreview", "BrowserEditor", "WindowTitleBar", "ActivityBar", "GitSettings", "CodexSettings", "SpeechRecognitionSettings", "SoftwareSettings", "GitBranch", "X"]) bindings[name] = name;
  globalThis.__workspaceVideoTest = bindings;
  const load = async path => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8").replace(/^import .*;\r?$/gm, "");
    const compiled = ts.transpileModule(`const { ${Object.keys(bindings).join(", ")} } = globalThis.__workspaceVideoTest;\n${source}`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
    return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  };
  const { EditorGroupPanel } = await load("../src/components/editor/EditorGroupPanel.tsx");
  bindings.EditorGroupPanel = EditorGroupPanel;
  const { Workspace } = await load("../src/components/layout/Workspace.tsx");
  const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === "object" ? [node, ...flatten(node.children)] : [];
  // React retains an instance only if its type and key/position, and those of
  // every ancestor, survive reconciliation. A stable tab key alone is insufficient.
  const identityPath = (node, matches, path = []) => {
    if (!node || typeof node !== "object") return undefined;
    if (matches(node)) return path;
    const children = (node.children ?? []).flat(Infinity);
    for (const [index, child] of children.entries()) {
      const result = identityPath(child, matches, [...path, [child?.type, child?.props?.key ?? index]]);
      if (result) return result;
    }
  };
  let originalLeftPath;
  let originalBrowserPaths;
  for (const split of [false, true, false, true]) {
    state.isSplitMode = split;
    const workspace = Workspace();
    const groups = flatten(workspace).filter(node => node.type === EditorGroupPanel);
    assert.deepEqual(groups.map(node => node.props.groupId), split ? ["left", "right"] : ["left"]);
    const leftPath = identityPath(workspace, node => node.type === EditorGroupPanel && node.props.groupId === "left");
    assert.ok(leftPath);
    originalLeftPath ??= leftPath;
    assert.deepEqual(leftPath, originalLeftPath, "split toggles must preserve every ancestor of the playing media");
    const leftTree = EditorGroupPanel({ groupId: "left" });
    const browserPaths = ["music", "website"].map(id => identityPath(leftTree, node => node.type === "BrowserEditor" && node.props.tab.id === id));
    assert.ok(browserPaths.every(Boolean));
    originalBrowserPaths ??= browserPaths;
    assert.deepEqual(browserPaths, originalBrowserPaths);
    const renderLeft = () => flatten(EditorGroupPanel({ groupId: "left" }));
    state.activeLeftTabId = "video";
    const before = renderLeft().find(node => node.type === "VideoTabPreview");
    assert.equal(before.props.active, true);
    state.activeLeftTabId = "note";
    const after = renderLeft().find(node => node.type === "VideoTabPreview");
    assert.equal(after.props.key, before.props.key);
    assert.equal(after.props.active, false);
    assert.equal(after.props.tab, before.props.tab);
    state.activeLeftTabId = "video";
    assert.equal(renderLeft().find(node => node.type === "VideoTabPreview").props.active, true);
  }
  state.leftTabs = state.leftTabs.filter(tab => tab.id !== "video");
  assert.equal(flatten(EditorGroupPanel({ groupId: "left" })).some(node => node.type === "VideoTabPreview"), false);
  delete globalThis.__workspaceVideoTest;
});
