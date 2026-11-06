import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../src/lib/codexNetwork.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

function setup(invoke, desktop = true) {
  const timers = new Map();
  let id = 0;
  const context = vm.createContext({ exports: {}, require: () => ({ invoke, isTauri: () => desktop }),
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: key => timers.delete(key) });
  vm.runInContext(js, context);
  return { watch: context.exports.watchCodexNetwork, timers };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Codex polling advances its cursor, reports unknown metrics, and stops on cleanup', async () => {
  const calls = [], items = [], statuses = [];
  const { watch, timers } = setup(async (command, args) => {
    calls.push({ command, cursor: args.cursor });
    return { cursor: 42, available: true, requests: calls.length === 1 ? [{ id: 42, method: 'POST', url: 'https://example.com/responses', status: 200 }] : [] };
  });
  const stop = watch(item => items.push(item), status => statuses.push(status));
  await tick();
  assert.equal(calls[0].command, 'codex_network_requests');
  assert.equal(calls[0].cursor, null);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'codex');
  assert.equal(items[0].metricsUnavailable, true);
  assert.equal(items[0].id, -42);
  const [key, poll] = [...timers.entries()][0];
  timers.delete(key);
  poll();
  await tick();
  assert.equal(calls[1].cursor, 42);
  stop();
  assert.equal(timers.size, 0);
});

test('cleanup suppresses pending results and retries after read errors', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const items = [], statuses = [];
  const first = setup(() => pending);
  const stop = first.watch(item => items.push(item), status => statuses.push(status));
  stop();
  finish({ cursor: 1, available: true, requests: [{ id: 1 }] });
  await tick();
  assert.equal(items.length, 0);
  assert.equal(statuses.length, 0);
  assert.equal(first.timers.size, 0);
  const second = setup(async () => { throw new Error('locked'); });
  const cancel = second.watch(() => {}, status => statuses.push(status));
  await tick();
  assert.equal(statuses.length, 1);
  assert.equal(second.timers.size, 1);
  cancel();
});

test('browser preview does not invoke desktop commands', () => {
  const { watch } = setup(() => assert.fail('desktop invocation'), false);
  const statuses = [];
  watch(() => assert.fail('unexpected request'), status => statuses.push(status))();
  assert.equal(statuses.length, 1);
});
