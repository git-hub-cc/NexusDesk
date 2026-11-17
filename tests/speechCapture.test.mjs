import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import React from "react";
import ts from "typescript";

const load = path => readFileSync(new URL(path, import.meta.url), "utf8");
const source = [
  load("../src/components/editor/speechBuffer.ts"),
  load("../src/utils/speechMicrophone.ts"),
  load("../src/components/editor/SpeechToText.tsx"),
].join("\n").replace(/^import .*;\r?$/gm, "").replace(/export /g, "");
const compiled = ts.transpileModule(source + "\nglobalThis.render = SpeechToText;", {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

async function setup({ inputDeviceId = "" } = {}) {
  let now = 0;
  let processor;
  let tick;
  const states = [];
  const effects = [];
  const cleanups = [];
  const calls = [];
  const inserted = [];
  const saved = [];
  const track = { readyState: "live", muted: false, stop() { this.readyState = "ended"; } };
  const stream = { active: true, getTracks: () => [track], getAudioTracks: () => [track] };
  const node = () => ({ connect() {}, disconnect() {} });
  const env = {
    React, console: { info() {}, warn() {}, error() {} },
    Activity: "Activity", Pause: "Pause", Play: "Play", X: "X",
    document: { body: {} }, window: new EventTarget(), createPortal: value => value,
    Date: class extends Date { static now() { return now; } },
    setTimeout, clearTimeout, setInterval: callback => { tick = callback; return 1; }, clearInterval: () => { tick = null; },
    useState: initial => {
      const index = states.length;
      states.push(typeof initial === "function" ? initial() : initial);
      return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    },
    useRef: current => ({ current }), useEffect: effect => effects.push(effect),
    isTauri: () => false,
    readSpeechPreferences: () => ({ inputDeviceId, model: "sensevoice-small", minVolume: 0.018, minDurationSeconds: 0.5, minTextLength: 2 }),
    speechPreferencesKey: "speech-preferences",
    settingsStorage: { setItem: (key, value) => saved.push({ key, value: JSON.parse(value) }) },
    navigator: { mediaDevices: { getUserMedia: async constraints => { calls.push({ command: "getUserMedia", args: constraints }); return stream; } } },
    AudioContext: class {
      state = "suspended";
      sampleRate = 48000;
      async resume() { this.state = "running"; }
      async close() { this.state = "closed"; }
      createMediaStreamSource() { return node(); }
      createScriptProcessor() { processor = node(); return processor; }
      createGain() { return { ...node(), gain: { value: 1 } }; }
    },
    invoke: async (command, args) => {
      calls.push({ command, args });
      return command === "stt_transcribe" ? { text: "测试内容", runtime: {} } : { ready: true };
    },
  };
  vm.runInNewContext(compiled, env);
  const tree = env.render({ onInsert: text => inserted.push(text), onClose() {} });
  for (const effect of effects) cleanups.push(effect());
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  return {
    states, calls, inserted, track, settle, tree, saved,
    togglePause: () => env.window.dispatchEvent(new Event("nexusdesk-speech-pause-toggle")),
    frame: volume => processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(volume) } }),
    tick: elapsed => { now += elapsed; tick?.(); },
    cleanup: () => cleanups.forEach(cleanup => cleanup?.()),
  };
}

test("listener waits for real audio and submits speech after a pause", async () => {
  const env = await setup();
  try {
    assert.match(env.states[2], /等待麦克风音频/);
    for (let i = 0; i < 10; i++) env.frame(0.1);
    assert.match(env.states[2], /检测到语音/);
    assert.ok(env.states[10] > 0);
    for (let i = 0; i < 17; i++) env.frame(0);
    await env.settle();
    assert.equal(env.inserted[0], "测试内容 ");
    const samples = env.calls.find(call => call.command === "stt_transcribe").args.samples;
    assert.ok(samples.length >= 8000);
    assert.ok(Math.abs(samples[0] - 0.1) < 0.0001);
  } finally { env.cleanup(); }
});

test("saved microphone is used for capture and changing it persists and restarts", async () => {
  const env = await setup({ inputDeviceId: "previous-mic" });
  try {
    assert.equal(env.calls.find(call => call.command === "getUserMedia").args.audio.deviceId.exact, "previous-mic");
    const findSelect = element => {
      if (!element || typeof element !== "object") return null;
      if (element.type === "select") return element;
      return React.Children.toArray(element.props?.children).map(findSelect).find(Boolean);
    };
    const select = findSelect(env.tree);
    assert.equal(select.props.value, "previous-mic");
    select.props.onChange({ target: { value: "usb-mic" } });
    assert.equal(env.saved[0].value.inputDeviceId, "usb-mic");
    assert.equal(env.states[4], true);
    assert.equal(env.states[5], 1);
  } finally { env.cleanup(); }
});

test("missing capture callbacks fail with retry instead of claiming to listen", async () => {
  const env = await setup();
  try {
    env.tick(6000);
    assert.match(env.states[2], /音频采集已中断/);
    assert.equal(env.states[6], true);
    assert.equal(env.track.readyState, "ended");
  } finally { env.cleanup(); }
});

test("silent and quiet inputs explain why no speech is recognized", async () => {
  for (const [volume, message] of [[0, /未检测到麦克风声音/], [0.002, /声音低于识别阈值/]]) {
    const env = await setup();
    try {
      env.tick(4000);
      env.frame(volume);
      env.tick(2000);
      assert.match(env.states[2], message);
      assert.equal(env.states[6], false);
      assert.equal(env.states[9], false);
      assert.equal(env.track.readyState, "live");
      env.frame(0.1);
      assert.match(env.states[2], /检测到语音/);
      assert.equal(env.states[6], false);
    } finally { env.cleanup(); }
  }
});

test("silence after recognition keeps recording available for pause and resume", async () => {
  const env = await setup();
  try {
    for (let i = 0; i < 10; i++) env.frame(0.1);
    for (let i = 0; i < 17; i++) env.frame(0);
    await env.settle();
    assert.equal(env.inserted[0], "测试内容 ");

    env.tick(4000);
    env.frame(0);
    env.tick(2000);
    assert.match(env.states[2], /未检测到麦克风声音|声音低于识别阈值/);
    assert.equal(env.states[6], false);
    assert.equal(env.track.readyState, "live");

    env.togglePause();
    assert.equal(env.states[9], true);
    assert.equal(env.states[2], "已暂停");
    env.frame(0.1);
    env.tick(1000);
    assert.equal(env.states[2], "已暂停");

    env.togglePause();
    assert.equal(env.states[9], false);
    for (let i = 0; i < 10; i++) env.frame(0.1);
    for (let i = 0; i < 17; i++) env.frame(0);
    await env.settle();
    assert.equal(env.inserted.length, 2);
    assert.equal(env.states[6], false);
  } finally { env.cleanup(); }
});
