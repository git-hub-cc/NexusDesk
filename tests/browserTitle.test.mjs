import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/editor/BrowserEditor.tsx', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '')
  .replace('import.meta.env.BASE_URL', '"/"')
  + '\nexport { updateBrowserTabs };';
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;
const context = { exports: {}, URL };
vm.runInNewContext(compiled, context);
const { updateBrowserTabs } = context.exports;
const url = 'https://example.com/start';
const tab = { id: 'browser:one', title: 'example.com', browser: { root: '/', url } };

test('document title replaces the hostname and survives later page-load URL events', () => {
  let tabs = updateBrowserTabs([tab], tab.id, url, '  网页标题 · Example  ');
  assert.equal(tabs[0].title, '网页标题 · Example');
  tabs = updateBrowserTabs(tabs, tab.id, url);
  assert.equal(tabs[0].title, '网页标题 · Example');
  tabs = updateBrowserTabs(tabs, tab.id, url, '动态更新的标题');
  assert.equal(tabs[0].title, '动态更新的标题');
});

test('route and history URL changes preserve the title until the document changes it', () => {
  let tabs = updateBrowserTabs([tab], tab.id, url, '网站工作台');
  const route = 'https://example.com/next#section';
  tabs = updateBrowserTabs(tabs, tab.id, route);
  assert.equal(tabs[0].title, '网站工作台');
  assert.equal(tabs[0].browser.url, route);
  tabs = updateBrowserTabs(tabs, tab.id, url);
  assert.equal(tabs[0].title, '网站工作台');
});

test('synchronizing an adopted view replaces its previous title and URL', () => {
  const adoptedUrl = 'https://other.example/page';
  const tabs = updateBrowserTabs([tab], tab.id, adoptedUrl, '预加载的页面');
  assert.equal(tabs[0].title, '预加载的页面');
  assert.equal(tabs[0].browser.url, adoptedUrl);
  assert.equal(tabs[0].browser.root, '/');
  assert.equal(tab.title, 'example.com');
});

test('empty titles fall back to hostname or a readable blank page label', () => {
  assert.equal(updateBrowserTabs([tab], tab.id, url, '  ')[0].title, 'example.com');
  assert.equal(updateBrowserTabs([tab], tab.id, 'about:blank', '')[0].title, '网页');
});

test('title updates affect only the matching browser tab', () => {
  const other = { ...tab, id: 'browser:other' };
  const file = { id: tab.id, title: 'note.md' };
  const tabs = updateBrowserTabs([tab, other, file], tab.id, url, '网页标题');
  assert.equal(tabs[1], other);
  assert.equal(tabs[2], file);
});
