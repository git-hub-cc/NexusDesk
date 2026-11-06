import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/lib/networkMonitor.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

function setup(fetch) {
  class XHR extends EventTarget {
    open() {}
    send(body) { this.sentBody = body; }
    setRequestHeader() {}
    getAllResponseHeaders() { return 'Content-Type: text/plain\r\nX-Reply: yes\r\n'; }
  }
  const context = vm.createContext({ exports: {}, window: { fetch, location: { href: 'https://example.com/app/' } },
    XMLHttpRequest: XHR, Request, Response, Headers, URL, URLSearchParams, FormData, Blob,
    ArrayBuffer, Uint8Array, TextEncoder, TextDecoder, ReadableStream, Document: class {},
    performance, btoa, setTimeout });
  vm.runInContext(js, context);
  const monitor = context.exports;
  monitor.installNetworkMonitor();
  const items = [];
  monitor.subscribeNetworkRequests(item => items.push(item));
  return { window: context.window, XHR, items };
}

async function recorded(items) {
  for (let attempt = 0; attempt < 100 && !items.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(items.length, 1, 'expected a completed network record');
  return items[0];
}

test('fetch retains UTF-8 request and full response without consuming caller bodies', async () => {
  const body = JSON.stringify({ message: '你好' });
  const reply = 'data: first\n\ndata: ' + '响应'.repeat(10000);
  const { window, items } = setup(async request => {
    assert.equal(await request.text(), body);
    assert.equal(request.headers.get('x-token'), 'secret');
    return new Response(reply, { status: 201, statusText: 'Created', headers: { 'x-reply': 'yes' } });
  });
  const request = new Request('https://example.com/api', { method: 'POST', headers: { 'x-token': 'secret' }, body });
  const response = await window.fetch(request);
  assert.equal(await response.text(), reply);
  assert.equal(await request.text(), body);
  const item = await recorded(items);
  assert.ok(item.requestMessage.endsWith('\r\n\r\n' + body));
  assert.match(item.requestMessage, /x-token: secret/);
  assert.ok(item.responseMessage.endsWith('\r\n\r\n' + reply));
  assert.match(item.responseMessage, /^201 Created\r\n/);
  assert.equal(item.requestBytes, Buffer.byteLength(body));
  assert.equal(item.responseBytes, Buffer.byteLength(reply));
});

test('multipart capture uses the same boundary and bytes as the sent request', async () => {
  let sent;
  const { window, items } = setup(async request => {
    sent = { headers: request.headers, body: await request.text() };
    return new Response('ok');
  });
  const form = new FormData();
  form.append('name', '完整表单');
  form.append('file', new Blob(['file content']), 'sample.txt');
  await window.fetch('/upload', { method: 'POST', body: form });
  const item = await recorded(items);
  assert.ok(item.requestMessage.includes(sent.headers.get('content-type')));
  assert.ok(item.requestMessage.endsWith(sent.body));
  assert.match(item.requestMessage, /^POST https:\/\/example.com\/upload/);
});

test('streaming fetch returns before body completion and records all chunks', async () => {
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const { window, items } = setup(async () => new Response(stream));
  const response = await window.fetch('https://example.com/stream');
  assert.equal(items.length, 0);
  controller.enqueue(new TextEncoder().encode('first\n'));
  controller.enqueue(new TextEncoder().encode('last\n'));
  controller.close();
  assert.equal(await response.text(), 'first\nlast\n');
  assert.ok((await recorded(items)).responseMessage.endsWith('first\nlast\n'));
});

test('failed fetch preserves request details and the original rejection', async () => {
  const failure = new Error('offline');
  const { window, items } = setup(async () => { throw failure; });
  await assert.rejects(window.fetch('https://example.com/api', { method: 'POST', body: 'payload' }), error => error === failure);
  const item = await recorded(items);
  assert.equal(item.failed, true);
  assert.ok(item.requestMessage.endsWith('payload'));
  assert.match(item.responseMessage, /offline/);
});

test('XHR captures headers, binary response, and a reused instance separately', async () => {
  const { XHR, items } = setup(async () => new Response());
  const xhr = new XHR();
  xhr.open('POST', '/api');
  xhr.setRequestHeader('X-Token', 'secret');
  xhr.send('request text');
  xhr.status = 200;
  xhr.statusText = 'OK';
  xhr.response = Uint8Array.from([0xff, 0x00, 0xfe]).buffer;
  xhr.dispatchEvent(new Event('loadend'));
  xhr.open('GET', '/other');
  const item = await recorded(items);
  assert.match(item.requestMessage, /X-Token: secret/);
  assert.ok(item.requestMessage.endsWith('request text'));
  assert.match(item.responseMessage, /X-Reply: yes/);
  assert.ok(item.responseMessage.endsWith('/wD+'));
  assert.equal(item.responseBytes, 3);
  assert.equal(xhr.sentBody, 'request text');
  assert.equal(item.url, 'https://example.com/api');
});
