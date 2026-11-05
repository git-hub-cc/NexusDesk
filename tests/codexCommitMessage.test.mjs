import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/lib/codexCommitMessage.ts', import.meta.url), 'utf8');
function setup(saved = '', beforeWrite = async () => {}) {
  const writes = [];
  const api = {
    isDirectory: async () => true,
    readFile: async () => saved,
    writeFile: async (...args) => { await beforeWrite(...args); writes.push(args); },
  };
  const compiled = ts.transpileModule(source.replace(/^import .*;$/m, '').replace(/export /g, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const helpers = new Function('fsApi', 'window', 'CustomEvent', compiled + '\nreturn {fillCodexCommitMessage, rememberCommitDraft, codexComposerInput};')(
    api, { dispatchEvent() {} }, class { constructor(type, options) { Object.assign(this, options); } },
  );
  return { ...helpers, writes };
}

test('Codex fills an empty draft and appends to existing or edited descriptions', async () => {
  const empty = setup('  ');
  await empty.fillCodexCommitMessage('repo', '修复保存问题');
  assert.deepEqual(empty.writes, [['repo/.git/noteide_commit_msg.txt', '修复保存问题']]);
  await empty.fillCodexCommitMessage('repo', 'another prompt');
  assert.deepEqual(empty.writes[1], ['repo/.git/noteide_commit_msg.txt', '修复保存问题\nanother prompt']);
  const existing = setup('existing');
  await existing.fillCodexCommitMessage('repo', 'new');
  assert.deepEqual(existing.writes, [['repo/.git/noteide_commit_msg.txt', 'existing\nnew']]);
  const edited = setup();
  const pending = edited.fillCodexCommitMessage('repo', 'new');
  edited.rememberCommitDraft('repo', 'manual edit');
  await pending;
  assert.deepEqual(edited.writes, [['repo/.git/noteide_commit_msg.txt', 'manual edit\nnew']]);
});

test('serializes concurrent Codex drafts so an older write cannot erase a newer prompt', async () => {
  let releaseFirst;
  let firstWriteStarted;
  const firstWrite = new Promise(resolve => { releaseFirst = resolve; });
  const started = new Promise(resolve => { firstWriteStarted = resolve; });
  let calls = 0;
  const state = setup('', async () => {
    calls++;
    if (calls === 1) { firstWriteStarted(); await firstWrite; }
  });
  const first = state.fillCodexCommitMessage('repo', 'first');
  await started;
  const second = state.fillCodexCommitMessage('repo', 'second');
  assert.equal(calls, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(state.writes, [
    ['repo/.git/noteide_commit_msg.txt', 'first'],
    ['repo/.git/noteide_commit_msg.txt', 'first\nsecond'],
  ]);
});

test('reads wrapped Codex composer content without capturing shell input', () => {
  const { codexComposerInput } = setup();
  const buffer = lines => ({ baseY: 0, cursorY: lines.length - 1, getLine: row => lines[row] });
  const line = (text, isWrapped = false) => ({ isWrapped, translateToString: () => text });
  assert.equal(codexComposerInput(buffer([line('› 修复'), line('保存问题', true)])), '修复保存问题');
  assert.equal(codexComposerInput(buffer([line('PS C:\\repo> npm run build')])), undefined);
});
