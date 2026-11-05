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

function harness({ delayedStart = false, discover = () => [{ serial: "phone", status: "device", model: "Phone" }], initiallyFullscreen = false, initiallyMaximized = false } = {}) {
  const states = [], refs = [], effects = [], calls = [], decoders = [];
  const timers = new Set();
  const listeners = new Map(), fullscreenCalls = [];
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
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    async exitFullscreen() { throw new Error("DOM fullscreen must not be used by the mirror"); },
  };
  const panel = { async requestFullscreen() { throw new Error("DOM fullscreen must not be used by the mirror"); } };
  const drawnFrames = [];
  const canvas = { width: 300, height: 150, focus() {}, getContext: () => ({ drawImage: frame => drawnFrames.push(frame), clearRect() {} }) };
  let si = 0, ri = 0, ei = 0, currentChannel, releaseStart, now = 0;
  const start = delayedStart ? new Promise(resolve => { releaseStart = resolve; }) : Promise.resolve();
  const bindings = {
    React, TextEncoder, crypto, document, performance: { now: () => now }, getCurrentWindow: () => host,
    setInterval: callback => { timers.add(callback); return callback; },
    clearInterval: callback => timers.delete(callback),
    window: { VideoDecoder: true },
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
    },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
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
  const packet = (flags, bytes) => {
    const buffer = new ArrayBuffer(12 + bytes.length);
    new DataView(buffer).setBigUint64(0, BigInt(flags) << 56n | 123n);
    new DataView(buffer).setUint32(8, bytes.length);
    new Uint8Array(buffer).set(bytes, 12);
    currentChannel.onmessage(buffer);
  };
  return { render, calls, decoders, canvas, drawnFrames, releaseStart, packet, document, host, fullscreenCalls, advance: ms => { now += ms; }, poll: () => timers.forEach(callback => callback()), unmount: () => effects.forEach(effect => effect.cleanup?.()) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const connect = tree => tree.find(node => node.type === "button" && node.children.includes("连接")).props.onClick();

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
  }
  h.unmount();
});

test("one screen power button alternates off and on, then resets after disconnect", async () => {
  const h = harness(); h.render(); await tick(); connect(h.render()); await tick();
  let tree = h.render();
  assert.equal(tree.filter(node => node.type === "button" && ["关闭手机屏幕（投屏继续）", "点亮手机屏幕"].includes(node.props["aria-label"])).length, 1);
  assert.equal(tree.some(node => node.props["aria-label"] === "旋转"), false);
  tree.find(node => node.props["aria-label"] === "关闭手机屏幕（投屏继续）").props.onClick();
  tree = h.render();
  tree.find(node => node.props["aria-label"] === "点亮手机屏幕").props.onClick();
  await tick();
  assert.deepEqual(h.calls.filter(call => call.command === "mirror_control").map(call => call.args.data), [[10, 0], [10, 1]]);
  tree = h.render();
  tree.find(node => node.props["aria-label"] === "关闭手机屏幕（投屏继续）").props.onClick();
  tree = h.render();
  tree.find(node => node.type === "button" && node.children.includes("断开")).props.onClick();
  assert.ok(h.render().find(node => node.props["aria-label"] === "关闭手机屏幕（投屏继续）"));
  h.unmount();
});

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
  assert.equal(h.calls.filter(call => call.command === "mirror_control").length, 0);
  assert.equal(h.calls.filter(call => call.command === "mirror_stop").length, 0);
  h.unmount();
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
  h.releaseStart(); await tick();
  assert.equal(h.calls.filter(call => call.command === "mirror_stop").length, 2);
  h.unmount();
});

test("H.264 config, keyframe recovery, background skipping and pointer coordinates follow the scrcpy protocol", async () => {
  const h = harness(); h.render(); await tick(); connect(h.render()); await tick();
  h.packet(0x80, [0, 0, 0, 1, 0x67, 0x42, 0, 0x1e, 0, 0, 1, 0x68, 1]);
  assert.equal(h.decoders[0].config.codec, "avc1.42001e");
  h.packet(0, [0, 0, 1, 0x61]); assert.equal(h.decoders[0].chunks.length, 0);
  h.packet(0x40, [0, 0, 1, 0x65]); assert.equal(h.decoders[0].chunks.length, 1);
  assert.equal(h.decoders[0].chunks[0].timestamp, 123);
  h.render(false); h.packet(0x40, [0, 0, 1, 0x65]); assert.equal(h.decoders[0].chunks.length, 1);
  const canvas = h.render().find(node => node.type === "canvas");
  const target = { width: 1080, height: 1920, focus() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 10, top: 20, width: 270, height: 480 }) };
  const event = { pointerId: 1, button: 0, clientX: 145, clientY: 260, currentTarget: target, preventDefault() {} };
  canvas.props.onPointerDown(event); canvas.props.onPointerUp(event); await tick();
  const controls = h.calls.filter(call => call.command === "mirror_control");
  assert.equal(controls.length, 2);
  const down = new DataView(Uint8Array.from(controls[0].args.data).buffer);
  assert.equal(down.byteLength, 32); assert.equal(down.getUint8(0), 2); assert.equal(down.getUint8(1), 0);
  assert.equal(down.getUint32(10), 540); assert.equal(down.getUint32(14), 960);
  assert.equal(down.getUint16(18), 1080); assert.equal(down.getUint16(20), 1920);
  assert.equal(controls[1].args.data[1], 1);
  h.unmount();
});
