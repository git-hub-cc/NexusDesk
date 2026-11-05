const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/components/editor/wikiLink.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, context);
const { wikiLinkRange, wikiCompletionRange } = context.exports;

test('finds the entire existing link at its text and delimiters', () => {
  const text = '前文 [[02合并文件.py]] 后文 [[other.md#标题]]';
  for (let pos = 3; pos <= 16; pos++) {
    const range = wikiLinkRange(text, pos);
    assert.equal(text.slice(range.from, range.to), '[[02合并文件.py]]');
    assert.equal(range.existing, true);
  }
  const second = wikiLinkRange(text, text.indexOf('other') + 2);
  assert.equal(text.slice(second.from, second.to), '[[other.md#标题]]');
  assert.equal(wikiLinkRange(text, 1), null);
});

test('completion range covers the query and an existing closing delimiter', () => {
  assert.deepEqual({ ...wikiCompletionRange('text [[note', 11) }, { from: 7, to: 11 });
  assert.deepEqual({ ...wikiCompletionRange('[[not|alias]]', 5) }, { from: 2, to: 5 });
  assert.deepEqual({ ...wikiCompletionRange('[[note]] after', 5) }, { from: 2, to: 8 });
  assert.equal(wikiCompletionRange('text [note', 9), null);
  assert.equal(wikiCompletionRange('[[note#heading', 8), null);
});

test('preserves aliases and supports selecting a complete link', () => {
  const text = '[[old.md#旧标题|显示文字]]';
  const range = wikiLinkRange(text, 0, text.length);
  assert.equal(range.alias, '|显示文字');
  assert.equal(range.to, text.length);
  assert.equal(wikiLinkRange(text + ' extra', 0, text.length + 1), null);
});

test('retains new-link creation and rejects malformed links', () => {
  assert.equal(wikiLinkRange('text [[', 7).existing, false);
  assert.equal(wikiLinkRange('[[incomplete', 6), null);
  assert.equal(wikiLinkRange('[[line\nbreak]]', 5), null);
  assert.equal(wikiLinkRange('plain text', 5), null);
});
