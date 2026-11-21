import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8")
  .replace(/^import .*;\r?$/gm, "").replace(/^export /gm, "").replaceAll("import.meta.url", '"file:///androidMirror.test.mjs"'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
const metrics = new Function(`${compile("../src/components/editor/mirrorVideoMetrics.ts")}\nreturn { MirrorVideoMetrics, TimingSamples, readMirrorVideoPacket };`)();
const flatten = node => Array.isArray(node) ? node.flatMap(flatten)
  : node && typeof node === "object" ? [node, ...flatten(node.children)] : [];

test("moving the mirror tab across panes preserves its React key and inactive tabs stay mounted", () => {
  const tab = { id: "nexusdesk:mirror", browser: { url: "nexusdesk:mirror" } };
  const state = { leftTabs: [], rightTabs: [tab], activeLeftTabId: null, activeRightTabId: tab.id, isSplitMode: true };
  const render = new Function("React", "useShallow", "useWorkspaceStore", "MIRROR_HOME", `${compile("../src/components/editor/AndroidMirrorWorkspace.tsx")}\nreturn AndroidMirrorWorkspace;`)
    (React, x => x, selector => selector(state), tab.id);
  const panel = () => flatten(render()).find(node => node.props.pane);
  const original = panel();
  assert.equal(original.props.active, true);
  state.rightTabs = []; state.leftTabs = [tab]; state.activeLeftTabId = tab.id;
  assert.equal(panel().props.key, original.props.key);
  assert.equal(panel().type, original.type);
  assert.equal(panel().props.pane, "left");
  state.activeLeftTabId = "note";
  assert.equal(panel().props.active, false);
  state.leftTabs = [];
  assert.equal(panel(), undefined);
});

function harness({ delayedStart = false, delayedStop = false, delayedAudioClose = false, delayedScreenOff = false, delayedKey = false, controlledTimeouts = false, discover = () => [{ serial: "phone", status: "device", model: "Phone" }], initiallyFullscreen = false, initiallyMaximized = false } = {}) {
  const states = [], refs = [], effects = [], calls = [], decoders = [];
  const timers = new Set();
  const listeners = new Map(), fullscreenCalls = [];
  const windowListeners = new Map(), timeouts = new Map();
  const host = {
    fullscreen: initiallyFullscreen,
    maximized: initiallyMaximized,
    async isFullscreen() { return this.fullscreen; },
    async isMaximized() { return this.maximized; },
    async maximize() { this.maximized = true; },
    async unmaximize() { this.maximized = false; },
    async toggleMaximize() { this.maximized = !this.maximized; },
    async setFullscreen(value) {
      this.fullscreen = value;
      // Native fullscreen can discard the maximized flag on Windows.
      if (value) this.maximized = false;
      fullscreenCalls.push(value);
    },
  };
  const document = {
    hidden: false, fullscreenElement: null,
    focused: true, hasFocus() { return this.focused; },
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    async exitFullscreen() { throw new Error("DOM fullscreen must not be used by the mirror"); },
  };
  const panel = { async requestFullscreen() { throw new Error("DOM fullscreen must not be used by the mirror"); } };
  const drawnFrames = [];
  const canvas = { width: 300, height: 150, focus() {}, getContext: () => ({ drawImage: frame => drawnFrames.push(frame), clearRect() {} }) };
  let si = 0, ri = 0, ei = 0, currentChannel, releaseStart, releaseStop, releaseAudioClose, releaseScreenOff, releaseKey, now = 0;
  const start = delayedStart ? new Promise(resolve => { releaseStart = resolve; }) : Promise.resolve();
  const stop = delayedStop ? new Promise(resolve => { releaseStop = resolve; }) : Promise.resolve();
  const audioClose = delayedAudioClose ? new Promise(resolve => { releaseAudioClose = resolve; }) : Promise.resolve();
  const screenOff = delayedScreenOff ? new Promise(resolve => { releaseScreenOff = resolve; }) : Promise.resolve();
  const key = delayedKey ? new Promise(resolve => { releaseKey = resolve; }) : Promise.resolve();
  const bindings = {
    ...metrics,
    React, TextEncoder, crypto, document, performance: { now: () => now }, getCurrentWindow: () => host,
    MirrorAudio: class { async resume() {} play() {} close() { return audioClose; } },
    setInterval: callback => { timers.add(callback); return callback; },
    clearInterval: callback => timers.delete(callback),
    window: {
      VideoDecoder: true,
      addEventListener(name, callback) { if (!windowListeners.has(name)) windowListeners.set(name, new Set()); windowListeners.get(name).add(callback); },
      removeEventListener(name, callback) { windowListeners.get(name)?.delete(callback); },
    },
    useState: initial => {
      const i = si++; if (!(i in states)) states[i] = initial;
      return [states[i], value => { states[i] = typeof value === "function" ? value(states[i]) : value; }];
    },
    useRef: initial => { const i = ri++; return refs[i] ??= { current: initial }; },
    useEffect: (callback, deps) => {
      const i = ei++, old = effects[i];
      if (!old || deps.some((d, j) => d !== old.deps[j])) effects[i] = { callback, deps, pending: true, cleanup: old?.cleanup };
    },
    Channel: class { constructor() { currentChannel = this; } },
    VideoDecoder: class {
      state = "unconfigured"; decodeQueueSize = 0; chunks = [];
      constructor(options) { this.options = options; decoders.push(this); }
      configure(config) { this.config = config; this.state = "configured"; }
      decode(chunk) { this.chunks.push(chunk); }
      reset() { this.state = "unconfigured"; }
      close() { this.state = "closed"; }
    },
    EncodedVideoChunk: class { constructor(init) { Object.assign(this, init); } },
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "mirror_devices") return discover();
      if (command === "mirror_connect_wifi") return "192.168.1.20:5555";
      if (command === "mirror_start") return start;
      if (command === "mirror_stop") return stop;
      if (command === "mirror_control" && args.data[0] === 10 && args.data[1] === 0) return screenOff;
      if (command === "mirror_control" && args.data[0] === 0) return key;
    },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
  if (controlledTimeouts) {
    bindings.setTimeout = (callback, delay) => { const id = {}; timeouts.set(id, { callback, at: now + delay }); return id; };
    bindings.clearTimeout = id => timeouts.delete(id);
  }
  bindings.useGlobalPreference = (_key, normalize) => bindings.useState(normalize(undefined));
  for (const name of ["ArrowLeft", "House", "Square", "Power", "RefreshCw", "Smartphone", "Maximize", "Minimize", "FolderOpen", "AndroidFileManager"]) bindings[name] = name;
  const Component = new Function(...Object.keys(bindings), `${compile("../src/components/editor/AndroidMirrorPanel.tsx")}\nreturn AndroidMirrorPanel;`)(...Object.values(bindings));
  const render = (active = true) => {
    si = ri = ei = 0;
    const tree = Component({ active });
    tree.props.ref.current = panel;
    flatten(tree).find(node => node.type === "canvas").props.ref.current = canvas;
    for (const effect of effects) if (effect.pending) { effect.cleanup?.(); effect.pending = false; effect.cleanup = effect.callback(); }
    return flatten(tree);
  };
  const packet = (flags, bytes, sentAtMs) => {
    const buffer = new ArrayBuffer(12 + bytes.length + (sentAtMs === undefined ? 0 : 8));
    new DataView(buffer).setBigUint64(0, BigInt(flags) << 56n | 123n);
    new DataView(buffer).setUint32(8, bytes.length);
    new Uint8Array(buffer).set(bytes, 12);
    if (sentAtMs !== undefined) new DataView(buffer).setBigUint64(12 + bytes.length, BigInt(sentAtMs));
    currentChannel.onmessage(buffer);
  };
  return { render, calls, decoders, canvas, drawnFrames, releaseStart, releaseStop, releaseAudioClose, releaseScreenOff, releaseKey, packet, document, host, fullscreenCalls,
    blur: () => { document.focused = false; windowListeners.get("blur")?.forEach(callback => callback()); },
    runTimeouts: async ms => {
      now += ms;
      for (const [id, timer] of [...timeouts]) if (timer.at <= now) { timeouts.delete(id); timer.callback(); }
      await tick();
    },
    visibility: hidden => { document.hidden = hidden; listeners.get("visibilitychange")?.forEach(callback => callback()); }, advance: ms => { now += ms; }, poll: () => timers.forEach(callback => callback()), unmount: () => effects.forEach(effect => effect.cleanup?.()) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const connect = tree => tree.find(node => node.type === "button" && node.children.includes("连接")).props.onClick();

async function swipeHarness(fullscreen = true) {
  const h = harness({ controlledTimeouts: true });
  h.render(); await tick(); connect(h.render()); await tick();
  h.decoders[0].options.output({ displayWidth: 1080, displayHeight: 1920, close() {} });
  if (fullscreen) h.render().find(node => node.props["aria-label"] === "投屏全屏").props.onClick();
  h.render(); await tick();
  h.touches = () => h.calls.filter(call => call.command === "mirror_control" && call.args.data[0] === 2);
  h.press = (key, extra = {}) => {
    const event = { key, target: h.canvas, nativeEvent: {}, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    h.render().find(node => node.props.onKeyDownCapture).props.onKeyDownCapture(event);
    return event;
  };
  return h;
}

test("global Tab navigation leaves mirror focus intact so fullscreen shortcuts keep working", async () => {
  let queries = 0, focused = 0;
  class Element {
    constructor(props) { this.props = props; }
    closest(selector) {
      return this.props["data-android-mirror-input"] === "true"
        && selector.includes('[data-android-mirror-input="true"]') ? this : null;
    }
  }
  class HTMLInputElement extends Element {
    type = "text";
    matches(selector) { return selector === "input"; }
    getClientRects() { return [{}]; }
    focus() { focused++; }
  }
  const field = new HTMLInputElement({});
  const document = {
    activeElement: null,
    addEventListener() {},
    querySelectorAll() {
      queries++;
      return [field];
    },
  };
  let navigate;
  const context = {
    Element, HTMLElement: Element, HTMLInputElement, HTMLTextAreaElement: class extends Element {}, document,
    window: { addEventListener(type, listener) { if (type === "keydown") navigate = listener; } },
    exports: {},
  };
  const source = readFileSync(new URL("../src/utils/focusPolicy.ts", import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  context.exports.installFocusPolicy();
  const h = await swipeHarness();
  try {
    const canvas = h.render().find(node => node.type === "canvas");
    const target = { width: 1080, height: 1920, focus() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1080, height: 1920 }) };
    const pointer = { pointerId: 1, button: 0, clientX: 540, clientY: 960, currentTarget: target, preventDefault() {} };
    canvas.props.onPointerDown(pointer); canvas.props.onPointerUp(pointer); await tick();
    const input = h.render().find(node => node.type === "input");
    for (const node of [canvas, input]) {
      for (const shiftKey of [false, true]) {
        const event = { key: "Tab", shiftKey, target: new Element(node.props), nativeEvent: {}, currentTarget: { value: "" }, preventDefault() { this.prevented = true; }, stopPropagation() {} };
        navigate(event);
        assert.equal(event.prevented, undefined);
        node.props.onKeyDown(event);
        assert.equal(event.prevented, true);
      }
    }
    await tick();
    assert.equal(queries, 0);
    assert.equal(focused, 0);
    const tabKeys = h.calls.filter(call => call.command === "mirror_control" && call.args.data[0] === 0);
    assert.equal(tabKeys.length, 8);
    assert.ok(tabKeys.every(call => new DataView(Uint8Array.from(call.args.data).buffer).getUint32(2) === 61));
    h.calls.length = 0;
    assert.equal(h.press("ArrowUp").prevented, true);
    await tick();
    assert.equal(h.touches().length, 1);
    navigate({ key: "Tab", target: new Element({}), preventDefault() {} });
    assert.equal(focused, 1);
  } finally { h.unmount(); await tick(); }
});

for (const fullscreen of [false, true]) test(`${fullscreen ? "fullscreen" : "windowed"} shortcuts preserve button keyboard activation`, async () => {
  const h = await swipeHarness(fullscreen);
  try {
    const target = { closest: selector => selector.includes("button") ? {} : null };
    assert.equal(h.press(" ", { target }).prevented, undefined);
    await tick();
    assert.equal(h.touches().length, 0);
    assert.equal(h.press("Escape", { target }).prevented, fullscreen ? true : undefined);
    await tick();
    assert.equal(h.host.fullscreen, false);
  } finally { h.unmount(); await tick(); }
});

for (const fullscreen of [false, true]) test(`${fullscreen ? "fullscreen" : "windowed"} arrows generate paced swipes in both directions and ignore repeats, overlap and cooldown`, async () => {
  const h = await swipeHarness(fullscreen);
  try {
    assert.equal(h.press("ArrowUp", { repeat: true }).prevented, true);
    await tick(); assert.equal(h.touches().length, 0);
    assert.equal(h.press("ArrowUp").stopped, true);
    await tick(); assert.equal(h.touches().length, 1);
    h.press("ArrowDown"); await tick(); assert.equal(h.touches().length, 1);
    const pointer = h.render().find(node => node.type === "canvas");
    pointer.props.onPointerDown({});
    for (let i = 0; i < 10; i++) await h.runTimeouts(25);
    const packets = h.touches().map(call => new DataView(Uint8Array.from(call.args.data).buffer));
    assert.deepEqual(packets.map(view => view.getUint8(1)), [0, ...Array(10).fill(2), 1]);
    assert.equal(packets[0].getUint32(14), 1440);
    assert.equal(packets.at(-1).getUint32(14), 480);
    for (const view of packets) {
      assert.equal(view.getUint32(10), 540);
      assert.equal(view.getUint16(18), 1080);
      assert.equal(view.getUint16(20), 1920);
    }
    assert.equal(packets.at(-1).getUint16(22), 0);
    assert.equal(packets.at(-1).getUint32(28), 0);
    await h.runTimeouts(200);
    h.press("ArrowLeft"); await tick();
    for (let i = 0; i < 10; i++) await h.runTimeouts(25);
    const left = h.touches().slice(12).map(call => new DataView(Uint8Array.from(call.args.data).buffer));
    assert.equal(left[0].getUint32(10), 810);
    assert.equal(left.at(-1).getUint32(10), 270);
    assert.ok(left.every(view => view.getUint32(14) === 960));
    await h.runTimeouts(200);
    h.press("ArrowRight"); await tick();
    for (let i = 0; i < 10; i++) await h.runTimeouts(25);
    const right = h.touches().slice(24).map(call => new DataView(Uint8Array.from(call.args.data).buffer));
    assert.equal(right[0].getUint32(10), 270);
    assert.equal(right.at(-1).getUint32(10), 810);
    assert.ok(right.every(view => view.getUint32(14) === 960));
    h.press("ArrowDown"); await tick(); assert.equal(h.touches().length, 36);
    await h.runTimeouts(200);
    h.press("ArrowDown"); await tick();
    for (let i = 0; i < 10; i++) await h.runTimeouts(25);
    const down = h.touches().slice(36).map(call => new DataView(Uint8Array.from(call.args.data).buffer));
    assert.equal(down[0].getUint32(14), 480);
    assert.equal(down.at(-1).getUint32(14), 1440);
    assert.equal(h.calls.some(call => call.command === "mirror_control" && call.args.data[0] === 0), false);
    await h.runTimeouts(3000);
    assert.equal(h.render().some(node => node.children.includes("方向键滑动 · 空格单击，连按两次双击 · Esc 退出")), false);
  } finally { h.unmount(); await tick(); }
});

for (const fullscreen of [false, true]) test(`${fullscreen ? "fullscreen" : "windowed"} swipes work from the empty IME input but preserve composing, editable and modified keys`, async () => {
  const h = await swipeHarness(fullscreen);
  try {
    const canvas = h.render().find(node => node.type === "canvas");
    const target = { width: 1080, height: 1920, focus() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1080, height: 1920 }) };
    const pointer = { pointerId: 1, button: 0, clientX: 540, clientY: 960, currentTarget: target, preventDefault() {} };
    canvas.props.onPointerDown(pointer);
    h.press("ArrowUp"); await tick(); assert.equal(h.touches().length, 1);
    canvas.props.onPointerUp(pointer); await h.runTimeouts(0);
    const inputNode = h.render().find(node => node.type === "input");
    const input = { value: "", closest: () => ({}) };
    inputNode.props.ref.current = input;
    for (const extra of [{ nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { metaKey: true }]) {
      assert.equal(h.press("ArrowUp", extra).prevented, undefined);
    }
    assert.equal(h.press("ArrowUp", { target: { closest: () => ({}) } }).prevented, undefined);
    inputNode.props.onCompositionStart({ currentTarget: input });
    assert.equal(h.press("ArrowUp", { target: input }).prevented, undefined);
    inputNode.props.onCompositionEnd({ currentTarget: input, data: "" });
    input.value = "pending";
    assert.equal(h.press("ArrowUp", { target: input }).prevented, undefined);
    input.value = "";
    await tick(); assert.equal(h.touches().length, 2);
    assert.equal(h.press("ArrowUp", { target: input }).prevented, true);
    await tick(); assert.equal(h.touches().length, 3);
  } finally { h.unmount(); await tick(); }
});

for (const fullscreen of [false, true]) test(`${fullscreen ? "fullscreen" : "windowed"} swipe cancellation releases the touch and prevents remaining moves across focus, visibility and rotation changes`, async () => {
  const reasons = [...(fullscreen ? ["escape"] : []), "blur", "hidden", "inactive", "rotation", "disconnect", "unmount"];
  for (const [key, reason] of ["ArrowUp", " "].flatMap(key => reasons.map(reason => [key, reason]))) {
    const h = await swipeHarness(fullscreen);
    h.press(key); await tick(); await h.runTimeouts(25);
    if (key === " ") h.press(" ");
    if (reason === "escape") h.press("Escape");
    if (reason === "blur") h.blur();
    if (reason === "hidden") h.visibility(true);
    if (reason === "inactive") h.render(false);
    if (reason === "rotation") {
      h.decoders[0].options.output({ displayWidth: 1920, displayHeight: 1080, close() {} });
      h.render();
    }
    if (reason === "disconnect") h.render().find(node => node.children.includes("断开")).props.onClick();
    if (reason === "unmount") h.unmount();
    await tick();
    const count = h.touches().length;
    await h.runTimeouts(1000);
    assert.equal(h.touches().length, count, reason);
    if (reason !== "disconnect" && reason !== "unmount") assert.equal(h.touches().at(-1).args.data[1], 1, reason);
    if (reason === "escape") assert.equal(h.press("ArrowDown").prevented, true);
    if (reason === "blur") assert.equal(h.press("ArrowDown").prevented, undefined);
    if (reason === "disconnect") {
      connect(h.render()); await tick();
      await h.runTimeouts(1000);
      assert.equal(h.touches().length, count);
    }
    if (reason !== "unmount") h.unmount();
    await tick();
  }
});

for (const fullscreen of [false, true]) test(`${fullscreen ? "fullscreen" : "windowed"} each space taps the screen center once, queues rapid presses and ignores held keys`, async () => {
  const h = await swipeHarness(fullscreen);
  try {
    h.press(" ", { repeat: true }); await tick(); assert.equal(h.touches().length, 0);
    const input = { value: "", focus() {}, closest: () => ({}) };
    const canvas = h.render().find(node => node.type === "canvas");
    const target = { width: 1080, height: 1920, focus() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1080, height: 1920 }) };
    const pointer = { pointerId: 1, button: 0, clientX: 540, clientY: 960, currentTarget: target, preventDefault() {} };
    canvas.props.onPointerDown(pointer); canvas.props.onPointerUp(pointer); await tick();
    h.calls.length = 0;
    h.render().find(node => node.type === "input").props.ref.current = input;
    assert.equal(h.press(" ", { target: input }).prevented, true);
    await tick();
    h.press("ArrowUp"); h.press(" ", { repeat: true }); await tick();
    assert.equal(h.touches().length, 1);
    await h.runTimeouts(40);
    assert.deepEqual(h.touches().map(call => call.args.data[1]), [0, 1]);
    await h.runTimeouts(1000);
    assert.deepEqual(h.touches().map(call => call.args.data[1]), [0, 1]);
    h.calls.length = 0;
    h.press(" "); h.press(" "); await tick();
    assert.deepEqual(h.touches().map(call => call.args.data[1]), [0]);
    await h.runTimeouts(40);
    assert.deepEqual(h.touches().map(call => call.args.data[1]), [0, 1]);
    await h.runTimeouts(40);
    assert.deepEqual(h.touches().map(call => call.args.data[1]), [0, 1, 0]);
    await h.runTimeouts(40);
    assert.deepEqual(h.touches().map(call => call.args.data[1]), [0, 1, 0, 1]);
    await h.runTimeouts(1000);
    assert.equal(h.touches().length, 4);
    for (const call of h.touches()) {
      const view = new DataView(Uint8Array.from(call.args.data).buffer);
      assert.equal(view.getUint32(10), 540);
      assert.equal(view.getUint32(14), 960);
      assert.equal(view.getUint16(22), call.args.data[1] === 1 ? 0 : 65535);
    }
    assert.equal(h.calls.some(call => call.command === "mirror_control" && [0, 1, 9].includes(call.args.data[0])), false);
    h.press(" "); await tick(); assert.equal(h.touches().length, 5);
    await h.runTimeouts(40);
    assert.equal(h.touches().length, 6);
    h.press("ArrowUp"); await tick(); assert.equal(h.touches().length, 7);
    h.press(" "); await tick(); assert.equal(h.touches().length, 7);
  } finally { h.unmount(); await tick(); }
});

test("space preserves text input, works after exiting fullscreen, and cancellation between queued taps sends no extra touch", async () => {
  const h = await swipeHarness();
  try {
    for (const extra of [{ nativeEvent: { isComposing: true } }, { ctrlKey: true }, { shiftKey: true }, { target: { closest: () => ({}) } }]) {
      assert.equal(h.press(" ", extra).prevented, undefined);
    }
    h.press(" "); h.press(" "); await tick(); await h.runTimeouts(40);
    h.blur(); await h.runTimeouts(1000);
    assert.deepEqual(h.touches().map(call => call.args.data[1]), [0, 1]);
    h.document.focused = true;
    h.press("Escape");
    assert.equal(h.press(" ").prevented, true);
    await tick();
    assert.deepEqual(h.touches().map(call => call.args.data[1]), [0, 1, 0]);
  } finally { h.unmount(); await tick(); }
});

test("audio close waits for context shutdown and repeated cleanup stops sources only once", async () => {
  let releaseClose, closeCalls = 0, stopCalls = 0, disconnectCalls = 0;
  const closed = new Promise(resolve => { releaseClose = resolve; });
  const contexts = [];
  class AudioContext {
    state = "running"; currentTime = 0; sampleRate = 48000;
    constructor() { contexts.push(this); }
    createBuffer(channels, frames, rate) { return { duration: frames / rate, getChannelData: () => new Float32Array(frames) }; }
    createBufferSource() { return { connect() {}, start() {}, stop() { stopCalls++; }, disconnect() { disconnectCalls++; } }; }
    close() { closeCalls++; return closed.then(() => { this.state = "closed"; }); }
  }
  const MirrorAudio = new Function("AudioContext", "console", `${compile("../src/components/editor/mirrorAudio.ts")}\nreturn MirrorAudio;`)(AudioContext, { info() {}, warn() {} });
  const audio = new MirrorAudio("test-session");
  const packet = new ArrayBuffer(16);
  new DataView(packet).setUint32(8, 4);
  audio.play(packet);
  const first = audio.close();
  assert.equal(audio.close(), first);
  let finished = false;
  first.then(() => { finished = true; });
  await tick();
  assert.equal(finished, false);
  assert.equal(stopCalls, 1);
  assert.equal(disconnectCalls, 1);
  assert.equal(closeCalls, 1);
  releaseClose(); await first;
  assert.equal(contexts[0].state, "closed");
  assert.equal(contexts[0].onstatechange, null);
});

test("USB devices can switch to their discovered Wi-Fi address without manual input", async () => {
  const h = harness(); h.render(); await tick();
  const button = h.render().find(node => node.type === "button" && node.children.includes("切换到 Wi-Fi"));
  assert.ok(button);
  await button.props.onClick(); await tick();
  assert.deepEqual(h.calls.find(call => call.command === "mirror_connect_wifi").args, { serial: "phone" });
  const deviceSelect = h.render().find(node => node.props["aria-label"] === "Android 设备");
  assert.equal(deviceSelect.props.value, "192.168.1.20:5555");
});

test("file management works before mirroring and toggling it preserves the video session", async () => {
  const h = harness(); h.render(); await tick();
  const toggle = () => h.render().find(node => node.props["aria-label"] === "文件管理");
  assert.equal(toggle().props.disabled, false);
  toggle().props.onClick();
  assert.equal(h.render().find(node => node.type === "AndroidFileManager").props.serial, "phone");
  assert.equal(h.calls.some(call => call.command === "mirror_start"), false);
  connect(h.render()); await tick();
  const decoder = h.decoders.at(-1);
  toggle().props.onClick();
  assert.equal(h.render().some(node => node.type === "AndroidFileManager"), false);
  assert.notEqual(decoder.state, "closed");
  assert.equal(h.calls.some(call => call.command === "mirror_stop"), false);
  h.unmount();
});

test("FPS measures drawn frames over elapsed time and resets on stalls, hiding and reconnect", async () => {
  const h = harness(); h.render(); await tick(); connect(h.render()); await tick();
  const fps = () => h.render().find(node => node.children.includes(" FPS"))?.children[0];
  const draw = () => h.decoders.at(-1).options.output({ displayWidth: 1080, displayHeight: 1920, close() {} });
  assert.equal(fps(), 0);
  for (let i = 0; i < 90; i++) draw();
  h.advance(1500); h.poll();
  assert.equal(fps(), 60);
  h.advance(1000); h.poll();
  assert.equal(fps(), 0);
  h.render(false);
  draw(); // Frames delivered while hidden do not count.
  h.render();
  draw(); h.advance(1000); h.poll();
  assert.equal(fps(), 1);
  h.render().find(node => node.type === "button" && node.children.includes("断开")).props.onClick();
  assert.equal(fps(), undefined);
  await tick();
  connect(h.render()); await tick();
  assert.equal(fps(), 0);
  h.unmount();
});

test("reconnecting at the same resolution shows the first frame and ignores frames from old sessions", async () => {
  const h = harness(); h.render(); await tick();
  const output = (decoder, width, height) => {
    let closed = false;
    decoder.options.output({ displayWidth: width, displayHeight: height, close() { closed = true; } });
    assert.equal(closed, true);
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    connect(h.render()); await tick();
    const decoder = h.decoders.at(-1);
    output(decoder, 1080, 1920);
    const canvas = h.render().find(node => node.type === "canvas");
    assert.ok(canvas.props.className.startsWith("block"));
    assert.equal(canvas.props.style.aspectRatio, "1080/1920");
    assert.equal(h.drawnFrames.length, attempt + 1);
    h.render().find(node => node.type === "button" && node.children.includes("断开")).props.onClick();
    assert.ok(h.render().find(node => node.type === "canvas").props.className.startsWith("hidden"));
    output(decoder, 720, 1280);
    assert.equal(h.drawnFrames.length, attempt + 1);
    assert.equal(h.canvas.width, 1080);
    await tick();
  }
  h.unmount();
});

test("one screen power button alternates off and on, then resets after disconnect", async () => {
  const h = harness(); h.render(); await tick(); connect(h.render()); await tick();
  let tree = h.render();
  assert.deepEqual(h.calls.filter(call => call.command === "mirror_control").map(call => call.args.data), [[10, 0]]);
  assert.ok(tree.find(node => node.props["aria-label"] === "点亮手机屏幕"));
  assert.equal(tree.filter(node => node.type === "button" && ["关闭手机屏幕（投屏继续）", "点亮手机屏幕"].includes(node.props["aria-label"])).length, 1);
  assert.equal(tree.some(node => node.props["aria-label"] === "旋转"), false);
  tree.find(node => node.props["aria-label"] === "点亮手机屏幕").props.onClick();
  tree = h.render();
  tree.find(node => node.props["aria-label"] === "关闭手机屏幕（投屏继续）").props.onClick();
  await tick();
  assert.deepEqual(h.calls.filter(call => call.command === "mirror_control").map(call => call.args.data), [[10, 0], [10, 2], [10, 0]]);
  tree = h.render();
  tree.find(node => node.props["aria-label"] === "点亮手机屏幕").props.onClick();
  tree = h.render();
  tree.find(node => node.type === "button" && node.children.includes("断开")).props.onClick();
  assert.ok(h.render().find(node => node.props["aria-label"] === "关闭手机屏幕（投屏继续）"));
  h.unmount();
});

test("disconnect wakes an automatically darkened phone before stopping the mirror", async () => {
  const h = harness(); h.render(); await tick(); connect(h.render()); await tick();
  h.render().find(node => node.type === "button" && node.children.includes("断开")).props.onClick();
  await tick(); await tick();
  const commands = h.calls.filter(call => ["mirror_control", "mirror_stop"].includes(call.command)).map(call => call.command);
  assert.deepEqual(commands, ["mirror_control", "mirror_control", "mirror_stop", "mirror_stop"]);
  assert.deepEqual(h.calls.filter(call => call.command === "mirror_control").map(call => call.args.data), [[10, 0], [10, 2]]);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(h.calls.filter(call => call.command === "mirror_refresh_brightness").length, 1);
  h.unmount();
});

test("unmount wakes an automatically darkened phone before stopping the mirror", async () => {
  const h = harness(); h.render(); await tick(); connect(h.render()); await tick();
  h.unmount();
  await tick(); await tick();
  const commands = h.calls.filter(call => ["mirror_control", "mirror_stop"].includes(call.command)).map(call => call.command);
  assert.deepEqual(commands, ["mirror_control", "mirror_control", "mirror_stop", "mirror_stop"]);
  assert.deepEqual(h.calls.filter(call => call.command === "mirror_control").map(call => call.args.data), [[10, 0], [10, 2]]);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(h.calls.filter(call => call.command === "mirror_refresh_brightness").length, 1);
});

for (const turnOffAgain of [false, true]) {
  test(`completed wake ${turnOffAgain ? "followed by screen-off retains" : "clears"} disconnect restoration`, async () => {
    const h = harness(); h.render(); await tick(); connect(h.render()); await tick();
    h.render().find(node => node.props["aria-label"] === "点亮手机屏幕").props.onClick();
    if (turnOffAgain) h.render().find(node => node.props["aria-label"] === "关闭手机屏幕（投屏继续）").props.onClick();
    await tick();
    h.render().find(node => node.type === "button" && node.children.includes("断开")).props.onClick();
    await tick(); await tick();
    assert.deepEqual(h.calls.filter(call => call.command === "mirror_control").map(call => call.args.data),
      turnOffAgain ? [[10, 0], [10, 2], [10, 0], [10, 2]] : [[10, 0], [10, 2]]);
    h.unmount();
  });
}

for (const unmount of [false, true]) {
  test(`${unmount ? "unmounting" : "disconnecting"} while wake is queued still restores the phone`, async () => {
    const h = harness({ delayedKey: true });
    h.render(); await tick(); connect(h.render()); await tick();
    h.render().find(node => node.props["aria-label"] === "主页").props.onClick();
    await tick();
    h.render().find(node => node.props["aria-label"] === "点亮手机屏幕").props.onClick();
    await tick();
    if (unmount) h.unmount();
    else h.render().find(node => node.type === "button" && node.children.includes("断开")).props.onClick();
    h.releaseKey(); await tick(); await tick();
    assert.deepEqual(h.calls.filter(call => call.command === "mirror_stop" || (call.command === "mirror_control" && call.args.data[0] === 10))
      .map(call => [call.command, call.args.data]), [
      ["mirror_control", [10, 0]], ["mirror_control", [10, 2]],
      ["mirror_stop", undefined], ["mirror_stop", undefined],
    ]);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.ok(h.calls.some(call => call.command === "mirror_refresh_brightness"));
    if (!unmount) h.unmount();
  });
}

for (const unmount of [false, true]) {
  test(`${unmount ? "unmounting" : "cancelling startup"} while screen-off is pending still restores the phone`, async () => {
    const h = harness({ delayedScreenOff: true });
    h.render(); await tick(); connect(h.render()); await tick();
    assert.deepEqual(h.calls.filter(call => call.command === "mirror_control").map(call => call.args.data), [[10, 0]]);
    if (unmount) h.unmount();
    else h.render().find(node => node.type === "button" && node.children.includes("取消连接")).props.onClick();
    await tick();
    assert.equal(h.calls.some(call => call.command === "mirror_stop"), false);
    h.releaseScreenOff(); await tick(); await tick();
    assert.deepEqual(h.calls.filter(call => ["mirror_control", "mirror_stop"].includes(call.command))
      .map(call => [call.command, call.args.data]), [
      ["mirror_control", [10, 0]], ["mirror_control", [10, 2]],
      ["mirror_stop", undefined], ["mirror_stop", undefined],
    ]);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.deepEqual(h.calls.filter(call => call.command === "mirror_refresh_brightness").map(call => call.args), [{ serial: "phone" }]);
    if (!unmount) h.unmount();
  });
}

test("mirror fullscreen covers the monitor and Escape restores the window without sending Android Back", async () => {
  const h = harness(); h.render(); await tick(); connect(h.render()); await tick();
  h.render().find(node => node.props["aria-label"] === "投屏全屏").props.onClick(); await tick();
  assert.equal(h.host.fullscreen, true);
  let tree = h.render();
  assert.equal(tree.find(node => node.props["data-mirror-fullscreen"] === "true").props.className.includes("fixed"), true);
  assert.ok(tree.find(node => node.props["aria-label"] === "退出投屏全屏"));
  assert.equal(tree.find(node => node.props["aria-label"] === "安卓投屏控制").props.style.display, "none");
  tree.find(node => node.type === "canvas").props.onKeyDown({ key: "Escape", nativeEvent: {}, stopPropagation() {} });
  await tick();
  assert.equal(h.host.fullscreen, false);
  assert.equal(h.document.fullscreenElement, null);
  assert.deepEqual(h.calls.filter(call => call.command === "mirror_control").map(call => call.args.data), [[10, 0]]);
  assert.equal(h.calls.filter(call => call.command === "mirror_stop").length, 0);
  h.unmount();
});

test("fullscreen keeps the computer display awake only while the mirror is visible", async () => {
  const h = harness(); h.render(); await tick(); connect(h.render()); await tick();
  h.render(); await tick();
  const requests = () => h.calls.filter(call => call.command === "mirror_keep_display_awake").map(call => call.args.enabled);
  assert.deepEqual(requests(), [false]);
  h.render().find(node => node.props["aria-label"] === "投屏全屏").props.onClick();
  h.render(); await tick();
  assert.equal(requests().at(-1), true);
  h.visibility(true); await tick();
  assert.equal(requests().at(-1), false);
  h.visibility(false); await tick();
  assert.equal(requests().at(-1), true);
  h.render().find(node => node.props["aria-label"] === "退出投屏全屏").props.onClick();
  h.render(); await tick();
  assert.equal(requests().at(-1), false);
  h.render().find(node => node.props["aria-label"] === "投屏全屏").props.onClick();
  h.render(); await tick();
  assert.equal(requests().at(-1), true);
  h.render(false); await tick();
  assert.equal(requests().at(-1), false);
  h.unmount(); await tick();
});

test("rapid fullscreen changes leave the latest display wake request in effect", async () => {
  const h = harness(); h.render(); await tick(); connect(h.render()); await tick();
  h.render().find(node => node.props["aria-label"] === "投屏全屏").props.onClick();
  h.render().find(node => node.props["aria-label"] === "退出投屏全屏").props.onClick();
  h.render(); await tick();
  const requests = h.calls.filter(call => call.command === "mirror_keep_display_awake");
  assert.equal(requests.at(-1).args.enabled, false);
  h.unmount(); await tick();
});

test("mirror fullscreen restores maximize state so the title bar can switch window sizes", async () => {
  for (const initiallyMaximized of [false, true]) {
    const h = harness({ initiallyMaximized }); h.render(); await tick(); connect(h.render()); await tick();
    h.render().find(node => node.props["aria-label"] === "投屏全屏").props.onClick(); await tick();
    assert.equal(h.host.fullscreen, true);
    h.render().find(node => node.props["aria-label"] === "退出投屏全屏").props.onClick(); await tick();
    assert.equal(h.host.fullscreen, false);
    assert.equal(h.host.maximized, initiallyMaximized);
    await h.host.toggleMaximize();
    assert.equal(h.host.maximized, !initiallyMaximized);
    h.unmount();
  }
});

test("leaving the mirror or disconnecting exits fullscreen and preserves a previously fullscreen window", async () => {
  for (const initiallyFullscreen of [false, true]) {
    const h = harness({ initiallyFullscreen }); h.render(); await tick(); connect(h.render()); await tick();
    h.render().find(node => node.props["aria-label"] === "投屏全屏").props.onClick();
    // Exit before the asynchronous native fullscreen request finishes.
    h.render(false); await tick();
    assert.equal(h.document.fullscreenElement, null);
    assert.equal(h.host.fullscreen, initiallyFullscreen);
    h.render().find(node => node.props["aria-label"] === "投屏全屏").props.onClick(); await tick();
    h.render().find(node => node.type === "button" && node.children.includes("断开")).props.onClick();
    h.render(); await tick();
    assert.equal(h.document.fullscreenElement, null);
    assert.equal(h.host.fullscreen, initiallyFullscreen);
    connect(h.render()); await tick();
    h.render().find(node => node.props["aria-label"] === "投屏全屏").props.onClick();
    h.unmount(); await tick();
    assert.equal(h.document.fullscreenElement, null);
    assert.equal(h.host.fullscreen, initiallyFullscreen);
  }
});

test("a reopened tab discovers a device plugged in after an empty scan and stops polling while inactive", async () => {
  let devices = [];
  const h = harness({ discover: () => devices });
  h.render(); await tick();
  assert.ok(h.render().some(node => node.type === "option" && node.children.includes("未发现设备")));
  devices = [{ serial: "phone", status: "unauthorized", model: "Phone" }];
  h.poll(); await tick();
  assert.ok(h.render().some(node => node.type === "option" && node.props.value === "phone" && node.props.disabled));
  devices = [{ ...devices[0], status: "device" }];
  h.poll(); await tick();
  assert.equal(h.render().find(node => node.props["aria-label"] === "Android 设备").props.value, "phone");
  h.render(false);
  const count = h.calls.length;
  h.poll(); await tick(); assert.equal(h.calls.length, count);
  h.render(); await tick(); assert.equal(h.calls.length, count + 1);
  h.unmount();
});

test("manual refresh requests offline recovery and overlapping scans are skipped", async () => {
  let finish;
  const h = harness({ discover: () => new Promise(resolve => { finish = resolve; }) });
  h.render(); h.poll();
  assert.equal(h.calls.filter(call => call.command === "mirror_devices").length, 1);
  finish([]); await tick();
  h.render().find(node => node.props["aria-label"] === "刷新设备").props.onClick();
  assert.equal(h.calls.at(-1).args.recover, true);
  h.poll(); assert.equal(h.calls.length, 2);
  finish([{ serial: "phone", status: "device", model: "Phone" }]); await tick();
  assert.equal(h.render().find(node => node.props["aria-label"] === "Android 设备").props.value, "phone");
  h.unmount();
});

test("cancelling startup closes the decoder and cleans up a session that finishes starting late", async () => {
  const h = harness({ delayedStart: true });
  h.render(); await tick();
  connect(h.render());
  await tick();
  assert.equal(h.calls.filter(call => call.command === "mirror_start").length, 1);
  h.render().find(node => node.type === "button" && node.children.includes("取消连接")).props.onClick();
  assert.equal(h.decoders[0].state, "closed");
  assert.equal(h.render().find(node => node.children.includes("正在断开…")).props.disabled, true);
  await tick();
  assert.equal(h.render().some(node => node.children.includes("连接")), false);
  h.releaseStart(); await tick();
  assert.equal(h.calls.filter(call => call.command === "mirror_stop").length, 2);
  h.unmount();
});

test("reconnect waits for both backend stop and audio context closure, including stale click handlers", async () => {
  const h = harness({ delayedStop: true, delayedAudioClose: true });
  h.render(); await tick();
  const staleConnect = h.render().find(node => node.children.includes("连接")).props.onClick;
  staleConnect(); await tick();
  h.render().find(node => node.children.includes("断开")).props.onClick();
  staleConnect(); await tick();
  assert.equal(h.calls.filter(call => call.command === "mirror_start").length, 1);
  assert.equal(h.render().find(node => node.children.includes("正在断开…")).props.disabled, true);
  h.releaseStop(); await tick();
  assert.equal(h.render().some(node => node.children.includes("连接")), false);
  h.releaseAudioClose(); await tick();
  connect(h.render()); await tick();
  assert.equal(h.calls.filter(call => call.command === "mirror_start").length, 2);
  h.unmount(); await tick();
});

test("closing a tab during startup still stops the late session without updating an unmounted panel", async () => {
  const h = harness({ delayedStart: true });
  h.render(); await tick(); connect(h.render()); await tick();
  const id = h.calls.find(call => call.command === "mirror_start").args.id;
  h.unmount(); await tick();
  assert.equal(h.calls.filter(call => call.command === "mirror_stop" && call.args.id === id).length, 1);
  h.releaseStart(); await tick();
  assert.equal(h.calls.filter(call => call.command === "mirror_stop" && call.args.id === id).length, 2);
});

test("H.264 config, keyframe recovery, background skipping and pointer coordinates follow the scrcpy protocol", async () => {
  const h = harness(); h.render(); await tick(); connect(h.render()); await tick();
  const config = [0, 0, 0, 1, 0x67, 0x42, 0, 0x1e, 0, 0, 1, 0x68, 1];
  const key = [0, 0, 1, 0x65];
  h.packet(0x80, config, Date.now());
  assert.equal(h.decoders[0].config.codec, "avc1.42001e");
  h.packet(0, [0, 0, 1, 0x61]); assert.equal(h.decoders[0].chunks.length, 0);
  h.packet(0x40, key, Date.now()); assert.equal(h.decoders[0].chunks.length, 1);
  assert.equal(h.decoders[0].chunks[0].timestamp, 123);
  assert.deepEqual([...h.decoders[0].chunks[0].data], [...config, ...key]);
  h.render(false); h.packet(0x40, [0, 0, 1, 0x65]); assert.equal(h.decoders[0].chunks.length, 1);
  const canvas = h.render().find(node => node.type === "canvas");
  const target = { width: 1080, height: 1920, focus() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 10, top: 20, width: 270, height: 480 }) };
  const event = { pointerId: 1, button: 0, clientX: 145, clientY: 260, currentTarget: target, preventDefault() {} };
  canvas.props.onPointerDown(event); canvas.props.onPointerUp(event); await tick();
  const controls = h.calls.filter(call => call.command === "mirror_control" && call.args.data[0] === 2);
  assert.equal(controls.length, 2);
  assert.equal(h.calls.some(call => call.command === "mirror_control" && call.args.data[0] === 0), false);
  const down = new DataView(Uint8Array.from(controls[0].args.data).buffer);
  assert.equal(down.byteLength, 32); assert.equal(down.getUint8(0), 2); assert.equal(down.getUint8(1), 0);
  assert.equal(down.getUint32(10), 540); assert.equal(down.getUint32(14), 960);
  assert.equal(down.getUint16(18), 1080); assert.equal(down.getUint16(20), 1920);
  assert.equal(controls[1].args.data[1], 1);
  canvas.props.onPointerDown({ ...event, button: 2 }); await tick();
  assert.deepEqual(h.calls.filter(call => call.command === "mirror_control" && call.args.data[0] === 0)
    .map(call => [call.args.data[1], new DataView(Uint8Array.from(call.args.data).buffer).getUint32(2)]), [[0, 4], [1, 4]]);
  h.unmount();
});

test("the worker reports packet delay and time from an overload reset to the first new drawing", () => {
  const messages = [];
  const decoders = [];
  let now = 0, report;
  const bindings = {
    ...metrics,
    self: { postMessage: message => messages.push(message) },
    WebSocket: class {
      constructor(url) { this.url = url; bindings.socket = this; }
      send(value) { this.sent = value; }
      close() { this.closed = true; }
    },
    performance: { timeOrigin: 1000, now: () => now },
    setInterval: callback => { report = callback; },
    clearInterval: () => { report = undefined; },
    EncodedVideoChunk: class { constructor(chunk) { Object.assign(this, chunk); } },
    VideoDecoder: class {
      decodeQueueSize = 0;
      constructor(callbacks) { this.callbacks = callbacks; decoders.push(this); }
      configure() { this.state = "configured"; }
      close() { this.state = "closed"; }
      decode(chunk) { this.chunk = chunk; }
    },
  };
  const workerSource = readFileSync(new URL("../src/workers/androidMirror.worker.js", import.meta.url), "utf8");
  new Function(...Object.keys(bindings), workerSource.replace(/^import .*;\r?$/gm, ""))(...Object.values(bindings));
  const send = data => bindings.self.onmessage({ data });
  send({ type: "init", canvas: { width: 720, height: 1280, getContext: () => ({ drawImage: () => { now += 2; } }) } });
  const makePacket = (flag, bytes) => {
    const data = new ArrayBuffer(12 + bytes.length);
    const view = new DataView(data);
    view.setBigUint64(0, BigInt(flag) << 56n | 123n);
    view.setUint32(8, bytes.length);
    new Uint8Array(data).set(bytes, 12);
    return data;
  };
  const packet = (flag, bytes, forwardedAt) =>
    send({ type: "packet", id: "mirror", data: makePacket(flag, bytes), forwardedAt });
  send({ type: "start", id: "mirror", visible: true });
  packet(0x80, [0, 0, 0, 1, 0x67, 0x42, 0, 0x1e], 1000);
  packet(0x40, [0, 0, 1, 0x65], 1000);
  decoders[0].decodeQueueSize = 4;
  now = 10;
  packet(0, [0, 0, 1, 0x61], 1010);
  assert.equal(decoders.length, 1);
  decoders[0].decodeQueueSize = 8;
  now = 20;
  packet(0, [0, 0, 1, 0x61], 1005);
  now = 30;
  packet(0x40, [0, 0, 1, 0x65], 1025);
  now = 40;
  decoders[1].callbacks.output({ timestamp: 123, displayWidth: 720, displayHeight: 1280, close() {} });
  now = 1000;
  report();
  const stats = messages.find(message => message.type === "stats");
  assert.equal(stats.id, "mirror");
  assert.equal(stats.queueResets, 1);
  assert.equal(stats.waitingDrops, 1);
  assert.equal(stats.pageToWorkerMs.max, 15);
  assert.equal(stats.decodeToOutputMs.max, 10);
  assert.equal(stats.drawCallMs.max, 2);
  assert.equal(stats.resetToDrawMs.max, 22);
  send({ type: "stop", id: "mirror" });
  assert.equal(report, undefined);

  send({ type: "start", id: "mirror", visible: true });
  send({ type: "socket", id: "old-session", url: "ws://127.0.0.1:12345/old" });
  assert.equal(bindings.socket, undefined);
  send({ type: "socket", id: "mirror", url: "ws://127.0.0.1:12345/token" });
  const socket = bindings.socket;
  socket.onopen();
  socket.onmessage({ data: makePacket(0x80, [0, 0, 0, 1, 0x67, 0x42, 0, 0x1e]) });
  socket.onmessage({ data: makePacket(0x40, [0, 0, 1, 0x65]) });
  assert.equal(socket.sent, "ack");
  report();
  assert.equal(messages.at(-1).transport, "socket");
  packet(0x80, [0, 0, 0, 1, 0x67, 0x42, 0, 0x1e], 2000);
  assert.equal(socket.closed, true);
  report();
  assert.equal(messages.at(-1).transport, "ipc");
  send({ type: "stop", id: "mirror" });
});
