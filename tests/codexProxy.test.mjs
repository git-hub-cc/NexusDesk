import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../src/lib/codexProxy.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
function setup(invoke, desktop = true) {
  const timers = new Map();
  let id = 0;
  const context = vm.createContext({ exports: {}, require: () => ({ invoke, isTauri: () => desktop }),
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: key => timers.delete(key) });
  vm.runInContext(js, context);
  return { ...context.exports, timers };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('proxy launch overrides only the selected provider URL and transport', () => {
  const { codexProxyLaunchCommand } = setup();
  const command = codexProxyLaunchCommand('custom_proxy', 'http://127.0.0.1:1234/v1');
  assert.ok(command.includes('model_providers.custom_proxy.base_url="http://127.0.0.1:1234/v1"'));
  assert.ok(command.includes('model_providers.custom_proxy.supports_websockets=false'));
  assert.ok(command.startsWith('codex --no-alt-screen '));
  assert.ok(!command.includes('model_provider='), 'preserves provider credentials and other settings');
});

test('proxy polling preserves metrics and updates a stable ID as a stream completes', async () => {
  const calls = [], items = [], infos = [];
  const monitor = setup(async (command, args) => {
    calls.push([command, args.cursor]);
    return { cursor: calls.length, info: { running: true }, requests: [{ id: 7, status: 200,
      requestBytes: 123, responseBytes: calls.length * 10, timeMs: 50, inFlight: calls.length === 1 }] };
  });
  const stop = monitor.watchCodexProxy(item => items.push(item), info => infos.push(info));
  await tick();
  assert.deepEqual(calls[0], ['codex_proxy_requests', null]);
  const [key, poll] = [...monitor.timers.entries()][0];
  monitor.timers.delete(key); poll(); await tick();
  assert.deepEqual(calls[1], ['codex_proxy_requests', 1]);
  assert.equal(items[0].id, items[1].id);
  assert.equal(items[0].captureMode, 'proxy');
  assert.equal(items[0].source, 'codex');
  assert.equal(items[0].requestBytes, 123);
  assert.equal(items[1].responseBytes, 20);
  assert.equal(items[1].inFlight, false);
  assert.ok(items[0].id < -1_000_000_000_000, 'does not collide with browser and log record IDs');
  stop(); assert.equal(monitor.timers.size, 0);
});

test('proxy shutdown resets cursor and cleanup suppresses late responses', async () => {
  const calls = [];
  let finish;
  const monitor = setup(async (_command, args) => {
    calls.push(args.cursor);
    if (calls.length === 1) return { cursor: 50, info: { running: false }, requests: [] };
    return new Promise(resolve => { finish = resolve; });
  });
  const items = [];
  const stop = monitor.watchCodexProxy(item => items.push(item), () => {});
  await tick();
  const [key, poll] = [...monitor.timers.entries()][0];
  monitor.timers.delete(key); poll(); await tick();
  assert.deepEqual(calls, [null, null]);
  stop();
  finish({ cursor: 1, info: { running: true }, requests: [{ id: 1 }] });
  await tick();
  assert.equal(items.length, 0);
  assert.equal(monitor.timers.size, 0);
});

test('browser preview never starts a proxy or polls desktop state', async () => {
  const monitor = setup(() => assert.fail('desktop invocation'), false);
  monitor.watchCodexProxy(() => assert.fail(), () => assert.fail())();
  assert.equal((await monitor.getCodexProxyStatus()).running, false);
  assert.equal((await monitor.detectCodexProvider()).upstreamUrl, null);
});
