import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src-tauri/src/commands/douyin_resolver.js', import.meta.url), 'utf8');
const id = '7647476676246875035';
const detail = { aweme_id: id, desc: '芙宁娜 # cos', video: { play_addr: { url_list: ['http://media.example/video.mp4'] } } };
function setup(data = detail) {
  let tick;
  class XHR {
    open() {}
    send() {}
    addEventListener(_, callback) { this.loaded = callback; }
  }
  const response = { clone: () => ({ json: async () => ({ aweme_detail: data }) }) };
  const context = {
    URL, XMLHttpRequest: XHR,
    location: { href: `https://www.douyin.com/video/${id}/`, pathname: `/video/${id}/` },
    document: { querySelectorAll: () => [], getElementById: () => null },
    setInterval: callback => { tick = callback; return 1; }, clearInterval() {},
    fetch: async () => response,
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return { context, tick: () => tick(), response };
}
function result(context) {
  const url = new URL(context.location.href);
  assert.equal(url.protocol, 'nexusdesk-douyin:');
  assert.equal(url.searchParams.get('url'), 'https://media.example/video.mp4');
  assert.equal(url.searchParams.get('title'), detail.desc);
}

test('fetch interception returns the original response and upgrades HTTP media URLs', async () => {
  const { context, response } = setup();
  assert.equal(await context.fetch('https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=' + id), response);
  await new Promise(resolve => setImmediate(resolve));
  result(context);
});

test('XHR handles JSON and text API responses', () => {
  for (const responseType of ['', 'json']) {
    const { context } = setup();
    const xhr = new context.XMLHttpRequest();
    xhr.open('GET', '/aweme/v1/web/aweme/detail/');
    xhr.responseType = responseType;
    xhr.response = { aweme_detail: detail };
    xhr.responseText = JSON.stringify(xhr.response);
    xhr.send();
    xhr.loaded();
    result(context);
  }
});

test('share pages can resolve embedded router and encoded render data without an API call', () => {
  for (const type of ['router', 'render']) {
    const { context, tick } = setup();
    const data = { loaderData: { video: { aweme_detail: detail } } };
    if (type === 'router') context._ROUTER_DATA = data;
    else context.document.getElementById = () => ({ textContent: encodeURIComponent(JSON.stringify(data)) });
    tick();
    result(context);
  }
});

test('ignores unrelated API calls and details for other videos', async () => {
  const { context, tick } = setup({ ...detail, aweme_id: '123' });
  const original = context.location.href;
  await context.fetch('/aweme/v1/web/aweme/detail/');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.location.href, original);
  context._ROUTER_DATA = { aweme_detail: { ...detail, aweme_id: '123' } };
  tick();
  assert.equal(context.location.href, original);
  const other = setup();
  await other.context.fetch('/unrelated');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(other.context.location.href, original);
});
