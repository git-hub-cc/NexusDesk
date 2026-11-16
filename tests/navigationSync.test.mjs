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

function createSync(fetch, data = { categories: [] }, logicalData = { workspace: "global", folders: [], entries: [] }, values = new Map(), fastInitialization = false) {
  let rootPath = logicalData ? "C:/project" : null;
  const applied = [];
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); },
    clearTimeout(id) { timers.delete(id); },
    setTimeout(callback, delay) {
      if (fastInitialization && delay !== 1800) return setTimeout(callback, 0);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
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
    setNavigation(next) { data = next; },
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

const logicalSnapshot = (workspace = 'global') => ({ workspace, folders: ['notes', 'empty'], entries: [{ path: 'C:/project/a.md', category: 'notes', kind: 'reference' }] });

test('new GitHub repository waits for its default branch and serializes initial commits', async () => {
  const repo = repository();
  let created = false;
  let branchChecks = 0;
  let writing = false;
  const sync = createSync(async (url, options = {}) => {
    const method = options.method ?? 'GET';
    if (url.endsWith('/repos/owner/repo') && !created) return response(404);
    if (url.endsWith('/user/repos')) {
      created = true;
      return response(201, { default_branch: 'master' });
    }
    if (url.endsWith('/git/ref/heads/master')) {
      branchChecks++;
      return response(branchChecks < 3 ? 404 : 200);
    }
    if (url.includes('/contents/')) {
      assert.equal(branchChecks, 3, 'file access must wait for initialization');
      if (method !== 'GET') {
        assert.equal(writing, false, 'repository commits must not overlap');
        assert.equal(JSON.parse(options.body).branch, 'master');
        writing = true;
        await new Promise(resolve => setImmediate(resolve));
        try { return await repo.fetch(url, options); }
        finally { writing = false; }
      }
      assert.equal(new URL(url).searchParams.get('ref'), 'master');
    }
    return repo.fetch(url, options);
  }, { categories: [] }, logicalSnapshot(), new Map(), true);
  sync.api.setCloudSyncSelection({ myNavigation: true, logicalPartitions: true });
  const states = [];
  sync.api.subscribeNavigationSync(state => states.push(state.status));

  await sync.api.connectNavigationSync('token', 'owner/repo', 'github');

  assert.equal(repo.writes.length, 2);
  assert.equal(sync.api.getNavigationSyncState().status, 'connected');
  assert.equal(states.includes('error'), false);
  assert.equal(states.includes('conflict'), false);
});

test('new GitHub repository reports initialization timeout without uploading files', async () => {
  let branchChecks = 0;
  const sync = createSync(async (url) => {
    if (url.endsWith('/user')) return response(200, { login: 'owner' });
    if (url.endsWith('/repos/owner/repo')) return response(404);
    if (url.endsWith('/user/repos')) return response(201, { default_branch: 'main' });
    if (url.endsWith('/git/ref/heads/main')) {
      branchChecks++;
      return response(409);
    }
    throw new Error(`Unexpected request: ${url}`);
  }, { categories: [] }, null, new Map(), true);

  await assert.rejects(sync.api.connectNavigationSync('token', 'owner/repo', 'github'), /仓库仍在初始化/);
  assert.equal(branchChecks, 6);
  assert.equal(sync.api.getNavigationSyncState().status, 'error');
});

test('repository creation validation errors retain the API message', async () => {
  const sync = createSync(async (url) => {
    if (url.endsWith('/user')) return response(200, { login: 'owner' });
    if (url.endsWith('/repos/owner/repo')) return response(404);
    if (url.endsWith('/user/repos')) return response(422, { message: 'Repository creation failed: name already exists' });
    throw new Error(`Unexpected request: ${url}`);
  });
  await assert.rejects(sync.api.connectNavigationSync('token', 'owner/repo', 'github'), /name already exists/);
});

for (const provider of ['github', 'gitlab', 'gitee']) {
  test(`${provider}: unchanged events stay idle and real edits upload only once`, async () => {
    const repo = repository();
    let requests = 0;
    const sync = createSync((...args) => { requests++; return repo.fetch(...args); }, { categories: [] }, logicalSnapshot());
    sync.api.setCloudSyncSelection({ myNavigation: true, logicalPartitions: true });
    await sync.api.connectNavigationSync('token', 'owner/repo', provider);
    const initialRequests = requests;
    const initialDocument = JSON.stringify(repo.disk.get('navhub.json'));
    const states = [];
    sync.api.subscribeNavigationSync(state => states.push(state.status));

    for (let repeat = 0; repeat < 3; repeat++) {
      await sync.save();
      await sync.save('nexusdesk-navigation-preferences-changed');
      sync.setLogical({ ...logicalSnapshot(), folders: ['empty', 'notes'] });
      await sync.save('nexusdesk-logical-data-changed');
      await sync.api.initializeNavigationSync();
    }
    assert.equal(requests, initialRequests, 'unchanged events and reopening settings must not access the repository');
    assert.equal(states.includes('syncing'), false);
    assert.equal(repo.writes.length, 2);

    await sync.api.syncNavigationNow();
    assert.equal(repo.writes.length, 2, 'manual sync must not commit unchanged content');
    assert.equal(JSON.stringify(repo.disk.get('navhub.json')), initialDocument);

    sync.setNavigation({ categories: [{ categoryId: 'custom-user-sites', categoryName: '我的导航', sites: [{ id: 'one', title: 'Example', url: 'https://example.com' }] }] });
    await sync.save();
    assert.equal(repo.writes.length, 3);
    assert.equal(repo.disk.get('navhub.json').navigationData.categories[0].sites[0].title, 'Example');
    const afterEditRequests = requests;
    await sync.save();
    assert.equal(requests, afterEditRequests);
    assert.equal(sync.api.getNavigationSyncState().status, 'connected');
  });

  test(`${provider}: files sync independently and preserve other workspaces`, async () => {
    const repo = repository({ 'logical-partitions.json': { version: 1, workspaces: { other: { folders: ['other'], entries: [] } } } });
    const sync = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
    sync.api.setCloudSyncSelection({ myNavigation: true, logicalPartitions: true });
    await sync.api.connectNavigationSync('token', 'owner/repo', provider);
    assert.deepEqual(new Set(repo.writes.map(write => write.name)), new Set(['navhub.json', 'logical-partitions.json']));
    assert.equal(repo.disk.get('navhub.json').logicalPartitions, undefined);
    assert.deepEqual(repo.disk.get('logical-partitions.json').workspaces.other, { folders: ['other'], entries: [] });
    assert.deepEqual(repo.disk.get('logical-partitions.json').workspaces.global.folders, ['empty', 'notes']);
    repo.writes.length = 0;
    sync.values.set('proxy-mode-preference', 'true');
    await sync.save();
    assert.deepEqual(repo.writes.map(write => write.name), ['navhub.json']);
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
  const original = { navigationData: { categories: [] }, preferences: { proxyMode: false }, logicalPartitions: legacy };
  const repo = repository({ 'navhub.json': original });
  repo.fail = 'logical-partitions.json';
  const sync = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
  sync.api.setCloudSyncSelection({ myNavigation: false, logicalPartitions: true });
  await assert.rejects(sync.api.connectNavigationSync('token', 'owner/repo', 'github'));
  assert.deepEqual(repo.disk.get('navhub.json'), original);
  repo.fail = 'navhub.json';
  await assert.rejects(sync.api.connectNavigationSync('token', 'owner/repo', 'github'));
  assert.deepEqual(repo.disk.get('logical-partitions.json').workspaces['folder:old'].entries, legacy.entries);
  assert.deepEqual(repo.disk.get('navhub.json'), original);
  repo.fail = '';
  await sync.api.connectNavigationSync('token', 'owner/repo', 'github');
  assert.equal(repo.disk.get('navhub.json').logicalPartitions, undefined);
  assert.deepEqual(repo.disk.get('navhub.json').preferences, original.preferences);
});

test('logical sync shares one snapshot across local projects, SFTP and no project', async () => {
  const repo = repository();
  const sync = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
  sync.api.setCloudSyncSelection({ myNavigation: false, logicalPartitions: true });
  await sync.api.connectNavigationSync('token', 'owner/repo', 'github');
  const initialWrites = repo.writes.length;
  const folders = ['notes', 'empty'];
  for (const root of ['C:/other', 'sftp:server/project', null]) {
    sync.setLogical(logicalSnapshot(), root);
    await sync.save('nexusdesk-logical-data-changed');
    assert.equal(sync.api.getNavigationSyncState().logicalNotice, '');
    assert.equal(repo.writes.length, initialWrites);
  }
  for (const root of ['C:/other', 'sftp:server/project', null]) {
    folders.push(`shared-${folders.length}`);
    sync.setLogical({ ...logicalSnapshot(), folders: [...folders] }, root);
    await sync.save('nexusdesk-logical-data-changed');
    assert.deepEqual(repo.disk.get('logical-partitions.json').workspaces.global.folders, [...folders].sort());
  }
  assert.deepEqual(Object.keys(repo.disk.get('logical-partitions.json').workspaces), ['global']);
});

test('deletions survive reconnect and propagate to another device without resurrecting', async () => {
  const repo = repository();
  const deviceA = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
  const deviceB = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
  for (const device of [deviceA, deviceB]) {
    device.api.setCloudSyncSelection({ myNavigation: false, logicalPartitions: true });
    await device.api.connectNavigationSync('token', 'owner/repo', 'github');
  }
  const removed = { workspace: 'global', folders: ['empty'], entries: [] };
  deviceA.setLogical(removed);
  await deviceA.save('nexusdesk-logical-data-changed');
  const remote = repo.disk.get('logical-partitions.json').workspaces.global;
  assert.deepEqual(remote.deletedFolders, ['notes']);
  assert.equal(remote.deletedEntries.length, 1);
  await deviceB.api.syncNavigationNow();
  assert.deepEqual(JSON.parse(JSON.stringify(deviceB.applied.at(-1).folders)), ['empty']);
  assert.equal(deviceB.applied.at(-1).entries.length, 0);
  const restarted = createSync(repo.fetch.bind(repo), { categories: [] }, removed, deviceA.values);
  await restarted.api.connectNavigationSync('token', 'owner/repo', 'github');
  assert.equal(repo.disk.get('logical-partitions.json').workspaces.global.entries.length, 0);
  deviceB.setLogical(logicalSnapshot());
  await deviceB.save('nexusdesk-logical-data-changed');
  assert.equal(repo.disk.get('logical-partitions.json').workspaces.global.entries.length, 1, 'explicit recreation should sync');
});

test('disabled logical sync preserves legacy data and does not create a partition file', async () => {
  const repo = repository({ 'navhub.json': { logicalPartitions: logicalSnapshot() } });
  const sync = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
  await sync.api.connectNavigationSync('token', 'owner/repo', 'github');
  assert.ok(repo.disk.get('navhub.json').logicalPartitions);
  assert.equal(repo.disk.has('logical-partitions.json'), false);
});

test('one file failure does not prevent the other file from syncing or erase its error', async () => {
  const repo = repository();
  const sync = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
  sync.api.setCloudSyncSelection({ myNavigation: true, logicalPartitions: true });
  repo.fail = 'logical-partitions.json';
  await assert.rejects(sync.api.connectNavigationSync('token', 'owner/repo', 'github'));
  assert.ok(repo.disk.has('navhub.json'));
  assert.ok(sync.api.getNavigationSyncState().fileErrors.logical);
  await sync.save();
  assert.equal(sync.api.getNavigationSyncState().status, 'conflict');
  assert.ok(sync.api.getNavigationSyncState().fileErrors.logical);
  repo.fail = '';
  await sync.save('nexusdesk-logical-data-changed');
  assert.equal(sync.api.getNavigationSyncState().status, 'connected');
  assert.equal(sync.api.getNavigationSyncState().error, '');
});

test('legacy cloud theme is ignored and removed while proxy preferences still sync', async () => {
  const repo = repository({ 'navhub.json': { navigationData: { categories: [] }, preferences: { theme: 'light', proxyMode: true } } });
  const sync = createSync(repo.fetch.bind(repo));
  await sync.api.connectNavigationSync('token', 'owner/repo', 'github');

  assert.equal(sync.values.has('theme-preference'), false);
  assert.equal(sync.values.get('proxy-mode-preference'), 'true');
  assert.deepEqual(repo.disk.get('navhub.json').preferences, { proxyMode: true });
  const writeCount = repo.writes.length;
  sync.values.set('theme-preference', 'light');
  await sync.save('nexusdesk-navigation-preferences-changed');
  assert.equal(repo.writes.length, writeCount);
});

test('automatic navigation upload preserves newly edited preferences', async () => {
  const repo = repository({ 'navhub.json': { navigationData: { categories: [] }, preferences: { proxyMode: false } } });
  const sync = createSync(repo.fetch.bind(repo));
  await sync.api.connectNavigationSync('token', 'owner/repo', 'github');
  sync.values.set('proxy-mode-preference', 'true');
  await sync.save('nexusdesk-navigation-preferences-changed');
  assert.equal(repo.disk.get('navhub.json').preferences.proxyMode, true);
});

test('malformed legacy data is preserved without writing or removing fields', async () => {
  const original = { logicalPartitions: { workspace: 'folder:old', folders: [] } };
  const repo = repository({ 'navhub.json': original });
  const sync = createSync(repo.fetch.bind(repo), { categories: [] }, logicalSnapshot());
  sync.api.setCloudSyncSelection({ myNavigation: false, logicalPartitions: true });
  await assert.rejects(sync.api.connectNavigationSync('token', 'owner/repo', 'github'), /格式无效/);
  assert.equal(repo.writes.length, 0);
  assert.deepEqual(repo.disk.get('navhub.json'), original);
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
      return response(method === 'POST' ? 201 : 200, { file_path: 'navhub.json', branch: 'main' });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  await sync.api.connectNavigationSync('token', 'owner/repo', 'gitlab');
  sync.values.set('proxy-mode-preference', 'true');
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
  sync.values.set('proxy-mode-preference', 'true');
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

test('existing global absolute entries and normalized tombstones apply across projects', async () => {
  const global = {
    folders: ['shared'],
    entries: [
      { path: 'C:/elsewhere/keep.md', category: 'shared', kind: 'reference' },
      { path: 'C:/Elsewhere/removed.md', category: 'shared', kind: 'copy' },
    ],
    deletedFolders: [],
    deletedEntries: [JSON.stringify(['copy', 'c:/elsewhere/removed.md', 'shared'])],
  };
  const repo = repository({ 'logical-partitions.json': { version: 1, workspaces: { global } } });
  const sync = createSync(repo.fetch.bind(repo));
  sync.setLogical({ workspace: 'global', folders: [], entries: [] }, null);
  sync.api.setCloudSyncSelection({ myNavigation: false, logicalPartitions: true });
  await sync.api.connectNavigationSync('token', 'owner/repo', 'github');
  assert.equal(sync.applied.length, 1);
  assert.equal(sync.applied[0].workspace, 'global');
  assert.deepEqual(Array.from(sync.applied[0].entries, entry => entry.path), ['C:/elsewhere/keep.md']);
});

test('legacy workspace migrates relative paths and tombstones into global once', async () => {
  const old = {
    folders: ['notes'],
    entries: [
      { path: 'kept.md', category: 'notes', kind: 'reference' },
      { path: 'removed.md', category: 'notes', kind: 'copy' },
    ],
    deletedEntries: [JSON.stringify(['copy', 'removed.md', 'notes'])],
  };
  const repo = repository({ 'logical-partitions.json': { version: 1, workspaces: { 'folder:project': old } } });
  const local = { workspace: 'global', legacyWorkspace: 'folder:project', folders: [], entries: [] };
  const sync = createSync(repo.fetch.bind(repo), { categories: [] }, local);
  sync.api.setCloudSyncSelection({ myNavigation: false, logicalPartitions: true });
  await sync.api.connectNavigationSync('token', 'owner/repo', 'github');
  const document = repo.disk.get('logical-partitions.json');
  assert.equal(document.workspaces['folder:project'], undefined);
  assert.deepEqual(document.workspaces.global.entries.map(entry => entry.path), ['C:/project/kept.md']);
  assert.equal(sync.applied[0].workspace, 'global');
});
