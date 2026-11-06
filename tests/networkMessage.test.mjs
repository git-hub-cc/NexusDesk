import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../src/components/NetworkMessage.tsx', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function viewer(body, completeMessage) {
  const state = [];
  let cursor = 0;
  const context = vm.createContext({ exports: {}, require(name) {
    if (name === 'react') return {
      useMemo: fn => fn(),
      useState(initial) {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], update => { state[index] = typeof update === 'function' ? update(state[index]) : update; }];
      },
    };
    if (name === 'lucide-react') return { ChevronDown: 'svg', ChevronRight: 'svg' };
    return require(name);
  } });
  vm.runInContext(js, context);
  const message = completeMessage ?? '200 OK\r\ncontent-type: application/json\r\n\r\n' + body;
  const render = () => { cursor = 0; return context.exports.NetworkMessage({ message, label: '响应报文', formatJson: true }); };
  function* nodes(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) yield* nodes(child); return; }
    if (typeof node.type === 'function') { yield* nodes(node.type(node.props)); return; }
    yield node;
    yield* nodes(node.props?.children);
  }
  return {
    html: () => renderToStaticMarkup(render()),
    click(label) {
      const button = [...nodes(render())].find(node => node.type === 'button' && (node.props.children === label || node.props['aria-label']?.startsWith(label)));
      assert.ok(button, `missing button: ${label}`);
      button.props.onClick();
    },
  };
}

test('JSON response displays formatted nodes and retains headers and original text', () => {
  const view = viewer('{"message":"你好","count":3,"ok":true,"empty":null}');
  const html = view.html();
  assert.match(html, /JSON 格式化/);
  assert.match(html, /content-type: application\/json/);
  assert.match(html, /你好/);
  assert.match(html, /aria-expanded="true"/);
  view.click('原始报文');
  assert.match(view.html(), /\{&quot;message&quot;:&quot;你好&quot;,&quot;count&quot;:3,&quot;ok&quot;:true,&quot;empty&quot;:null\}/);
});

test('individual nodes and all nodes can be collapsed and expanded', () => {
  const view = viewer('{"parent":{"child":{"text":"deep value"}},"array":[{"id":1}]}');
  assert.doesNotMatch(view.html(), /deep value/);
  view.click('展开 child');
  assert.match(view.html(), /deep value/);
  view.click('折叠 parent');
  assert.doesNotMatch(view.html(), /deep value/);
  view.click('展开全部');
  assert.match(view.html(), /deep value/);
  view.click('折叠全部');
  assert.doesNotMatch(view.html(), /&quot;parent&quot;/);
  view.click('展开 根节点');
  assert.match(view.html(), /&quot;parent&quot;/);
});

test('empty collections, scalar JSON and null are valid JSON views', () => {
  for (const body of ['{}', '[]', 'null', 'false', '0', '"text"']) {
    assert.match(viewer(body).html(), /JSON 格式化/);
  }
});

test('invalid, truncated and non-JSON bodies retain their original view', () => {
  for (const body of ['plain text', '{"value":', '{"value":1}\r\n[响应已截断]']) {
    const html = viewer(body).html();
    assert.doesNotMatch(html, /JSON 格式化/);
    assert.match(html, /aria-label="响应报文"/);
  }
});

test('serialized and escaped JSON bodies support node expansion and preserve the raw message', () => {
  const body = JSON.stringify({ data: { items: [{ text: 'escaped payload' }] } });
  const quoted = JSON.stringify(body);
  for (const encoded of [quoted, JSON.stringify(quoted), quoted.slice(1, -1)]) {
    const view = viewer(encoded);
    assert.match(view.html(), /JSON 格式化/);
    view.click('展开全部');
    assert.match(view.html(), /escaped payload/);
    view.click('折叠 data');
    assert.doesNotMatch(view.html(), /escaped payload/);
    view.click('原始报文');
    const expected = renderToStaticMarkup(require('react').createElement('pre', null, encoded)).slice(5, -6);
    assert.ok(view.html().includes(expected));
  }
});

test('nested serialized objects and arrays can be expanded and collapsed', () => {
  const view = viewer(JSON.stringify({ payload: JSON.stringify({ items: JSON.stringify([{ text: 'nested payload' }]) }) }));
  view.click('展开全部');
  assert.match(view.html(), /nested payload/);
  view.click('折叠 items');
  assert.doesNotMatch(view.html(), /nested payload/);
  view.click('展开 items');
  assert.match(view.html(), /nested payload/);
});

test('normal string escapes and strings resembling primitives retain their values', () => {
  const values = ['a "quoted" value', 'line one\nline two', 'C:\\new\\test', 'false', '123', 'null', '{broken json'];
  const view = viewer(JSON.stringify(values));
  const html = view.html();
  for (const value of values) {
    const escaped = renderToStaticMarkup(require('react').createElement('span', null, JSON.stringify(value)));
    assert.ok(html.includes(escaped.slice(6, -7)), `string must remain intact: ${value}`);
  }
});

test('escaped line separators in serialized complete messages are recognized', () => {
  const message = '200 OK\r\ncontent-type: application/json\r\n\r\n' + JSON.stringify({ data: { text: 'whole message' } });
  const serialized = JSON.stringify(message);
  for (const encoded of [serialized, serialized.slice(1, -1)]) {
    const view = viewer('', encoded);
    view.click('展开全部');
    assert.match(view.html(), /whole message/);
    view.click('折叠 data');
    assert.doesNotMatch(view.html(), /whole message/);
  }
});
