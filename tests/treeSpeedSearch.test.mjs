import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/components/explorer/useTreeSpeedSearch.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;

function harness() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || deps.some((dep, i) => dep !== slots[index][i])) effects.push(effect);
      slots[index] = deps;
    },
  };
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => name === 'react' ? react : { Filter: 'filter' } });
  return {
    ...exports,
    render(options, workspace = 'root') {
      cursor = 0;
      effects = [];
      const result = exports.useNameSpeedSearch(options, workspace);
      effects.forEach(effect => effect());
      return result;
    },
  };
}

const key = (value, extra = {}) => ({
  key: value, target: { closest: () => null }, nativeEvent: {},
  preventDefault() {}, stopPropagation() {}, ...extra,
});

test('directory search uses shared matching, cycles matches, filters, activates and resets', () => {
  const api = harness();
  let selected;
  let activated;
  let focused = 0;
  const options = {
    entries: () => [{ id: 'folder', name: 'Project Trees' }, { id: 'file', name: 'project.tree' }],
    selectedId: () => selected,
    select: id => { selected = id; },
    activate: id => { activated = id; },
    focus: () => { focused++; },
    label: '图谱目录快速搜索',
  };
  let search = api.render(options);
  search.onKeyDownCapture(key('p'));
  search = api.render(options);
  assert.equal(selected, 'folder');
  const input = () => search.searchBox.children[0];
  assert.equal(input().props['aria-label'], options.label);
  input().props.onKeyDown(key('ArrowDown'));
  assert.equal(selected, 'file');
  input().props.onKeyDown(key('ArrowDown'));
  assert.equal(selected, 'folder');
  input().props.onChange({ target: { value: 'pt' } });
  search = api.render(options);
  search.searchBox.children[2].props.onClick();
  search = api.render(options);
  assert.equal(search.filterTerm, 'pt');
  assert.ok(Array.isArray(search.highlight('Project Trees')));
  input().props.onKeyDown(key('Enter'));
  assert.equal(activated, 'folder');
  assert.equal(focused, 1);
  search = api.render(options);
  assert.equal(search.searchBox, null);
  assert.equal(search.filterTerm, '');
  search.search('missing');
  search = api.render(options);
  assert.equal(search.searchBox.children[1].children[0], '无匹配');
  api.render(options, 'other-root');
  assert.equal(api.render(options, 'other-root').searchBox, null);
});

test('shortcuts, editable fields and composition do not trigger directory search', () => {
  const api = harness();
  const options = { entries: () => [], selectedId: () => null, select() {}, activate() {}, focus() {} };
  const search = api.render(options);
  for (const event of [key('a', { ctrlKey: true }), key('a', { metaKey: true }), key('a', { altKey: true }),
    key('ArrowDown'), key(' '), key('a', { nativeEvent: { isComposing: true } }),
    key('a', { target: { closest: () => ({}) } })]) search.onKeyDownCapture(event);
  assert.equal(api.render(options).searchBox, null);
});
