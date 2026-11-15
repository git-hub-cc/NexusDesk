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

function createSync(fetch, data = { categories: [] }, logicalData = null, values = new Map()) {
  let rootPath = logicalData ? "C:/project" : null;
  const applied = [];
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
    exports, fetch, window, localStorage: storage, atob, btoa, TextEncoder, TextDecoder, Uint8Array, AbortSignal, Event, console,
    CustomEvent: class {
      constructor(type, options) { this.type = type; this.detail = options?.detail; }
    },
    require(name) {
      if (name === '@/lib/globalSettings') return { settingsStorage: storage };
      if (name === '@/lib/api') return { fsApi: { getLogicalSyncData: async () => logicalData, applyLogicalSyncData: async (_root, next) => { applied.push(next); logicalData = { workspace: next.workspace, folders: next.folders, entries: next.entries }; } } };
      if (name === '@/store/workspaceStore') return { useWorkspaceStore: { getState: () => ({ rootPath }) } };
      if (name === './navigationData') return { loadNavigationData: async () => data, mergeNavigationData: (local) => local, saveNavigationData() {} };
      throw new Error(`Unexpected import: ${name}`);
    },
  };
  vm.runInNewContext(compiled, context);
  return {
    api: exports, values, applied,
    setLogical(next, root = rootPath) { logicalData = next; rootPath = root; },
    async save(type = "nexusdesk-navigation-data-changed") {
      window.dispatchEvent({ type });
      for (const [id, callback] of timers) {
        timers.delete(id);
        callback();
      }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

function repository(initial = {}) {
  const disk = new Map(Object.entries(initial));
  const writes = [];
  const revisions = new Map();
  return {
    disk, writes, fail: '',
    async fetch(url, options = {}) {
      const method = options.method ?? 'GET';
      if (url.endsWith('/user')) return response(200, { login: 'owner', username: 'owner' });
      if (!url.includes('/contents/') && !url.includes('/repository/files/')) return response(200, { private: true, visibility: 'private' });
      const name = decodeURIComponent(url.split(/\/contents\/|\/repository\/files\//)[1].split('?')[0]);
      const revision = revisions.get(name) ?? 0;
      if (method === 'GET') {
        const value = disk.get(name);
        return value ? response(200, { content: Buffer.from(JSON.stringify(value)).toString('base64'), encoding: 'base64', sha: `${name}-${revision}`, last_commit_id: `${name}-${revision}` }) : response(404);
      }
      const body = JSON.parse(options.body);
      if (this.fail === name) return response(409);
      if (url.includes('gitlab')) assert.equal(method, disk.has(name) ? 'PUT' : 'POST');
      else if (disk.has(name)) assert.equal(body.sha, `${name}-${revision}`);
      const content = JSON.parse(url.includes('gitlab') ? body.content : Buffer.from(body.content, 'base64').toString('utf8'));
      disk.set(name, content);
      writes.push({ name, method, body, content });
      revisions.set(name, revision + 1);
      return response(200, { content: { sha: `${name}-${revision + 1}` } });
    },
  };
}

const logicalSnapshot = (workspace = 'folder:project') => ({ workspace, folders: ['notes', 'empty'], entries: [{ path: 'a.md', category: 'notes', kind: 'reference' }] });

for (const provider of ['github', 'gitlab', 'gitee']) {
  test(`${provider}: files sync independently and preserve other workspaces`, async () => {
    const repo = repository({ 'logical-partitions.json': { version: 1, workspaces: { other: { folders: ['other'], entries: [] } } } });
    const sync = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
    sync.api.setCloudSyncSelection({ myNavigation: true, logicalPartitions: true });
    await sync.api.connectNavigationSync('token', 'owner/repo', provider);
    assert.deepEqual(new Set(repo.writes.map(write => write.name)), new Set(['navhub-data.json', 'logical-partitions.json']));
    assert.equal(repo.disk.get('navhub-data.json').logicalPartitions, undefined);
    assert.deepEqual(repo.disk.get('logical-partitions.json').workspaces.other, { folders: ['other'], entries: [] });
    assert.deepEqual(repo.disk.get('logical-partitions.json').workspaces['folder:project'].folders, ['empty', 'notes']);
    repo.writes.length = 0;
    await sync.save();
    assert.deepEqual(repo.writes.map(write => write.name), ['navhub-data.json']);
    repo.writes.length = 0;
    sync.setLogical({ ...logicalSnapshot(), folders: ['notes', 'empty', 'new'] });
    await sync.save('nexusdesk-logical-data-changed');
    assert.deepEqual(repo.writes.map(write => write.name), ['logical-partitions.json']);
    await sync.save('nexusdesk-logical-data-changed');
    assert.equal(repo.writes.length, 1, 'unchanged tree refresh must not create another commit');
  });
}

test('legacy migration preserves data until the new file is saved and retries cleanup', async () => {
  const legacy = logicalSnapshot('folder:old');
  const original = { navigationData: { categories: [] }, preferences: { theme: 'dark' }, logicalPartitions: legacy };
  const repo = repository({ 'navhub-data.json': original });
  repo.fail = 'logical-partitions.json';
  const sync = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
  sync.api.setCloudSyncSelection({ myNavigation: false, logicalPartitions: true });
  await assert.rejects(sync.api.connectNavigationSync('token', 'owner/repo', 'github'));
  assert.deepEqual(repo.disk.get('navhub-data.json'), original);
  repo.fail = 'navhub-data.json';
  await assert.rejects(sync.api.connectNavigationSync('token', 'owner/repo', 'github'));
  assert.deepEqual(repo.disk.get('logical-partitions.json').workspaces['folder:old'].entries, legacy.entries);
  assert.deepEqual(repo.disk.get('navhub-data.json'), original);
  repo.fail = '';
  await sync.api.connectNavigationSync('token', 'owner/repo', 'github');
  assert.equal(repo.disk.get('navhub-data.json').logicalPartitions, undefined);
  assert.deepEqual(repo.disk.get('navhub-data.json').preferences, original.preferences);
});

test('logical sync waits for a local project and resumes when it opens', async () => {
  const repo = repository();
  const sync = createSync(repo.fetch.bind(repo));
  sync.api.setCloudSyncSelection({ myNavigation: false, logicalPartitions: true });
  await sync.api.connectNavigationSync('token', 'owner/repo', 'github');
  assert.match(sync.api.getNavigationSyncState().logicalNotice, /等待打开本地项目/);
  assert.equal(repo.writes.length, 0);
  sync.setLogical(logicalSnapshot(), 'sftp:server/project');
  await sync.save('nexusdesk-logical-data-changed');
  assert.match(sync.api.getNavigationSyncState().logicalNotice, /SFTP/);
  assert.equal(repo.writes.length, 0);
  sync.setLogical(logicalSnapshot(), 'C:/project');
  await sync.save('nexusdesk-logical-data-changed');
  assert.equal(sync.api.getNavigationSyncState().logicalNotice, '');
  assert.deepEqual(repo.writes.map(write => write.name), ['logical-partitions.json']);
});

test('deletions survive reconnect and propagate to another device without resurrecting', async () => {
  const repo = repository();
  const deviceA = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
  const deviceB = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
  for (const device of [deviceA, deviceB]) {
    device.api.setCloudSyncSelection({ myNavigation: false, logicalPartitions: true });
    await device.api.connectNavigationSync('token', 'owner/repo', 'github');
  }
  const removed = { workspace: 'folder:project', folders: ['empty'], entries: [] };
  deviceA.setLogical(removed);
  await deviceA.save('nexusdesk-logical-data-changed');
  const remote = repo.disk.get('logical-partitions.json').workspaces['folder:project'];
  assert.deepEqual(remote.deletedFolders, ['notes']);
  assert.equal(remote.deletedEntries.length, 1);
  await deviceB.api.syncNavigationNow();
  assert.deepEqual(JSON.parse(JSON.stringify(deviceB.applied.at(-1).folders)), ['empty']);
  assert.equal(deviceB.applied.at(-1).entries.length, 0);
  const restarted = createSync(repo.fetch.bind(repo), { categories: [] }, removed, deviceA.values);
  await restarted.api.connectNavigationSync('token', 'owner/repo', 'github');
  assert.equal(repo.disk.get('logical-partitions.json').workspaces['folder:project'].entries.length, 0);
  deviceB.setLogical(logicalSnapshot());
  await deviceB.save('nexusdesk-logical-data-changed');
  assert.equal(repo.disk.get('logical-partitions.json').workspaces['folder:project'].entries.length, 1, 'explicit recreation should sync');
});

test('disabled logical sync preserves legacy data and does not create a partition file', async () => {
  const repo = repository({ 'navhub-data.json': { logicalPartitions: logicalSnapshot() } });
  const sync = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
  await sync.api.connectNavigationSync('token', 'owner/repo', 'github');
  assert.ok(repo.disk.get('navhub-data.json').logicalPartitions);
  assert.equal(repo.disk.has('logical-partitions.json'), false);
});

test('one file failure does not prevent the other file from syncing or erase its error', async () => {
  const repo = repository();
  const sync = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
  sync.api.setCloudSyncSelection({ myNavigation: true, logicalPartitions: true });
  repo.fail = 'logical-partitions.json';
  await assert.rejects(sync.api.connectNavigationSync('token', 'owner/repo', 'github'));
  assert.ok(repo.disk.has('navhub-data.json'));
  assert.ok(sync.api.getNavigationSyncState().fileErrors.logical);
  await sync.save();
  assert.equal(sync.api.getNavigationSyncState().status, 'conflict');
  assert.ok(sync.api.getNavigationSyncState().fileErrors.logical);
  repo.fail = '';
  await sync.save('nexusdesk-logical-data-changed');
  assert.equal(sync.api.getNavigationSyncState().status, 'connected');
  assert.equal(sync.api.getNavigationSyncState().error, '');
});

test('automatic navigation upload preserves newly edited preferences', async () => {
  const repo = repository({ 'navhub-data.json': { navigationData: { categories: [] }, preferences: { theme: 'dark' } } });
  const sync = createSync(repo.fetch.bind(repo));
  await sync.api.connectNavigationSync('token', 'owner/repo', 'github');
  sync.values.set('theme-preference', 'light');
  await sync.save('nexusdesk-navigation-preferences-changed');
  assert.equal(repo.disk.get('navhub-data.json').preferences.theme, 'light');
});

test('malformed legacy data is preserved without writing or removing fields', async () => {
  const original = { logicalPartitions: { workspace: 'folder:old', folders: [] } };
  const repo = repository({ 'navhub-data.json': original });
  const sync = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
  sync.api.setCloudSyncSelection({ myNavigation: false, logicalPartitions: true });
  await assert.rejects(sync.api.connectNavigationSync('token', 'owner/repo', 'github'), /格式无效/);
  assert.equal(repo.writes.length, 0);
  assert.deepEqual(repo.disk.get('navhub-data.json'), original);
});

test('GitLab creates once and updates on the next automatic sync', async () => {
  const writes = [];
  const sync = createSync(async (url, options = {}) => {
    const method = options.method ?? 'GET';
    if (url.endsWith('/user')) return response(200, { username: 'owner' });
    if (url.endsWith('/projects/owner%2Frepo')) return response(200, { visibility: 'private' });
    if (method === 'GET' && url.includes('/repository/files/')) return writes.length ? response(200, { content: writes.at(-1).body.content, encoding: 'text' }) : response(404);
    if (url.includes('/repository/files/')) {
      writes.push({ method, body: JSON.parse(options.body) });
      return response(method === 'POST' ? 201 : 200, { file_path: 'navhub-data.json', branch: 'main' });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  await sync.api.connectNavigationSync('token', 'owner/repo', 'gitlab');
  await sync.save();

  assert.deepEqual(writes.map(write => write.method), ['POST', 'PUT']);
  assert.equal(writes[0].body.commit_message, '同步我的导航：更新显示偏好');
  assert.match(writes[0].body.content, /\n  "updatedAt":/);
  assert.equal(sync.api.getNavigationSyncState().status, 'connected');
});

test('Gitee writes formatted JSON and describes navigation additions', async () => {
  const writes = [];
  const sync = createSync(async (url, options = {}) => {
    const method = options.method ?? 'GET';
    if (url.endsWith('/user')) return response(200, { login: 'owner' });
    if (url.endsWith('/repos/owner/repo')) return response(200, { private: true });
    if (method === 'GET' && url.includes('/contents/')) return writes.length ? response(200, { content: writes.at(-1).body.content, sha: `sha-${writes.length}` }) : response(404);
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
  assert.equal(writes[0].body.message, '同步我的导航：新增 2 项，修改 0 项，删除 0 项');
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
  { stage: 'read', status: 'error', message: /读取 gitlab 数据失败/ },
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
    assert.ok(states.some(state => state.status === 'syncing'));
    assert.equal(writes.length, failure.stage === 'write' ? 2 : 1);

    fail = false;
    await sync.api.syncNavigationNow();
    assert.equal(sync.api.getNavigationSyncState().status, 'connected');
    assert.equal(sync.api.getNavigationSyncState().error, '');
  });
}
