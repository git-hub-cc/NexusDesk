import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/fileOperationHistory.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { FileOperationHistory } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('rename, move and deletion undo in reverse order and redo in order', async () => {
  const history = new FileOperationHistory();
  const files = new Map([['a.txt', 'original bytes']]);
  const move = (from, to) => {
    assert.ok(files.has(from)); assert.ok(!files.has(to));
    files.set(to, files.get(from)); files.delete(from);
    history.record({ undo: async () => move(to, from), redo: async () => move(from, to) });
  };
  move('a.txt', 'renamed.txt');
  move('renamed.txt', 'folder/renamed.txt');
  move('folder/renamed.txt', 'trash/renamed.txt');
  await history.replay(); await history.replay(); await history.replay();
  assert.deepEqual([...files], [['a.txt', 'original bytes']]);
  await history.replay(true); await history.replay(true); await history.replay(true);
  assert.deepEqual([...files], [['trash/renamed.txt', 'original bytes']]);
});

test('failed undo is retryable, new changes discard redo, project changes discard history', async () => {
  const history = new FileOperationHistory();
  history.selectProject('one');
  let conflict = true, count = 0;
  history.record({ undo: async () => { if (conflict) throw Error('occupied'); count--; }, redo: async () => { count++; } });
  await assert.rejects(history.replay(), /occupied/);
  conflict = false;
  await history.replay(); assert.equal(count, -1);
  history.record({ undo: async () => { count--; }, redo: async () => { count++; } });
  await history.replay(true); assert.equal(count, -1);
  history.selectProject('two'); await history.replay(); assert.equal(count, -1);
});

test('batch undo retries only remaining entries after a conflict', async () => {
  const history = new FileOperationHistory();
  let conflict = true;
  const calls = [];
  history.beginGroup();
  history.record({ undo: async () => { if (conflict) throw Error('occupied'); calls.push('undo a'); }, redo: async () => { calls.push('redo a'); } });
  history.record({ undo: async () => { calls.push('undo b'); }, redo: async () => { calls.push('redo b'); } });
  history.endGroup();
  await assert.rejects(history.replay(), /occupied/);
  conflict = false; await history.replay(); await history.replay(true);
  assert.deepEqual(calls, ['undo b', 'undo a', 'redo a', 'redo b']);
});
