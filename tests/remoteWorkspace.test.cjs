const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const loadRemote = require('./helpers/loadRemote.cjs');

test('existing file API routes SFTP tree entries, reads, writes and renames to the right server', async () => {
  const calls = [];
  const remote = loadRemote(async (command, args) => {
    calls.push({ command, args });
    if (args.operation === 'list') return [ { name: 'Folder', path: '/home/Folder', directory: true }, { name: 'a #%.txt', path: '/home/a #%.txt', directory: false } ];
    if (args.operation === 'read') return 'remote contents';
    if (args.operation === 'rename') return args.content;
  });
  const context = { exports: {}, require: name => name === './remote' ? remote : {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/api.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
  const api = context.exports.fsApi;
  const tree = await api.readDirectory('sftp://server-1/home');
  assert.equal(tree[0].id, 'sftp://server-1/home/Folder');
  assert.deepEqual(Array.from(tree[0].children), []);
  assert.equal(tree[1].id, 'sftp://server-1/home/a #%.txt');
  assert.equal(tree[1].children, undefined, 'Arborist must treat remote files as leaves');
  assert.equal(await api.readFile(tree[1].id), 'remote contents');
  await api.writeFile(tree[1].id, 'sftp://literal-content/keep-this');
  assert.equal(calls.at(-1).args.content, 'sftp://literal-content/keep-this');
  assert.equal(calls.at(-1).args.path, '/home/a #%.txt');
  assert.equal(await api.renameEntry(tree[1].id, 'new.txt'), 'sftp://server-1/home/new.txt');
  assert.ok(calls.every(call => call.command === 'remote_files' && call.args.id === 'server-1'));
  const count = calls.length;
  await assert.rejects(api.copyFileToDir('C:/local.txt', 'sftp://server-1/home'), /不支持/);
  await assert.rejects(api.moveEntry('sftp://server-1/a', 'sftp://server-2/home'), /跨服务器/);
  await assert.rejects(api.moveEntry('C:/local.txt', 'sftp://server-1/home'), /本地与远程/);
  await assert.rejects(api.writeFileClipboard([tree[1].id], false), /不支持/);
  assert.equal(calls.length, count, 'unsupported remote operations must never hit the local filesystem');
  await api.writeFile('C:/local.txt', 'sftp://this-is-content/not-a-path');
  assert.equal(calls.at(-1).command, 'write_file');
});

test('shared TerminalSession starts separate remote shells, preserves early replies, and only closes its own channel', async () => {
  const effects = [], calls = [], terminals = [], channels = [], starts = [];
  const element = { clientWidth: 800, clientHeight: 300, addEventListener() {}, removeEventListener() {} };
  class MockTerminal {
    constructor() {
      terminals.push(this); this.cols = 100; this.rows = 30;
      this.buffer = { active: { type: 'normal' } };
      this.parser = { registerCsiHandler: () => ({ dispose() {} }) };
    }
    unicode = {};
    loadAddon() {} open() {} focus() {} dispose() { this.disposed = true; }
    attachCustomKeyEventHandler() {}
    onWriteParsed() { return { dispose() {} }; }
    registerLinkProvider() { return { dispose() {} }; }
    onData(handler) { this.input = handler; return { dispose() {} }; }
    write() { assert.ok(!this.disposed); this.input('\x1b[1;1R'); }
    writeln() {}
  }
  const mocks = {
    react: { useRef: value => ({ current: value === null ? element : value }), useEffect: fn => effects.push(fn) },
    'react/jsx-runtime': { jsx() {}, jsxs() {} },
    '@tauri-apps/api/core': {
      Channel: class { constructor() { channels.push(this); } },
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === 'start_remote_terminal') {
          channels[starts.length].onmessage({ type: 'output', data: [27, 91, 54, 110] });
          await new Promise(resolve => starts.push(resolve));
        }
      },
    },
    '@/lib/remote': loadRemote(),
    '@xterm/xterm': { Terminal: MockTerminal },
    '@xterm/addon-fit': { FitAddon: class { fit() {} } },
    '@xterm/addon-unicode11': { Unicode11Addon: class {} },
  };
  let sequence = 0;
  const context = { exports: {}, require: name => mocks[name] ?? {}, crypto: { randomUUID: () => `shell-${++sequence}` },
    window: { addEventListener() {}, removeEventListener() {}, clearTimeout, setTimeout }, setTimeout, clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/components/layout/TerminalSession.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
  const mount = id => {
    const before = effects.length;
    context.exports.TerminalSession({ session: { id, remoteId: 'server-1', cwd: 'sftp://server-1/home', name: 'SSH', command: '' }, active: false });
    effects[before]();
    return effects[before + 1]();
  };
  const cleanup1 = mount('tab-1');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].command, 'start_remote_terminal');
  assert.equal(calls[0].args.id, 'server-1');
  assert.equal(calls[0].args.cwd, '/home');
  assert.equal(calls.filter(call => call.command === 'write_remote_terminal').length, 0);
  starts[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.find(call => call.command === 'write_remote_terminal').args.data, '\x1b[1;1R');
  const cleanup2 = mount('tab-2');
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(starts.length, 2);
  starts[1]();
  await new Promise(resolve => setImmediate(resolve));
  const startCalls = calls.filter(call => call.command === 'start_remote_terminal');
  assert.notEqual(startCalls[0].args.terminalId, startCalls[1].args.terminalId);
  cleanup1();
  await new Promise(resolve => setImmediate(resolve));
  const close = calls.find(call => call.command === 'close_remote_terminal');
  assert.equal(close.args.terminalId, startCalls[0].args.terminalId);
  terminals[1].input('echo still-alive\r');
  assert.equal(calls.at(-1).args.terminalId, startCalls[1].args.terminalId);
  assert.ok(!calls.some(call => call.command === 'close_remote' || call.command === 'start_terminal'));
  cleanup2();
});
