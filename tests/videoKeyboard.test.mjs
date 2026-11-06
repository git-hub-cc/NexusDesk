import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("video keyboard selects filtered entries and toggles playback without changing progress", () => {
  const source = readFileSync(new URL("../src/components/video/VideoEditor.tsx", import.meta.url), "utf8");
  const keyboard = source.slice(source.indexOf("  const selectedVideo ="), source.indexOf("  const download ="));
  const compiled = ts.transpileModule(keyboard, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let listener;
  let cleanup;
  const videos = [{ path: "a.mp4" }, { path: "b.mp4" }, { path: "c.mp4" }];
  const state = { active: true, filtered: videos, selection: null, current: null, playRequest: 0 };
  let focused = 0;
  const scrolled = [];
  const media = { paused: false, ended: false, currentTime: 42, pause() { this.paused = true; } };
  class Element {
    constructor(kind = "list") { this.kind = kind; }
    closest(selector) {
      if (selector.startsWith("input")) return ["input", "dialog"].includes(this.kind) ? this : null;
      if (selector.startsWith("button")) return ["select", "action"].includes(this.kind) ? this : null;
      return selector === ".video-row-select" && this.kind === "select" ? this : null;
    }
  }
  const bindings = {
    Element,
    useEffect(fn) { cleanup = fn(); },
    window: {
      addEventListener(_type, fn) { listener = fn; },
      removeEventListener(_type, fn) { if (listener === fn) listener = null; },
    },
    listRef: { current: {
      focus() { focused++; },
      querySelectorAll() { return state.filtered.map(video => ({ scrollIntoView() { scrolled.push(video.path); } })); },
    } },
    playerRef: { current: { querySelector: () => media } },
    videoWindow: { scrollToIndex(index) { scrolled.push(state.filtered[index].path); } },
    setSelection(value) { state.selection = value; },
    setCurrent(value) { state.current = value; },
    setPlayRequest(fn) { state.playRequest = fn(state.playRequest); },
  };
  const render = () => {
    cleanup?.();
    const values = { ...state, ...bindings };
    new Function(...Object.keys(values), compiled)(...Object.values(values));
  };
  const press = (key, options = {}) => {
    const event = { key, target: new Element(), preventDefault() { this.prevented = true; }, stopPropagation() {}, ...options };
    listener?.(event);
    render();
    return event;
  };
  render();
  press("ArrowDown");
  assert.equal(state.selection, "a.mp4");
  press("ArrowDown");
  assert.equal(state.selection, "b.mp4");
  assert.equal(state.current, null, "moving selection does not start playback");
  assert.equal(focused, 2);
  assert.deepEqual(scrolled, ["a.mp4", "b.mp4"]);
  press("Enter");
  assert.equal(state.current.path, "b.mp4");
  assert.equal(state.playRequest, 1);
  press("Enter");
  assert.equal(media.paused, true);
  assert.equal(media.currentTime, 42);
  press("Enter");
  assert.equal(state.playRequest, 2, "paused video requests playback through AssetVideo");
  press("Enter", { repeat: true });
  assert.equal(state.playRequest, 2);
  for (const kind of ["input", "dialog", "action"]) {
    assert.equal(press("ArrowDown", { target: new Element(kind) }).prevented, undefined);
    assert.equal(press("Enter", { target: new Element(kind) }).prevented, undefined);
  }
  for (const modifier of ["isComposing", "altKey", "ctrlKey", "metaKey", "shiftKey", "defaultPrevented"]) {
    assert.equal(press("ArrowDown", { [modifier]: true }).prevented, undefined);
  }
  press("ArrowDown", { target: new Element("select") });
  assert.equal(state.selection, "c.mp4");
  press("ArrowDown");
  assert.equal(state.selection, "c.mp4", "selection stops at the list boundary");
  state.filtered = [videos[0]];
  render();
  press("Enter");
  assert.equal(state.current.path, "a.mp4", "searching limits the keyboard selection");
  state.selection = null;
  state.current = null;
  state.filtered = videos;
  render();
  press("ArrowUp");
  assert.equal(state.selection, "c.mp4");
  state.filtered = [];
  render();
  assert.equal(press("Enter").prevented, undefined);
  state.active = false;
  render();
  assert.equal(listener, null, "inactive pages remove their keyboard listener");
});
