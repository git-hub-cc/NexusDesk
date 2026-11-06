const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { createJSONStorage } = require('zustand/middleware');

function setup({ native = true, values = {}, write, read } = {}) {
  const calls = [], errors = [];
  const disk = { ...values };
  const window = Object.assign(new EventTarget(), { setInterval() {} });
  const source = fs.readFileSync('src/lib/globalSettings.ts', 'utf8').replace(/^import .*;$/gm, '');
  const context = { exports: {}, createJSONStorage, window, Event,
    globalSettingKeys: JSON.parse(fs.readFileSync("src/lib/globalSettingKeys.json", "utf8")),
    document: { visibilityState: 'visible' }, isTauri: () => native,
    console: { error: (...args) => errors.push(args) },
    localStorage: { getItem: key => disk[key] ?? null, setItem: (key, value) => { disk[key] = value; } },
    invoke: async (command, args) => {
      calls.push({ command, ...args });
      if (command === 'read_global_settings') return read ? await read({ ...disk }) : { ...disk };
      const value = write ? await write(args) : args.value;
      disk[args.key] = value;
      return value;
    },
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return { ...context.exports, window, calls, errors, disk };
}

test('shared settings are available before stores hydrate and refresh across project profiles', async () => {
  const initial = JSON.stringify({ state: { recentProjects: ['A'] }, version: 0 });
  const env = setup({ values: { 'nexusdesk-workspace-storage': initial } });
  await env.initializeGlobalSettings();
  assert.equal(env.settingsStorage.getItem('nexusdesk-workspace-storage'), initial);
  assert.equal(env.globalJsonStorage.getItem('nexusdesk-workspace-storage').state.recentProjects[0], 'A');
  let changed = 0;
  env.window.addEventListener('global-settings-changed', () => changed++);
  env.disk['nexusdesk-workspace-storage'] = JSON.stringify({ state: { recentProjects: ['B', 'A'] }, version: 0 });
  await env.refreshGlobalSettings();
  assert.equal(changed, 1);
  assert.equal(env.globalJsonStorage.getItem('nexusdesk-workspace-storage').state.recentProjects[0], 'B');
});

test('writes serialize with their previous value and accept the backend concurrent merge', async () => {
  let finish;
  const first = new Promise(resolve => { finish = resolve; });
  let number = 0;
  const env = setup({ values: { 'nexusdesk-ui:test': 'old' }, write: async args => ++number === 1 ? first : `${args.value}+remote` });
  await env.initializeGlobalSettings();
  env.settingsStorage.setItem('nexusdesk-ui:test', 'one');
  env.settingsStorage.setItem('nexusdesk-ui:test', 'two');
  assert.equal(env.calls.filter(call => call.command === 'write_global_setting').length, 1);
  finish('one+remote');
  await env.flushGlobalSettings();
  const writes = env.calls.filter(call => call.command === 'write_global_setting');
  assert.equal(writes[0].previous, 'old');
  assert.equal(writes[1].previous, 'one');
  assert.equal(env.settingsStorage.getItem('nexusdesk-ui:test'), 'two+remote');
});

test('failed writes keep optimistic edits and can be retried before opening another instance', async () => {
  let fail = true;
  const env = setup({ write: async args => { if (fail) throw new Error('disk busy'); return args.value; } });
  await env.initializeGlobalSettings();
  env.settingsStorage.setItem('nexusdesk-ui:test', 'changed');
  await assert.rejects(env.flushGlobalSettings(), /disk busy/);
  assert.equal(env.settingsStorage.getItem('nexusdesk-ui:test'), 'changed');
  fail = false;
  await env.flushGlobalSettings();
  assert.equal(env.disk['nexusdesk-ui:test'], 'changed');
});

test('refresh waits for pending edits to reach the backend before reading remote settings', async () => {
  let resolveRead;
  const pending = new Promise(resolve => { resolveRead = resolve; });
  const deferred = setup({ values: { 'nexusdesk-ui:test': 'old' }, write: () => pending });
  await deferred.initializeGlobalSettings();
  deferred.settingsStorage.setItem('nexusdesk-ui:test', 'local');
  const refresh = deferred.refreshGlobalSettings();
  await Promise.resolve();
  assert.equal(deferred.calls.filter(call => call.command === 'read_global_settings').length, 1);
  resolveRead('local');
  await refresh;
  assert.equal(deferred.settingsStorage.getItem('nexusdesk-ui:test'), 'local');
});

test('browser-only mode keeps local storage and identical persisted state does not write IPC', async () => {
  const browser = setup({ native: false });
  browser.settingsStorage.setItem('nexusdesk-ui:test', 'browser');
  assert.equal(browser.settingsStorage.getItem('nexusdesk-ui:test'), 'browser');
  assert.equal(browser.calls.length, 0);
  const env = setup({ values: { 'nexusdesk-ui:test': 'same' } });
  await env.initializeGlobalSettings();
  env.settingsStorage.setItem('nexusdesk-ui:test', 'same');
  await env.flushGlobalSettings();
  assert.equal(env.calls.filter(call => call.command === 'write_global_setting').length, 0);
});

test('a delayed remote read cannot overwrite edits made locally after the read began', async () => {
  let number = 0, finishRead, started;
  const entered = new Promise(resolve => { started = resolve; });
  const paused = new Promise(resolve => { finishRead = resolve; });
  const env = setup({ values: { 'nexusdesk-ui:test': 'old' }, read: values => {
    if (++number === 1) return values;
    started();
    return paused;
  } });
  await env.initializeGlobalSettings();
  const refresh = env.refreshGlobalSettings();
  await entered;
  env.settingsStorage.setItem('nexusdesk-ui:test', 'local');
  finishRead({ 'nexusdesk-ui:test': 'remote' });
  await refresh;
  await env.flushGlobalSettings();
  assert.equal(env.settingsStorage.getItem('nexusdesk-ui:test'), 'local');
});

test('permanently rejected keys do not block other settings or opening a new window', async () => {
  const env = setup({ values: { 'nexusdesk-ui:old': 'before' }, write: async args => {
    if (args.key === 'nexusdesk-ui:old') throw 'Unknown global setting';
    return args.value;
  } });
  await env.initializeGlobalSettings();
  env.settingsStorage.setItem('nexusdesk-ui:old', 'invalid');
  env.settingsStorage.setItem('nexusdesk-ui:good', 'saved');
  await env.flushGlobalSettings();
  assert.equal(env.disk['nexusdesk-ui:good'], 'saved');
  assert.equal(env.settingsStorage.getItem('nexusdesk-ui:old'), 'before');
  env.settingsStorage.setItem('nexusdesk-ui:old', 'another rejected edit');
  await env.flushGlobalSettings();
  await env.refreshGlobalSettings();
  assert.equal(env.calls.filter(call => call.key === 'nexusdesk-ui:old').length, 1);
  assert.equal(env.errors.length, 1);
  assert.match(env.errors[0][0], /key=nexusdesk-ui:old/);
});

test('transient failures preserve same-key order while other keys and remote reads progress', async () => {
  let fail = true;
  const env = setup({ values: { 'nexusdesk-ui:remote': 'old' }, write: async args => {
    if (fail && args.key === 'nexusdesk-ui:busy') throw new Error('disk busy');
    return args.value;
  } });
  await env.initializeGlobalSettings();
  env.settingsStorage.setItem('nexusdesk-ui:busy', 'one');
  env.settingsStorage.setItem('nexusdesk-ui:busy', 'two');
  env.settingsStorage.setItem('nexusdesk-ui:good', 'saved');
  await assert.rejects(env.flushGlobalSettings(), /key=nexusdesk-ui:busy/);
  assert.equal(env.disk['nexusdesk-ui:good'], 'saved');
  env.disk['nexusdesk-ui:remote'] = 'remote';
  await env.refreshGlobalSettings();
  assert.equal(env.settingsStorage.getItem('nexusdesk-ui:remote'), 'remote');
  assert.equal(env.settingsStorage.getItem('nexusdesk-ui:busy'), 'two');
  assert.equal(env.calls.filter(call => call.key === 'nexusdesk-ui:busy').length, 1);
  fail = false;
  await env.flushGlobalSettings();
  assert.equal(env.disk['nexusdesk-ui:busy'], 'two');
  const writes = env.calls.filter(call => call.key === 'nexusdesk-ui:busy');
  assert.equal(writes.at(-1).previous, 'one');
});

test('frontend key contract rejects unsupported keys without caching or sending them', () => {
  const env = setup();
  assert.throws(() => env.settingsStorage.setItem('unsupported', 'secret'), /Unknown global setting: unsupported/);
  assert.equal(env.settingsStorage.getItem('unsupported'), null);
  assert.equal(env.calls.length, 0);
  for (const key of ['nexusdesk-workspace-storage', 'nexusdesk-terminal-profiles', 'nexusdesk-browser-history',
    'nexusdesk.music.libraryTab', 'nexusdesk.http.extraction.v1', 'sftp-profile:user@host', 'sftp-label:host', 'nexusdesk-ui:layout']) {
    assert.equal(env.isGlobalSetting(key), true);
  }
});
