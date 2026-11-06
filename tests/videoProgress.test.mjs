import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("video progress survives StrictMode setup, tab switches and interrupted restoration", async () => {
  let setup;
  let playbackEffect;
  let visibilityEffect;
  const activeRef = { current: true };
  const host = { child: null, replaceChildren(child) { this.child = child; }, querySelector() { return this.child; } };
  const players = [];
  class Media extends EventTarget {
    readyState = 0;
    duration = 120;
    currentTime = 0;
    seeking = false;
    paused = false;
    playCalls = 0;
    async play() { this.playCalls++; this.paused = false; this.dispatchEvent(new Event("play")); }
    pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
    metadata() { this.readyState = 1; this.dispatchEvent(new Event("loadedmetadata")); }
    frame() { this.readyState = 2; this.dispatchEvent(new Event("seeked")); this.dispatchEvent(new Event("loadeddata")); }
  }
  class Player {
    constructor(media) { this.media = media; players.push(this); }
    destroy() {
      this.media.currentTime = 0;
      this.media.dispatchEvent(new Event("timeupdate"));
      host.replaceChildren(new Media()); // Actual Plyr replaces the original node.
    }
  }
  globalThis.__videoTest = {
    useRef: initial => initial === null ? { current: host } : activeRef, useState: () => [false, () => {}],
    useEffect: fn => { playbackEffect = visibilityEffect; visibilityEffect = fn; },
    useMemo: fn => fn(), useLayoutEffect: fn => { setup = fn; },
    resolveAsset: (_note, source) => source, convertFileSrc: path => `asset:${path}`,
    Plyr: Player, document: { createElement: () => new Media() },
    HTMLMediaElement: { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 },
  };
  const text = readFileSync(new URL("../src/components/editor/MarkdownEditor.tsx", import.meta.url), "utf8");
  const component = text.slice(text.indexOf("function AssetVideo("), text.indexOf("\nconst modes ="));
  const compiled = ts.transpileModule(
    `const { ${Object.keys(globalThis.__videoTest).join(", ")} } = globalThis.__videoTest; const videoProgress = new Map(); export ${component}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } },
  ).outputText;
  // The returned JSX is irrelevant to this lifecycle test; effects use the host above.
  globalThis.React = { createElement: () => null };
  const { AssetVideo } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  const open = source => { AssetVideo({ source, note: source }); return setup(); };
  let cleanup = open("a.mp4");
  const first = host.child;
  cleanup();
  cleanup = setup(); // StrictMode replays the effect without rendering again.
  assert.notEqual(host.child, first);
  assert.equal(players.at(-1).media, host.child);
  host.child.metadata(); host.child.frame();
  host.child.currentTime = 37.5;
  const media = host.child;
  const playerCount = players.length;
  globalThis.__videoTest.document.pictureInPictureElement = media;
  AssetVideo({ source: "a.mp4", note: "a.mp4", active: false });
  visibilityEffect();
  assert.equal(media.paused, false, "PiP continues playing in an inactive tab");
  assert.equal(host.child, media);
  assert.equal(players.length, playerCount, "visibility changes do not recreate the player");
  globalThis.__videoTest.document.pictureInPictureElement = null;
  media.dispatchEvent(new Event("leavepictureinpicture"));
  assert.equal(media.paused, true, "leaving PiP in the background pauses playback");
  media.paused = false;
  visibilityEffect();
  assert.equal(media.paused, true, "ordinary video pauses when its tab becomes inactive");
  cleanup(); // Save exact time even before a timeupdate event.
  assert.equal(host.child, undefined, "closing the tab releases its player");
  cleanup = open("b.mp4");
  host.child.metadata(); host.child.frame();
  host.child.currentTime = 12;
  cleanup();
  cleanup = open("a.mp4");
  host.child.metadata();
  assert.equal(host.child.currentTime, 37.5);
  cleanup(); // Switch away before restoration finishes: do not overwrite progress.
  cleanup = open("a.mp4");
  host.child.metadata(); host.child.frame();
  assert.equal(host.child.currentTime, 37.5);
  cleanup();
  cleanup = open("b.mp4"); host.child.metadata();
  assert.equal(host.child.currentTime, 12);
  playbackEffect();
  assert.equal(host.child.playCalls, 0, "previews do not play without a list click");
  host.child.pause();
  AssetVideo({ source: "b.mp4", note: "b.mp4", playRequest: 1 });
  playbackEffect();
  assert.equal(host.child.playCalls, 1, "selecting a list entry starts playback");
  assert.equal(host.child.paused, false);
  const selectedMedia = host.child;
  host.child.pause();
  AssetVideo({ source: "b.mp4", note: "b.mp4", playRequest: 2 });
  playbackEffect();
  assert.equal(host.child, selectedMedia, "clicking the current entry retains its player");
  assert.equal(host.child.playCalls, 2, "clicking the current entry resumes playback");
  assert.equal(host.child.currentTime, 12, "playback requests preserve progress");
  AssetVideo({ source: "b.mp4", note: "b.mp4", active: false, playRequest: 3 });
  playbackEffect();
  visibilityEffect();
  assert.equal(host.child.playCalls, 2, "hidden pages do not start playback");
  assert.equal(host.child.paused, true);
  cleanup();
  delete globalThis.__videoTest;
  delete globalThis.React;
});
