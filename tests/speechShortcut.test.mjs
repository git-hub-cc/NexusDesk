import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import React from "react";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/layout/ActivityBar.tsx", import.meta.url), "utf8")
  .replace(/^import .*;\r?$/gm, "").replace("export function ActivityBar", "function ActivityBar");
const compiled = ts.transpileModule(source + "\nglobalThis.render = ActivityBar;", {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function setup({ native = true, pending = false, target = null } = {}) {
  const window = new EventTarget();
  let cleanup;
  let callback;
  let resolve;
  let stops = 0;
  let registrations = 0;
  let speechOpen = false;
  const refs = [];
  let toggles = 0;
  let closes = 0;
  window.addEventListener("noteide-speech-toggle", () => { toggles++; });
  window.addEventListener("noteide-speech-close", () => { closes++; speechOpen = false; });
  const context = {
    React, window, CustomEvent, console,
    FolderTree: "FolderTree", PanelRight: "PanelRight", PanelBottom: "PanelBottom",
    Settings: "Settings", Mic: "Mic", Dialog: { Trigger: "Trigger" }, SpeechToText: "SpeechToText",
    useState: () => [speechOpen, update => { speechOpen = typeof update === "function" ? update(speechOpen) : update; }],
    useRef: value => { const ref = { current: value }; refs.push(ref); return ref; },
    useEffect: effect => { cleanup = effect(); },
    useLayoutStore: () => ({}),
    getSpeechTarget: () => target,
    setSpeechTarget: value => { target = value; },
    isTauri: () => native,
    getCurrentWindow: () => ({
      listen: (name, handler) => {
        assert.equal(name, "noteide-speech-toggle");
        registrations++;
        callback = handler;
        const subscription = new Promise(done => { resolve = () => done(() => { stops++; }); });
        if (!pending) resolve();
        return subscription;
      },
    }),
  };
  vm.runInNewContext(compiled, context);
  context.render({ settingsOpen: false, onLeaveSettings() {} });
  return {
    window, cleanup: () => cleanup(), emit: payload => callback({ payload }), resolve: () => resolve(),
    get open() { return speechOpen; }, get stops() { return stops; },
    get registrations() { return registrations; }, get toggles() { return toggles; }, get closes() { return closes; },
  };
}

test("native speech shortcut toggles the workspace panel", async () => {
  const env = setup();
  await Promise.resolve();
  env.emit();
  assert.equal(env.open, false);
  assert.equal(env.closes, 1);
  env.emit();
  assert.equal(env.open, true);
  assert.equal(env.toggles, 2);
  env.cleanup();
  assert.equal(env.stops, 1);
  env.emit();
  assert.equal(env.toggles, 2);
});

test("late native subscription is released after unmount and ignores stale events", async () => {
  const env = setup({ pending: true });
  env.cleanup();
  env.emit();
  env.resolve();
  await Promise.resolve();
  assert.equal(env.stops, 1);
  assert.equal(env.toggles, 0);
  assert.equal(env.open, false);
});

test("external dictation stops the workspace session without toggling it open", () => {
  const env = setup();
  env.emit();
  assert.equal(env.open, true);
  env.emit({ stop: true });
  assert.equal(env.open, false);
  assert.equal(env.toggles, 1);
  env.emit({ stop: true });
  assert.equal(env.open, false);
  env.cleanup();
});

test("browser preview handles shortcut events without registering a native listener", () => {
  const env = setup({ native: false });
  assert.equal(env.registrations, 0);
  env.window.dispatchEvent(new CustomEvent("noteide-speech-toggle"));
  assert.equal(env.open, true);
  env.cleanup();
});

test("workspace handles Git speech while editor and terminal retain their own panels", () => {
  for (const [target, opens] of [[{ kind: "git" }, true], [{ kind: "editor", pane: "left" }, false], [{ kind: "terminal" }, false]]) {
    const env = setup({ native: false, target });
    env.window.dispatchEvent(new CustomEvent("noteide-speech-toggle"));
    assert.equal(env.open, opens);
    env.cleanup();
  }
});
