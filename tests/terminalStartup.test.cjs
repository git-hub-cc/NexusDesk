const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

test('terminal preserves early TUI probe replies and passes alternate-screen keys through', async () => {
  const effects = [];
  const writes = [];
  let terminal, channel, finishStart;
  const starts = [];
  const sizes = [];
  const startSizes = [];
  const observers = [];
  const windowHandlers = new Map();
  let finishResize;
  let holdResize = false;
  const frames = new Map();
  let frameId = 0;
  const flushLayout = async () => {
    await Promise.resolve();
    for (let i = 0; i < 3; i++) {
      const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback());
    }
    await new Promise(resolve => setImmediate(resolve));
  };
  const wheelHandlers = [];
  const element = { clientWidth: 800, clientHeight: 400, toggleAttribute() {}, addEventListener(type, handler) { if (type === 'wheel') wheelHandlers.push(handler); }, removeEventListener() {} };
  class MockTerminal {
    options = {};
    constructor(options) { terminal = this; this.options = options; this.buffer = { active: { type: 'normal', baseY: 100, getLine: row => ({ translateToString: () => this.lines?.[row] ?? '' }) } }; this.cols = 80; this.rows = 24; this.parser = {}; }
    onWriteParsed(handler) { this.parsed = handler; return { dispose() {} }; }
    attachCustomKeyEventHandler(handler) { this.keys = handler; }
    scrollLines(lines) { this.scrolled = (this.scrolled ?? 0) + lines; }
    unicode = {};
    loadAddon(addon) { addon.activate?.(this); } open() {} focus() {} dispose() {}
    registerLinkProvider(provider) { this.links = provider; return { dispose() {} }; }
    onData(handler) { this.data = handler; return { dispose() {} }; }
    input(data) { this.data(data); }
    write() { this.data('\x1b[1;1R'); }
    writeln() {} hasSelection() { return false; }
  }
  const mocks = {
    react: { useRef: value => ({ current: value === null ? element : value }), useState: value => [value, () => {}], useEffect: effect => effects.push(effect) },
    '@/lib/terminalHistory': { matchTerminalHistory: () => [], terminalPromptInput: () => undefined },
    '@/lib/speechTarget': { getSpeechTarget: () => null, setSpeechTarget() {} },
    'react/jsx-runtime': { jsx() {}, jsxs() {} },
    '@tauri-apps/api/core': {
      Channel: class { constructor() { channel = this; } },
      invoke: async (command, args) => {
        if (command === 'load_terminal_history') return [];
        if (command === 'start_terminal') {
          starts.push(args.id);
          startSizes.push(args);
          channel.onmessage({ type: 'output', data: [27, 91, 54, 110] });
          await new Promise(resolve => { finishStart = resolve; });
        } else if (command === 'write_terminal') writes.push(args.data);
        else if (command === 'resize_terminal') {
          sizes.push(args);
          if (holdResize) await new Promise(resolve => { finishResize = resolve; });
        }
      },
    },
    '@xterm/xterm': { Terminal: MockTerminal },
    '@xterm/addon-fit': { FitAddon: class {
      activate(instance) { this.terminal = instance; }
      fit() {
        this.terminal.cols = Math.floor(element.clientWidth / 10);
        this.terminal.rows = Math.floor(element.clientHeight / 20);
      }
    } },
    '@xterm/addon-unicode11': { Unicode11Addon: class {} },
  };
  const context = {
    navigator: { userAgent: 'Windows' },
    exports: {}, require: name => mocks[name] ?? {},
    crypto: { randomUUID: () => 'test' },
    window: { clearTimeout, setTimeout,
      addEventListener(type, handler) {
        if (!windowHandlers.has(type)) windowHandlers.set(type, new Set());
        windowHandlers.get(type).add(handler);
      },
      removeEventListener(type, handler) { windowHandlers.get(type)?.delete(handler); },
    }, setTimeout, clearTimeout,
    document: { fonts: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} } },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { constructor(callback) { observers.push(callback); } observe() {} disconnect() {} },
  };
  const source = fs.readFileSync(`${__dirname}/../src/components/layout/TerminalSession.tsx`, 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, context);
  context.exports.TerminalSession({ session: { id: 'session', command: 'codex', cwd: '/work' }, active: false });
  effects[0]();
  const cleanup = effects[1]();
  assert.equal(terminal.options.windowsPty.backend, 'conpty', 'local Windows PTY uses ConPTY resize and reflow compatibility');
  assert.equal(terminal.options.altClickMovesCursor, false, 'Alt-click cannot reposition the terminal cursor');
  assert.equal(terminal.keys({ type: 'keydown', key: 'Alt', altKey: true }), false, 'Alt does not activate xterm selection mode');
  assert.equal(terminal.keys({ type: 'keyup', key: 'Alt', altKey: false }), false, 'Alt release does not activate xterm selection mode');
  assert.match(fs.readFileSync(`${__dirname}/../src/App.css`, 'utf8'), /\.terminal-host \.xterm\.column-select\.focus\s*\{\s*cursor:\s*text\s*!important;/, 'xterm column-select state keeps a text pointer under Alt+Ctrl');
  let prevented = 0, stopped = 0;
  const wheel = { deltaY: -3, deltaMode: 1, preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
  wheelHandlers[0](wheel);
  assert.equal(terminal.scrolled, -3, 'Codex wheel scrolls history instead of sending mouse input');
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  terminal.buffer.active.type = 'alternate';
  wheelHandlers[0](wheel);
  assert.equal(terminal.scrolled, -3, 'alternate-screen applications retain their own wheel handling');
  terminal.buffer.active.type = 'normal';
  wheelHandlers[0]({ ...wheel, ctrlKey: true });
  assert.equal(terminal.scrolled, -3, 'Ctrl+wheel remains available for zoom');
  assert.equal(starts.length, 0, "PTY waits for stable visible layout");
  element.clientWidth = 960;
  await flushLayout();
  assert.equal(startSizes[0].pixelWidth, 960, "startup uses settled container pixels");
  assert.equal(startSizes[0].command, 'codex --no-alt-screen', 'default Codex startup preserves scrollback');
  assert.deepEqual(writes, [], 'probe reply waits until the backend registers its session');
  const finishFirst = finishStart;
  const firstTerminal = terminal;
  const nextEffect = effects.length;
  context.exports.TerminalSession({ session: { id: 'second', command: 'codex', cwd: '/work' }, active: false });
  effects[nextEffect]();
  const cleanupSecond = effects[nextEffect + 1]();
  await flushLayout();
  assert.equal(starts.length, 2, 'a pending PTY startup must not block another session');
  finishStart();
  finishFirst();
  terminal = firstTerminal;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, ['\x1b[1;1R', '\x1b[1;1R'], 'startup probe reply reaches the PTY');
  terminal.buffer.active.type = 'alternate';
  assert.equal(terminal.keys({ type: 'keydown', ctrlKey: true, key: 'a' }), true);
  assert.equal(terminal.keys({ type: 'keydown', ctrlKey: true, key: 'c' }), true, 'Ctrl+C without a selection reaches the PTY');
  assert.equal(terminal.keys({ type: 'keydown', key: 'ArrowUp' }), true, 'arrow keys reach the terminal application');
  terminal.hasSelection = () => true;
  let copied = '';
  terminal.getSelection = () => 'selected text';
  terminal.clearSelection = () => { terminal.selectionCleared = true; };
  context.navigator.clipboard = { writeText: value => { copied = value; } };
  assert.equal(terminal.keys({ type: 'keydown', ctrlKey: true, key: 'c' }), false, 'Ctrl+C copies an active selection');
  assert.equal(copied, 'selected text');
  assert.equal(terminal.selectionCleared, true);
  let links;
  terminal.links.provideLinks(1, value => { links = value; });
  assert.equal(links.length, 0);
  const before = sizes.length;
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(sizes.length, before, 'output never triggers artificial PTY resizes');
  assert.equal(sizes.length, 0, 'startup dimensions need no redundant resize');
  cleanupSecond();
  for (let width = 700; width <= 900; width += 20) {
    element.clientWidth = width;
    element.clientHeight = width - 100;
    observers[0]();
  }
  assert.equal(sizes.length, 0, 'size changes within a frame are coalesced');
  await flushLayout();
  assert.equal(sizes.length, 1, 'splitter changes resize the Codex PTY once per frame');
  assert.equal(terminal.rows, 40, 'growing the panel expands the terminal grid');
  assert.equal(sizes[0].rows, 40, 'PTY receives the expanded row count');
  assert.equal(sizes[0].cols, 90);
  assert.equal(sizes[0].pixelHeight, 800);
  observers[0]();
  await flushLayout();
  assert.equal(sizes.length, 1, 'unchanged container observations do not resize the PTY');
  element.clientHeight = 300;
  observers[0]();
  await flushLayout();
  assert.equal(terminal.rows, 15, 'shrinking the panel also updates the terminal grid');
  assert.equal(sizes.length, 2);
  assert.equal(sizes[1].rows, 15);
  element.clientHeight = 309;
  observers[0]();
  await flushLayout();
  assert.equal(sizes.length, 2, 'pixel changes within the same row do not redraw the console');

  windowHandlers.get('terminal-panel-drag').forEach(handler => handler({ detail: true }));
  for (const height of [400, 500, 200, 600]) {
    element.clientHeight = height;
    observers[0]();
    await flushLayout();
    assert.equal(terminal.rows, 15, 'dragging preserves the grid until release');
    assert.equal(sizes.length, 2, 'dragging does not request intermediate ConPTY redraws');
  }
  windowHandlers.get('terminal-panel-drag').forEach(handler => handler({ detail: false }));
  await flushLayout();
  assert.equal(sizes.length, 3, 'release applies the final size once');
  assert.equal(terminal.rows, 30);
  assert.equal(sizes[2].rows, 30);

  holdResize = true;
  element.clientHeight = 400;
  observers[0]();
  await flushLayout();
  assert.equal(sizes.length, 4);
  for (const height of [500, 700, 800]) {
    element.clientHeight = height;
    observers[0]();
    await flushLayout();
    assert.equal(terminal.rows, 20, 'grid waits for an in-flight PTY resize');
  }
  holdResize = false;
  finishResize();
  await flushLayout();
  assert.equal(sizes.length, 5, 'queued layout changes collapse to the latest size');
  assert.equal(sizes[4].rows, 40);
  assert.equal(terminal.rows, 40);
  cleanup();
});
