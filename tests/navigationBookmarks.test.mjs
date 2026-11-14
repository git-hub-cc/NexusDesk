import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function createNavigation(stored) {
  const values = new Map();
  if (stored) values.set('nexusdesk-navigation-data-v1', JSON.stringify(stored));
  const events = [];
  const exports = {};
  const source = readFileSync(new URL('../src/components/navigation/navigationData.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, {
    exports, URL, crypto,
    require: () => ({ default: '/bundled.json' }),
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    },
    window: { dispatchEvent: event => events.push(event) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  });
  return { api: exports, events };
}

const oldSite = { id: 'old', title: '已有网站', url: 'https://example.com/', desc: '' };
const newSite = { id: 'new', title: '当前网页', url: 'https://example.com/Page?q=Hello#section', desc: '' };

test('bookmark save prepends the full current URL and publishes the persisted navigation', async () => {
  const { api, events } = createNavigation({ categories: [{ categoryId: 'custom-user-sites', categoryName: '我的导航', sites: [oldSite] }] });
  const data = await api.loadNavigationData();
  api.saveNavigationData(api.upsertNavigationSite(data, api.CUSTOM_CATEGORY_ID, newSite));
  const reloaded = await api.loadNavigationData();
  assert.deepEqual(Array.from(reloaded.categories[0].sites, site => site.id), ['new', 'old']);
  assert.equal(reloaded.categories[0].sites[0].url, newSite.url);
  assert.equal(events.at(-1).type, 'nexusdesk-navigation-data-changed');
  assert.equal(events.at(-1).detail.categories[0].sites[0].desc, '');
  assert.equal(data.categories[0].sites.length, 1);
});

test('existing bookmark can be edited in place and duplicate URLs are rejected', async () => {
  const { api } = createNavigation({ categories: [{ categoryId: 'custom-user-sites', categoryName: '我的导航', sites: [newSite, oldSite] }] });
  const data = await api.loadNavigationData();
  assert.equal(api.findNavigationBookmark(data, 'https://EXAMPLE.com').id, 'old');
  const edited = api.upsertNavigationSite(data, api.CUSTOM_CATEGORY_ID, { ...oldSite, desc: '补充说明' });
  assert.equal(edited.categories[0].sites[1].desc, '补充说明');
  assert.equal(edited.categories[0].sites.length, 2);
  assert.throws(() => api.upsertNavigationSite(data, api.CUSTOM_CATEGORY_ID, { ...oldSite, id: 'duplicate' }), /该网址已存在/);
  assert.equal(api.findNavigationBookmark(data, 'https://example.com/page?q=Hello#section'), undefined);
  assert.equal(api.findNavigationBookmark(data, 'https://example.com/Page?q=hello#section'), undefined);
});

test('legacy stored navigation gets a first custom category without losing other categories', async () => {
  const category = { categoryId: 'resources', categoryName: '资源', sites: [oldSite] };
  const { api } = createNavigation({ categories: [category] });
  const loaded = await api.loadNavigationData();
  assert.equal(loaded.categories[0].categoryId, api.CUSTOM_CATEGORY_ID);
  assert.equal(loaded.categories[1].sites[0].id, oldSite.id);
  const next = api.upsertNavigationSite({ categories: [category] }, api.CUSTOM_CATEGORY_ID, newSite);
  assert.equal(next.categories[0].sites[0].id, newSite.id);
  assert.equal(next.categories[1].categoryId, 'resources');
});

test('bookmark icons survive saving, editing and reloading, and can be removed', async () => {
  const { api } = createNavigation({ categories: [{ categoryId: 'custom-user-sites', categoryName: '我的导航', sites: [oldSite] }] });
  const icons = [
    'https://example.com/custom-icon.png',
    'data:image/png;base64,aWNvbg==',
    { sprite: 'sprite-01.webp', x: 0, y: 24, width: 24, height: 24, spriteWidth: 240, spriteHeight: 240 },
    undefined,
  ];
  for (const icon of icons) {
    const data = await api.loadNavigationData();
    api.saveNavigationData(api.upsertNavigationSite(data, api.CUSTOM_CATEGORY_ID, { ...oldSite, icon }));
    const reloaded = await api.loadNavigationData();
    const savedIcon = api.findNavigationBookmark(reloaded, oldSite.url).icon;
    if (icon && typeof icon === 'object') assert.deepEqual({ ...savedIcon }, icon);
    else assert.equal(savedIcon, icon);
  }
});

test('bookmark favicon uses the website origin and supports addresses without a scheme', () => {
  const { api } = createNavigation();
  assert.equal(api.navigationFaviconUrl('https://example.com/Page?q=Hello#section'), 'https://example.com/favicon.ico');
  assert.equal(api.navigationFaviconUrl(' example.com/path '), 'https://example.com/favicon.ico');
  assert.equal(api.navigationFaviconUrl('http://localhost:8080/path'), 'http://localhost:8080/favicon.ico');
  assert.throws(() => api.navigationFaviconUrl('file:///secret'));
  assert.throws(() => api.navigationFaviconUrl('https://'));
});
