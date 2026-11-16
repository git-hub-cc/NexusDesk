import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import ts from 'typescript';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function cloneDialog({ onClone, cancelClone = async () => true }) {
  const states = [], refs = [], timers = [], cancellations = [];
  let stateCursor = 0, refCursor = 0, closed = false;
  const source = readFileSync(new URL('../src/components/layout/CloneProjectDialog.tsx', import.meta.url), 'utf8').replace(/^import .*;\r?$/gm, '');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, React, useEffect() {}, useId: () => 'clone',
    useState(initial) {
      const index = stateCursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef(initial) { return refs[refCursor++] ??= { current: initial }; },
    crypto: { randomUUID: () => `request-${refs.length}-${cancellations.length}` },
    window: { setTimeout(callback) { timers.push(callback); } },
    settingsStorage: { getItem: () => null }, useWorkspaceStore: select => select({ rootPath: null }),
    validateEntryName: () => null, rememberProjectSaveLocation() {},
    gitApi: { async cancelClone(id) { cancellations.push(id); return cancelClone(id); } },
    Dialog: Object.fromEntries(['Root', 'Title', 'Close'].map(key => [key, `Dialog.${key}`])),
    DialogShell: 'DialogShell', OperationProgress: 'OperationProgress', X: 'X',
  });
  function render() {
    stateCursor = refCursor = 0;
    const nodes = [];
    function visit(node) {
      if (!React.isValidElement(node)) return;
      nodes.push(node);
      React.Children.forEach(node.props.children, visit);
    }
    visit(exports.CloneProjectDialog({ onClone, onClose: () => { closed = true; } }));
    return nodes;
  }
  for (const [name, value] of [['url', 'https://example.invalid/repo.git'], ['name', 'repo'], ['location', 'C:/projects']]) {
    render().find(node => node.props.id === `clone-${name}`).props.onChange({ target: { value } });
  }
  return {
    render, cancellations, timers,
    closed: () => closed,
    submit: () => render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }),
    cancel: () => render().find(node => node.type === 'button' && node.props['aria-label']).props.onClick(),
    progress: () => render().find(node => node.type === 'OperationProgress')?.props.label,
    alerts: () => render().filter(node => node.props.role === 'alert').map(node => node.props.children),
  };
}

test('opening the cloned project disables cancellation and rejects stale clicks', async () => {
  const opening = deferred();
  let cloned;
  const dialog = cloneDialog({ onClone: async (...args) => { cloned = args[4]; await opening.promise; } });
  dialog.submit();
  const staleCancel = dialog.render().find(node => node.type === 'button' && node.props['aria-label']).props.onClick;
  cloned();
  assert.equal(dialog.progress(), '正在打开项目');
  const buttons = dialog.render().filter(node => node.type === 'button' && node.props.onClick);
  assert.ok(buttons.every(node => node.props.disabled));
  staleCancel();
  await tick();
  assert.deepEqual(dialog.cancellations, []);
  opening.resolve();
  await tick();
  assert.equal(dialog.closed(), true);
});

test('early cancellation retries until the backend has registered the request', async () => {
  const cloning = deferred();
  let attempts = 0;
  const dialog = cloneDialog({
    onClone: () => cloning.promise,
    cancelClone: async () => ++attempts > 1,
  });
  dialog.submit();
  dialog.cancel();
  dialog.cancel();
  await tick();
  assert.equal(attempts, 1);
  assert.equal(dialog.progress(), '正在取消克隆');
  dialog.timers.shift()();
  await tick();
  assert.equal(attempts, 2);
  assert.equal(dialog.cancellations[0], dialog.cancellations[1]);
  cloning.reject('克隆已取消');
  await tick();
  assert.equal(dialog.closed(), false);
  assert.ok(dialog.alerts()[0].includes('克隆已取消'));
});

test('cancellation retries stop when cloning finishes before acknowledgement', async () => {
  const opening = deferred();
  let cloned;
  const dialog = cloneDialog({
    onClone: async (...args) => { cloned = args[4]; await opening.promise; },
    cancelClone: async () => false,
  });
  dialog.submit();
  dialog.cancel();
  await tick();
  cloned();
  dialog.timers.shift()();
  await tick();
  assert.equal(dialog.cancellations.length, 1);
  assert.equal(dialog.progress(), '正在打开项目');
  opening.resolve();
  await tick();
});

test('a late cancellation failure does not overwrite the opening stage', async () => {
  const cancellation = deferred(), opening = deferred();
  let cloned;
  const dialog = cloneDialog({
    onClone: async (...args) => { cloned = args[4]; await opening.promise; },
    cancelClone: () => cancellation.promise,
  });
  dialog.submit();
  dialog.cancel();
  cloned();
  cancellation.reject('late error');
  await tick();
  assert.equal(dialog.progress(), '正在打开项目');
  assert.deepEqual(dialog.alerts(), []);
  opening.resolve();
  await tick();
});

test('a cancellation error restores the cloning stage and permits retry', async () => {
  const cloning = deferred();
  let attempts = 0;
  const dialog = cloneDialog({
    onClone: () => cloning.promise,
    cancelClone: async () => {
      if (++attempts === 1) throw new Error('temporary failure');
      return true;
    },
  });
  dialog.submit();
  dialog.cancel();
  await tick();
  assert.equal(dialog.progress(), '正在克隆仓库');
  assert.ok(dialog.alerts()[0].includes('temporary failure'));
  dialog.cancel();
  await tick();
  assert.equal(attempts, 2);
  cloning.reject('克隆已取消');
  await tick();
});
