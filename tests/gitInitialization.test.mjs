import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/components/git/GitPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('GitPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const snippets = {};
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['run', 'initializeRepository'].includes(node.name?.text)) {
    snippets[node.name.text] = node.getText(ast);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'refresh') {
    snippets.refresh = `const refresh = ${node.initializer.arguments[0].getText(ast)};`;
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const compiled = ts.transpileModule(Object.values(snippets).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture({ exists = false, failInit = false } = {}) {
  const state = {};
  const calls = [];
  const api = {
    async isRepository() { calls.push('check'); return exists; },
    async initRepository() {
      calls.push('init');
      if (failInit) throw new Error('permission denied');
      exists = true;
    },
    async log() { calls.push('log'); return []; },
    async settings() { calls.push('settings'); return { remote: '' }; },
  };
  const values = {
    gitApi: api, root: '/notes', limit: 100, mounted: { current: true },
    locked: { current: false }, pendingRef: { current: new Set() },
    refreshStatus: async () => { calls.push('status'); state.files = ['note.md']; },
    flushPendingWrites: async () => {},
  };
  for (const name of ['IsRepository', 'Files', 'Log', 'HasRemote', 'Error', 'Busy', 'Notice']) {
    values[`set${name}`] = value => { state[name[0].toLowerCase() + name.slice(1)] = value; };
  }
  const actions = new Function(...Object.keys(values), `${compiled}\nreturn { refresh, initializeRepository };`)(...Object.values(values));
  return { state, calls, ...actions };
}

test('uninitialized workspace shows initialization without loading repository data', async () => {
  const f = fixture();
  await f.refresh();
  assert.deepEqual(f.calls, ['check']);
  assert.equal(f.state.isRepository, false);
  assert.equal(f.state.error, '');
  assert.deepEqual(f.state.files, []);
});

test('initialization refreshes files, history and settings and reports success', async () => {
  const f = fixture();
  await f.initializeRepository();
  assert.deepEqual(f.calls, ['init', 'check', 'status', 'log', 'settings']);
  assert.equal(f.state.isRepository, true);
  assert.deepEqual(f.state.files, ['note.md']);
  assert.equal(f.state.notice, 'Git 仓库初始化成功');
  assert.equal(f.state.busy, false);
});

test('failed initialization retains initialization state and allows retry', async () => {
  const f = fixture({ failInit: true });
  await f.refresh();
  await f.initializeRepository();
  assert.equal(f.state.isRepository, false);
  assert.match(f.state.error, /permission denied/);
  assert.equal(f.state.busy, false);
  assert.deepEqual(f.calls, ['check', 'init']);
});

test('existing repository loads data without initializing it', async () => {
  const f = fixture({ exists: true });
  await f.refresh();
  assert.deepEqual(f.calls, ['check', 'status', 'log', 'settings']);
  assert.equal(f.state.isRepository, true);
});
