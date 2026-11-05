import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/lib/gitDiff.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { diffChanges, fullTextDiffRows, parseGitDiff, originalFromPatch } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('navigation groups consecutive replacement lines as one change', () => {
  const blocks = diffChanges(parseGitDiff('@@ -1,5 +1,6 @@\n-a\n-b\n+A\n+B\n+C\n same\n-old\n+new\n tail\n'));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { start: 1, end: 3, leftLine: 1, rightLine: 1, leftCount: 2, rightCount: 3, kind: 'modified' });
  assert.equal(blocks[1].rightLine, 5);
});

test('pure deletions remain navigable on the right, including EOF and empty files', () => {
  const middle = diffChanges(parseGitDiff('@@ -1,3 +1,2 @@\n first\n-removed\n last\n'));
  assert.equal(middle[0].rightLine, 2);
  assert.equal(middle[0].rightCount, 0);
  assert.equal(middle[0].kind, 'removed');
  assert.equal(diffChanges(parseGitDiff('@@ -1,2 +1 @@\n first\n-removed\n'))[0].rightLine, 2);
  assert.equal(diffChanges(parseGitDiff('@@ -1 +0,0 @@\n-removed\n'))[0].rightLine, 1);
});

test('separate hunks stay separate even without context and insertions anchor on the left', () => {
  const blocks = diffChanges(parseGitDiff('@@ -1 +1 @@\n-a\n+b\n@@ -20,0 +21,2 @@\n+x\n+y\n'));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].kind, 'added');
  assert.equal(blocks[1].rightCount, 2);
  assert.equal(blocks[1].leftLine, 21);
  assert.deepEqual(diffChanges([]), []);
});

test('recovers complete original text including omitted context and line count changes', () => {
  assert.equal(originalFromPatch('@@ -2 +2,2 @@\n-old\n+new\n+extra\n', 'first\nnew\nextra\nlast\n'), 'first\nold\nlast\n');
  assert.equal(originalFromPatch('@@ -2 +1,0 @@\n-old\n', 'first\nlast\n'), 'first\nold\nlast\n');
  assert.equal(originalFromPatch('@@ -0,0 +1 @@\n+new\n', 'new\n'), '');
  assert.equal(originalFromPatch('@@ -1 +0,0 @@\n-old\n', ''), 'old\n');
  assert.equal(originalFromPatch('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n', 'new\n'), 'old');
});

test('full text comparison includes omitted context and identical files', () => {
  const left = 'first\nsecond\nold\nfourth\nlast\n';
  const right = 'first\nsecond\nnew\nfourth\nlast\n';
  const rows = fullTextDiffRows('@@ -3 +3 @@\n-old\n+new\n', left, right);
  assert.deepEqual(rows.map(row => row.left.text), left.trimEnd().split('\n'));
  assert.deepEqual(rows.map(row => row.right.text), right.trimEnd().split('\n'));
  assert.equal(rows[2].left.changed, true);
  assert.equal(rows[4].left.changed, false);
  assert.deepEqual(fullTextDiffRows('', left, left).map(row => row.left.text), left.trimEnd().split('\n'));
});

test('full text comparison preserves insertion alignment and empty versions', () => {
  const rows = fullTextDiffRows('@@ -1,0 +2 @@\n+added\n', 'first\nlast', 'first\nadded\nlast');
  assert.equal(rows[1].left, undefined);
  assert.equal(rows[1].right.text, 'added');
  assert.equal(rows[2].left.text, 'last');
  assert.equal(rows[2].right.number, 3);
  assert.deepEqual(fullTextDiffRows('', '', ''), []);
  assert.equal(fullTextDiffRows('@@ -0,0 +1 @@\n+new\n', '', 'new')[0].left, undefined);
});

test('pairs replacements and pads unequal change blocks without losing line numbers', () => {
  const rows = parseGitDiff('@@ -1,3 +1,4 @@\n same\n-old\n+new\n+extra\n end\n');
  assert.equal(rows[2].left.text, 'old');
  assert.equal(rows[2].right.text, 'new');
  assert.equal(rows[3].left, undefined);
  assert.equal(rows[3].right.number, 3);
  assert.equal(rows[4].left.number, 3);
  assert.equal(rows[4].right.number, 4);
});

test('handles new/deleted files and content beginning with patch markers', () => {
  const added = parseGitDiff('diff --git a/f b/f\n--- /dev/null\n+++ b/f\n@@ -0,0 +1,2 @@\n+++ content\n+\n');
  assert.equal(added[1].left, undefined);
  assert.equal(added[1].right.text, '++ content');
  assert.equal(added[2].right.text, '');
  const deleted = parseGitDiff('@@ -1 +0,0 @@\n--- content\n');
  assert.equal(deleted[1].left.text, '-- content');
  assert.equal(deleted[1].right, undefined);
});

test('keeps separated hunk coordinates and missing final newline', () => {
  const rows = parseGitDiff('@@ -1 +1 @@\n-a\n+b\n@@ -200 +201 @@\n-c\n\\ No newline at end of file\n+d\n');
  assert.equal(rows[3].left.number, 200);
  assert.equal(rows[3].right.number, 201);
  assert.equal(rows[3].left.noNewline, true);
});

test('binary and metadata-only patches have no text rows', () => {
  assert.deepEqual(parseGitDiff('Binary files a/image.png and b/image.png differ\n'), []);
  assert.deepEqual(parseGitDiff('diff --git a/f b/f\nold mode 100644\nnew mode 100755\n'), []);
});
