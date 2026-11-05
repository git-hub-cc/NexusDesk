import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/components/git/GitPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('GitPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let runSource;
let commitSource;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'run') runSource = node.getText(ast);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'run' &&
      ts.isArrowFunction(node.arguments[0]) && node.arguments[0].getText(ast).includes('gitApi.commit(')) {
    commitSource = node.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(runSource && commitSource);
const compiled = ts.transpileModule(`${runSource}\nreturn ${commitSource};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

async function submit({ failSave = false, failStage = false } = {}) {
  let disk = 'old';
  let index = 'old';
  let committed;
  let error;
  const calls = [];
  const execute = new Function('gitApi', 'flushPendingWrites', 'files', 'root', 'message',
    'locked', 'pendingRef', 'mounted', 'setBusy', 'setError', 'setNotice', 'refresh', 'changeMessage', compiled);
  await execute({
    async stage(root, path, staged) {
      calls.push(['stage', path, staged]);
      if (failStage) throw new Error('stage failed');
      index = disk;
    },
    async commit() { calls.push(['commit']); committed = index; return 'abcdef12'; },
  }, async () => {
    calls.push(['save']);
    if (failSave) throw new Error('save failed');
    disk = 'latest editor content';
  }, [
    { path: 'notes/a.md', staged: true },
    { path: 'other/a.md', staged: false },
    { path: 'deleted.md', staged: true },
  ], '/repo', 'message', { current: false }, { current: new Set() }, { current: true },
  () => {}, value => { error = value; }, () => {}, async () => {}, () => {});
  return { calls, committed, error };
}

test('commit includes flushed edits and restages only selected paths before committing', async () => {
  const result = await submit();
  assert.equal(result.committed, 'latest editor content');
  assert.deepEqual(result.calls, [
    ['save'], ['stage', 'notes/a.md', true], ['stage', 'deleted.md', true], ['commit'],
  ]);
  assert.equal(result.error, '');
});

test('save or restage failure prevents commit', async () => {
  for (const options of [{ failSave: true }, { failStage: true }]) {
    const result = await submit(options);
    assert.equal(result.committed, undefined);
    assert.ok(result.error.includes('failed'));
    assert.equal(result.calls.some(call => call[0] === 'commit'), false);
  }
});
