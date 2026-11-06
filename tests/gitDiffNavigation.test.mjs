import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/components/editor/GitComparison.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('GitComparison.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let boundary;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'boundary') boundary = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(boundary);
const compiled = ts.transpileModule(`return ${boundary};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const diffSource = fs.readFileSync(new URL('../src/lib/gitDiff.ts', import.meta.url), 'utf8');
const diffCompiled = ts.transpileModule(diffSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { diffChanges, parseGitDiff } = await import(`data:text/javascript;base64,${Buffer.from(diffCompiled).toString('base64')}`);
const patch = '@@ -1 +1 @@\n-old\n+new\n';

async function navigate({ direction = 1, staged = false, revision, current = 'a.md', failSave = false, inactive = false } = {}) {
  const calls = [], opened = [], notices = [];
  const tab = { id: 'current', diffContext: { root: '/repo', path: current }, diffStaged: staged, revision };
  const files = ['a.md', 'b.md', 'c.md', 'd.md'].map(path => ({ path, worktreePath: `/repo/${path}`, status: '修改', unstaged: true, staged: path !== 'b.md' }));
  const api = {
    async status() { calls.push('status'); return files; },
    async revisionChanges(root, commit) { calls.push(['revisionChanges', root, commit]); return files; },
    async diff(root, path, staged) { calls.push(['diff', path, staged]); return path === 'b.md' ? '' : patch; },
    async revisionDiff(root, commit, path) { calls.push(['revisionDiff', commit, path]); return patch; },
  };
  const store = { rootPath: '/repo', activeLeftTabId: inactive ? 'other' : 'current', setFocusedPane() {}, openTab(tab) { opened.push(tab); } };
  const factory = new Function('tab', 'navigating', 'setBusy', 'setNotice', 'flushPendingWrites', 'gitApi', 'isImage', 'diffChanges', 'parseGitDiff', 'useWorkspaceStore', 'pane', 'navigationToken', compiled);
  const run = factory(tab, { current: false }, () => {}, value => notices.push(value), async () => {
    calls.push('save'); if (failSave) throw new Error('save failed');
  }, api, () => false, diffChanges, parseGitDiff, { getState: () => store }, 'left', 0);
  await run(direction);
  return { calls, opened, notices };
}

test('next change crosses unopened files, skipping files with no text changes after saving', async () => {
  const { calls, opened } = await navigate();
  assert.equal(calls[0], 'save');
  assert.equal(opened[0].path, '/repo/c.md');
  assert.equal(opened[0].diffEntry.edge, 'first');
  assert.deepEqual(opened[0].diffContext, { root: '/repo', path: 'c.md' });
});

test('previous file opens its last change; staged comparisons stay staged and read only', async () => {
  const { calls, opened } = await navigate({ direction: -1, current: 'd.md', staged: true });
  assert.equal(opened[0].path, 'c.md');
  assert.equal(opened[0].diffStaged, true);
  assert.equal(opened[0].diffEntry.edge, 'last');
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'diff' && call[2] === true));
});

test('historical comparisons stay within the same commit', async () => {
  const { calls, opened } = await navigate({ revision: 'abc123' });
  assert.equal(opened[0].revision, 'abc123');
  assert.equal(opened[0].path, 'b.md');
  assert.ok(!calls.includes('status'));
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'revisionDiff' && call[1] === 'abc123'));
});

test('end of comparison does not wrap and saving errors or changed active tabs prevent navigation', async () => {
  const end = await navigate({ current: 'd.md' });
  assert.equal(end.opened.length, 0);
  assert.equal(end.notices.at(-1), '已是最后一处差异');
  for (const options of [{ failSave: true }, { inactive: true }]) {
    assert.equal((await navigate(options)).opened.length, 0);
  }
});
