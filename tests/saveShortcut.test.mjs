import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("save shortcut prevents native saving on Windows and macOS and ignores composition", async () => {
  let handler;
  let saves = 0;
  let platform = "Win32";
  const focused = {};
  globalThis.__saveShortcut = {
    useEffect: fn => fn(), useRef: value => ({ current: value }),
    useLayoutStore: () => ({ toggleLeftSidebar() {} }),
    useWorkspaceStore: { getState() { throw new Error("Save must not navigate"); } },
    flushPendingWrites: async () => { saves++; },
    navigator: { get platform() { return platform; } },
    window: { addEventListener: (_name, fn) => { handler = fn; }, removeEventListener() {} },
  };
  try {
    const source = readFileSync(new URL("../src/hooks/useShortcuts.ts", import.meta.url), "utf8").replace(/^import .*;$/gm, "");
    const compiled = ts.transpileModule("const { useEffect, useRef, useLayoutStore, useWorkspaceStore, flushPendingWrites, navigator, window } = globalThis.__saveShortcut;\n" + source,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const { useShortcuts } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
    useShortcuts(() => {}, () => {});
    for (const mac of [false, true]) {
      platform = mac ? "MacIntel" : "Win32";
      let prevented = false;
      handler({ key: "s", ctrlKey: !mac, metaKey: mac, preventDefault() { prevented = true; }, target: focused });
      assert.equal(prevented, true);
    }
    assert.equal(saves, 2);
    handler({ key: "s", ctrlKey: true, isComposing: true });
    assert.equal(saves, 2);
  } finally {
    delete globalThis.__saveShortcut;
  }
});
