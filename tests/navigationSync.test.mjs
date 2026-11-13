import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/navigation/navigationSync.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function createSync(fetch) {
  const values = new Map();
  const listeners = new Map();
  const timers = new Map();
  const data = { categories: [] };
  let nextTimer = 0;
  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); },
    clearTimeout(id) { timers.delete(id); },
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
  };
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  const exports = {};
  const context = {
    exports, fetch, window, localStorage: storage, atob, btoa, TextEncoder, TextDecoder, Uint8Array, AbortSignal, console,
    require(name) {
      if (name === '@/lib/globalSettings') return { settingsStorage: storage };
      if (name === './navigationData') return { loadNavigationData: async () => data, mergeNavigationData: (local) => local, saveNavigationData() {} };
      throw new Error(`Unexpected import: ${name}`);
    },
  };
  vm.runInNewContext(compiled, context);
  return {
    api: exports,
    async save() {
      window.dispatchEvent({ type: 'nexusdesk-navigation-data-changed' });
      for (const [id, callback] of timers) {
        timers.delete(id);
        callback();
      }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('GitLab creates once and updates on the next automatic sync', async () => {
  const writes = [];
  const sync = createSync(async (url, options = {}) => {
    const method = options.method ?? 'GET';
    if (url.endsWith('/user')) return response(200, { username: 'owner' });
    if (url.endsWith('/projects/owner%2Frepo')) return response(200);
    if (method === 'GET' && url.includes('/repository/files/')) return response(404);
    if (url.includes('/repository/files/')) {
      writes.push(method);
      return response(method === 'POST' ? 201 : 200, { file_path: 'navhub-data.json', branch: 'main' });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  await sync.api.connectNavigationSync('token', 'owner/repo', 'gitlab');
  await sync.save();

  assert.deepEqual(writes, ['POST', 'PUT']);
  assert.equal(sync.api.getNavigationSyncState().status, 'connected');
});

test('Gitee creates a missing file before updating it', async () => {
  const writes = [];
  const sync = createSync(async (url, options = {}) => {
    const method = options.method ?? 'GET';
    if (url.endsWith('/user')) return response(200, { login: 'owner' });
    if (url.endsWith('/repos/owner/repo')) return response(200);
    if (method === 'GET' && url.includes('/contents/')) return response(404);
    if (url.includes('/contents/')) {
      writes.push({ method, body: JSON.parse(options.body) });
      return response(method === 'POST' ? 201 : 200, { content: { sha: `sha-${writes.length}` } });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  await sync.api.connectNavigationSync('token', 'owner/repo', 'gitee');
  await sync.save();

  assert.deepEqual(writes.map(write => write.method), ['POST', 'PUT']);
  assert.equal(writes[0].body.sha, undefined);
  assert.equal(writes[1].body.sha, 'sha-1');
  assert.equal(sync.api.getNavigationSyncState().status, 'connected');
});
