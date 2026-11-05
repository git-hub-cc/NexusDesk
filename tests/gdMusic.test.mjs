import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/lib/gdMusic.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const upstream = fs.readFileSync(new URL('./fixtures/gdstudio-crc32-20261026.js', import.meta.url), 'utf8');
let moduleId = 0;
const load = () => import('data:text/javascript;base64,' + Buffer.from(js + `\n// instance ${moduleId++}`).toString('base64'));
const html = '<script src="js/player.js?v=20260925"></script><script src="js/crc32.min.js?v=20261026"></script>';

function environment(api, options = {}) {
  const originalFetch = globalThis.fetch;
  const originalWorker = globalThis.Worker;
  const requests = [];
  const workers = [];
  globalThis.Worker = class {
    constructor(url) {
      workers.push(this);
      this.ready = (async () => {
        const code = await (await originalFetch(url)).text();
        const self = { postMessage: data => this.onmessage?.({ data }) };
        this.context = vm.createContext({ self, setTimeout, clearTimeout });
        // Worker globals and self refer to the same object in browsers.
        this.context.self = this.context;
        this.context.postMessage = self.postMessage;
        vm.runInContext(code, this.context, { timeout: 2000 });
      })();
    }
    postMessage(data) {
      void this.ready.then(() => vm.runInContext(`onmessage({ data: ${JSON.stringify(data)} })`, this.context, { timeout: 2000 }))
        .catch(() => this.onerror?.({ preventDefault() {} }));
    }
    terminate() { this.terminated = true; }
  };
  globalThis.fetch = async input => {
    const url = new URL(input);
    requests.push(url);
    if (url.pathname === '/') return new Response(html);
    if (url.pathname === '/js/player.js') return new Response('var mkPlayer={version:"2026.09.25"};');
    if (url.pathname === '/js/crc32.min.js') return new Response(options.script?.() ?? upstream);
    if (url.pathname === '/time') return new Response('1793252596');
    return api(url);
  };
  return { requests, workers, restore() { globalThis.fetch = originalFetch; globalThis.Worker = originalWorker; } };
}

test('current upstream script reproduces captured search and playback signatures', async () => {
  const music = await load();
  for (const [input, expected, timestamp] of [['read%20all%20about', '1E430C32', 1793252596000], ['28065710', '78516BFE', 1793252600000], ['5678977557587144', '6E0E74DA', 1793252602000]]) {
    const context = vm.createContext({ setTimeout, clearTimeout });
    context.self = context;
    context.postMessage = data => assert.equal(data.signature, expected);
    vm.runInContext(music.signerWorkerSource(upstream, '2026.09.25'), context, { timeout: 2000 });
    vm.runInContext(`onmessage({data:{input:${JSON.stringify(input)},timestamp:${timestamp}}})`, context, { timeout: 2000 });
    assert.equal(context.window.__TAURI_INTERNALS__, undefined);
    assert.equal(context.fetch, undefined);
  }
});

test('search discovers versioned assets, preserves paging and caches the signer', async () => {
  const music = await load();
  const env = environment(url => {
    assert.equal(url.searchParams.get('s'), '1E430C32');
    assert.equal(url.searchParams.get('name'), 'read all about');
    assert.equal(url.searchParams.get('pages'), '2');
    return Response.json([{ id: 28065710, name: 'Read All About It', artist: ['Artist'], extra_data: { duration: 216 } }]);
  });
  try {
    assert.equal((await music.searchGDStudio('read all about', 30))[0].duration, 216000);
    await music.searchGDStudio('read all about', 30);
    assert.equal(env.requests.filter(url => url.pathname === '/').length, 1);
    assert.ok(env.requests.some(url => url.pathname === '/js/crc32.min.js' && url.search === '?v=20261026'));
    assert.ok(env.workers.every(worker => worker.terminated));
  } finally { env.restore(); }
});

test('Chinese and punctuation are encoded once for the upstream signer', async () => {
  const music = await load();
  const query = "邓紫棋 & A+B!'()";
  const script = `function crc32(input) { if (input !== ${JSON.stringify(encodeURIComponent(query))}) throw Error('encoding'); return '1234ABCD'; }`;
  const env = environment(url => {
    assert.equal(url.searchParams.get('name'), query);
    assert.equal(url.searchParams.get('s'), '1234ABCD');
    return Response.json([]);
  }, { script: () => script });
  try { assert.deepEqual(await music.searchGDStudio(query), []); } finally { env.restore(); }
});

test('rejected signatures refresh website assets and time once', async () => {
  const music = await load();
  let calls = 0;
  const env = environment(url => {
    assert.equal(url.searchParams.get('s'), calls ? 'BBBBBBBB' : 'AAAAAAAA');
    return calls++ ? Response.json([]) : Response.json({ error: 'invalid signature' });
  }, { script: () => `function crc32() { return mkPlayer.version === '2026.09.25' ? '${calls ? 'BBBBBBBB' : 'AAAAAAAA'}' : ''; }` });
  try {
    await music.searchGDStudio('test');
    assert.equal(calls, 2);
    assert.equal(env.requests.filter(url => url.pathname === '/').length, 2);
    assert.equal(env.requests.filter(url => url.pathname === '/time').length, 2);
  } finally { env.restore(); }
});

test('playback normalizes HTTPS and reports unavailable songs without retrying', async () => {
  const music = await load();
  let calls = 0;
  const env = environment(() => calls++ ? Response.json({ url: 'err' }) : Response.json({ url: 'http://example.com/song.mp3' }));
  try {
    assert.equal(await music.resolveGDStudioPlayUrl('28065710'), 'https://example.com/song.mp3');
    const repeated = await Promise.all([music.resolveGDStudioPlayUrl('28065710'), music.resolveGDStudioPlayUrl('28065710')]);
    assert.deepEqual(repeated, ['https://example.com/song.mp3', 'https://example.com/song.mp3']);
    await assert.rejects(music.resolveGDStudioPlayUrl('123'), /暂无可用/);
    assert.equal(calls, 2);
  } finally { env.restore(); }
});

test('empty searches avoid network requests', async () => {
  const music = await load();
  const env = environment(() => { throw Error('unexpected API request'); });
  try {
    assert.deepEqual(await music.searchGDStudio('  '), []);
    assert.equal(env.requests.length, 0);
  } finally { env.restore(); }
});
