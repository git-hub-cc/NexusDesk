import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import React from "react";
import vm from "node:vm";
import { moduleUrl } from "./helpers/loadSource.mjs";

const panelSizing = await import(moduleUrl("utils/workspacePanelSizing.ts"));

test("settings overlay preserves the workspace tree and browser component positions", () => {
  let settingsOpen = false;
  const component = name => Object.assign(() => null, { displayName: name });
  const names = ["Bot", "Cloud", "Terminal", "GitBranch", "Mic", "Package", "X", "Panel", "PanelGroup", "PanelResizeHandle", "DndContext", "PointerSensor", "DragOverlay", "WindowTitleBar", "ActivityBar", "Sidebar", "BottomPanel", "TabUI", "EditorGroupPanel", "RelationalView", "GitSettings", "CodexSettings", "SpeechRecognitionSettings", "SoftwareSettings"];
  const components = Object.fromEntries(names.map(name => [name, component(name)]));
  const context = {
    ...components, React, forwardRef: React.forwardRef, AndroidMirrorWorkspace: component("AndroidMirrorWorkspace"),
    openAiIcon: "openai.svg",
    Dialog: Object.fromEntries(["Root", "Portal", "Overlay", "Content", "Title", "Close", "Description"].map(name => [name, component(`Dialog.${name}`)])),
    useState: initial => [typeof initial === "boolean" ? settingsOpen : initial, () => {}],
    useEffect: () => {}, useLayoutEffect: () => {}, useRef: () => ({ current: null }),
    ...panelSizing,
    useSensors: () => [], useSensor: () => {}, closestCenter: () => {},
    useLayoutStore: () => ({ leftSidebarVisible: true, rightSidebarVisible: true, bottomPanelVisible: true }),
    useWorkspaceStore: selector => selector({ isSplitMode: false }),
  };
  const shellSource = readFileSync(new URL("../src/components/DialogShell.tsx", import.meta.url), "utf8")
    .replace(/^import .*;\r?$/gm, "").replace("export const DialogShell", "const DialogShell");
  vm.runInNewContext(ts.transpileModule(shellSource + "\nglobalThis.DialogShell = DialogShell;", {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
  const source = readFileSync(new URL("../src/components/layout/Workspace.tsx", import.meta.url), "utf8")
    .replace(/^import .*;\r?$/gm, "").replace("export const Workspace", "const Workspace");
  const compiled = ts.transpileModule(source + "\nglobalThis.render = Workspace;", {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  vm.runInNewContext(compiled, context);
  const positions = (node, type, path = "root") => {
    if (!React.isValidElement(node)) return [];
    return [
      ...(node.type === type ? [path] : []),
      ...React.Children.toArray(node.props.children).flatMap((child, index) => positions(child, type, `${path}/${index}`)),
    ];
  };
  const closed = context.render();
  settingsOpen = true;
  const opened = context.render();
  for (const name of ["PanelGroup", "EditorGroupPanel", "BottomPanel", "Sidebar", "RelationalView"]) {
    const before = positions(closed, components[name]);
    assert.ok(before.length, `${name} is mounted`);
    assert.deepEqual(positions(opened, components[name]), before, `${name} retains its position when settings opens`);
  }
  assert.equal(positions(opened, context.DialogShell).length, 1);
  const shell = context.DialogShell.render({ purpose: "settings" }, null);
  assert.equal(positions(shell, context.Dialog.Content).length, 1);
  assert.equal(positions(shell, context.Dialog.Overlay).length, 1);
  const content = React.Children.toArray(shell.props.children).find(child => child.type === context.Dialog.Content);
  assert.equal(content.props["data-purpose"], "settings");
  let stopped = false;
  content.props.onKeyDown({ stopPropagation() { stopped = true; } });
  assert.ok(stopped, "dialog keys do not reach workspace shortcuts");
});
