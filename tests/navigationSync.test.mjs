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

function createSync(fetch, data = { categories: [] }) {
  const values = new Map();
  const listeners = new Map();
  const timers = new Map();
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
    CustomEvent: class {
      constructor(type, options) { this.type = type; this.detail = options?.detail; }
    },
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
    if (url.endsWith('/projects/owner%2Frepo')) return response(200, { visibility: 'private' });
    if (method === 'GET' && url.includes('/repository/files/')) return response(404);
    if (url.includes('/repository/files/')) {
      writes.push({ method, body: JSON.parse(options.body) });
      return response(method === 'POST' ? 201 : 200, { file_path: 'navhub-data.json', branch: 'main' });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  await sync.api.connectNavigationSync('token', 'owner/repo', 'gitlab');
  await sync.save();

  assert.deepEqual(writes.map(write => write.method), ['POST', 'PUT']);
  assert.equal(writes[0].body.commit_message, '同步导航：更新显示偏好');
  assert.match(writes[0].body.content, /\n  "updatedAt":/);
  assert.equal(sync.api.getNavigationSyncState().status, 'connected');
});

test('Gitee writes formatted JSON and describes navigation additions', async () => {
  const writes = [];
  const sync = createSync(async (url, options = {}) => {
    const method = options.method ?? 'GET';
    if (url.endsWith('/user')) return response(200, { login: 'owner' });
    if (url.endsWith('/repos/owner/repo')) return response(200, { private: true });
    if (method === 'GET' && url.includes('/contents/')) return response(404);
    if (url.includes('/contents/')) {
      writes.push({ method, body: JSON.parse(options.body), serialized: options.body });
      return response(method === 'POST' ? 201 : 200, { content: { sha: `sha-${writes.length}` } });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }, { categories: [{ categoryId: 'custom-user-sites', categoryName: '我的导航', sites: [{ id: 'one', title: 'Example', url: 'https://example.com' }] }] });

  await sync.api.connectNavigationSync('token', 'owner/repo', 'gitee');
  await sync.save();

  assert.deepEqual(writes.map(write => write.method), ['POST', 'PUT']);
  assert.equal(writes[0].body.sha, undefined);
  assert.equal(writes[1].body.sha, 'sha-1');
  assert.equal(writes[0].body.message, '同步导航：新增 2 项，修改 0 项，删除 0 项');
  assert.match(Buffer.from(writes[0].body.content, 'base64').toString('utf8'), /\n  "updatedAt":/);
  assert.equal(sync.api.getNavigationSyncState().status, 'connected');
});

test('public repositories are rejected before navigation files are written', async () => {
  const writes = [];
  const sync = createSync(async (url, options = {}) => {
    const method = options.method ?? 'GET';
    if (url.endsWith('/user')) return response(200, { login: 'owner' });
    if (url.endsWith('/repos/owner/repo')) return response(200, { private: false });
    if (url.includes('/contents/')) writes.push(method);
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  await assert.rejects(sync.api.connectNavigationSync('token', 'owner/repo', 'gitee'), /仅允许连接私有仓库/);
  assert.deepEqual(writes, []);
});

for (const failure of [
  { stage: 'privacy', status: 'error', message: /仅允许写入私有仓库/ },
  { stage: 'read', status: 'error', message: /读取 GitHub 数据失败/ },
  { stage: 'write', status: 'conflict', message: /云端版本已变化/ },
]) {
  test(`manual sync publishes ${failure.stage} failures and can recover`, async () => {
    let fail = false;
    const writes = [];
    const sync = createSync(async (url, options = {}) => {
      const method = options.method ?? 'GET';
      if (url.endsWith('/user')) return response(200, { username: 'owner' });
      if (url.endsWith('/projects/owner%2Frepo')) {
        return response(200, { visibility: fail && failure.stage === 'privacy' ? 'public' : 'private' });
      }
      if (url.includes('/repository/files/')) {
        if (method === 'GET') return response(fail && failure.stage === 'read' ? 503 : 404);
        writes.push(method);
        return response(fail && failure.stage === 'write' ? 409 : 201);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    await sync.api.connectNavigationSync('token', 'owner/repo', 'gitlab');
    const lastSync = sync.api.getNavigationSyncState().lastSync;
    const states = [];
    sync.api.subscribeNavigationSync(state => states.push(state));
    fail = true;

    await assert.rejects(sync.api.syncNavigationNow(), failure.message);

    const state = sync.api.getNavigationSyncState();
    assert.equal(state.status, failure.status);
    assert.match(state.error, failure.message);
    assert.equal(state.lastSync, lastSync);
    assert.equal(states.at(-2).status, 'syncing');
    assert.equal(writes.length, failure.stage === 'write' ? 2 : 1);

    fail = false;
    await sync.api.syncNavigationNow();
    assert.equal(sync.api.getNavigationSyncState().status, 'connected');
    assert.equal(sync.api.getNavigationSyncState().error, '');
  });
}
