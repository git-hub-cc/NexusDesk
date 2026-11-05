const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
const context = { exports: {}, require };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/components/editor/expandSelection.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, context);
const { expandedRange, expandSelection } = context.exports;
test('pairs expand both ends together from either edge and reversed ranges', () => {
  const text = 'prefix (["left right"]) suffix';
  const from = text.indexOf('left'), to = text.indexOf('right') + 5;
  for (const [a, b] of [[from, to], [to, from]]) {
    const next = expandedRange(text, a, b);
    assert.equal(text.slice(next.from, next.to), '"left right"');
  }
  for (const pos of [from, to]) {
    const selected = steps(text, pos);
    for (const value of ['left right', '"left right"', '["left right"]', '(["left right"])']) assert.ok(selected.includes(value), value);
    assert.ok(!selected.includes('(["left right"]'));
  }
});
test('paths also grow forwards from the first directory', () => {
  for (const separator of ['/', '\\']) {
    const path = ['root', 'folder', 'file.txt'].join(separator);
    const selected = steps(path, 2);
    assert.ok(selected.includes(['root', 'folder'].join(separator)));
    assert.ok(selected.includes(path));
  }
});
function steps(text, pos) {
  let from = pos, to = pos;
  const result = [];
  for (let i = 0; i < 50; i++) {
    const next = expandedRange(text, from, to);
    if (next.from === from && next.to === to) return result;
    assert.ok(next.from <= from && next.to >= to);
    ({ from, to } = next);
    result.push(text.slice(from, to));
  }
  assert.fail('selection must terminate');
}
test('nested brackets and quotes have separate inner and outer levels', () => {
  const text = 'call({key: ["hello world"]})';
  const selected = steps(text, text.indexOf('hello') + 2);
  for (const value of ['hello', 'hello world', '"hello world"', '["hello world"]', 'key: ["hello world"]', '{key: ["hello world"]}', '({key: ["hello world"]})', text]) assert.ok(selected.includes(value), value);
});
test('paths expand through extension and each directory on either platform', () => {
  for (const separator of ['/', '\\']) {
    const path = ['root', 'folder', 'file.txt'].join(separator);
    const selected = steps(`open "${path}" now`, path.indexOf('file') + 8);
    for (const value of ['file', 'file.txt', ['folder', 'file.txt'].join(separator), path, `"${path}"`]) assert.ok(selected.includes(value), value);
  }
});
test('camelCase, underscores, escaped quotes and Unicode delimiters', () => {
  assert.deepEqual(steps('helloWorld_name', 7).slice(0, 3), ['World', 'helloWorld', 'helloWorld_name']);
  const text = '前文 【“你好 \\"朋友\\"”】 后文';
  assert.ok(steps(text, 7).includes('【“你好 \\"朋友\\"”】'));
});
test('arbitrary selections, blank lines and document edges always grow monotonically', () => {
  for (const text of ['', '\n', ' a + b\n\nsecond\nthird', '(unclosed', '😀text']) {
    for (let from = 0; from <= text.length; from++) {
      steps(text, from);
      for (let to = from; to <= text.length; to++) {
        const next = expandedRange(text, from, to);
        assert.ok(next.from <= from && next.to >= to && next.to <= text.length);
      }
    }
  }
});
test('command preserves multiple cursors and reversed selections', () => {
  const { EditorState, EditorSelection } = require('@codemirror/state');
  const state = EditorState.create({ doc: 'hello world', selection: EditorSelection.create([EditorSelection.range(3, 1), EditorSelection.cursor(8)], 1), extensions: [EditorState.allowMultipleSelections.of(true)] });
  let transaction;
  assert.equal(expandSelection({ state, dispatch: spec => { transaction = state.update(spec); } }), true);
  assert.equal(transaction.state.selection.ranges.length, 2);
  assert.equal(transaction.state.selection.ranges[0].anchor, 5);
  assert.equal(transaction.state.selection.ranges[0].head, 0);
});
