import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import ts from 'typescript';

function titleBar({ rootPath = null, exists = async () => true, confirmed = false, launchError = null } = {}) {
  const states = [];
  let cursor = 0;
  const prompts = [], errors = [], opened = [], checked = [], launched = [];
  let state = { rootPath, recentProjects: ['C:/existing', 'C:/missing'], setProject: async path => { opened.push(path); return true; } };
  const store = Object.assign(() => state, { setState: update => { state = { ...state, ...update(state) }; } });
  const source = readFileSync(new URL('../src/components/layout/TitleBar.tsx', import.meta.url), 'utf8').replace(/^import .*;\r?$/gm, '');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, React, snapshotCommit: null, flushGlobalSettings: async () => {},
    useEffect() {},
    settingsStorage: { getItem: () => null },
    invoke: async (command, args) => {
      launched.push({ command, path: args.path });
      if (launchError) throw launchError;
      return 123;
    },
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    getCurrentWindow: () => ({}), useWorkspaceStore: store, useLayoutStore: () => ({}),
    fsApi: { projectDirectoryExists: async path => { checked.push(path); return exists(path); } },
    confirmAction: async (...args) => { prompts.push(args); return confirmed; }, showError: error => errors.push(error),
    DropdownMenu: Object.fromEntries(['Root', 'Trigger', 'Portal', 'Content', 'Item', 'Separator', 'CheckboxItem', 'ItemIndicator'].map(key => [key, `Menu.${key}`])),
    Dialog: Object.fromEntries(['Root', 'Portal', 'Overlay', 'Content', 'Title', 'Close'].map(key => [key, `Dialog.${key}`])),
    ...Object.fromEntries(['Check', 'FolderTree', 'Link', 'PanelBottom', 'Minus', 'Square', 'X', 'ChevronDown'].map(key => [key, key])),
    noteideIcon: '', console,
  });
  function render() {
    cursor = 0;
    const nodes = [];
    function visit(node) { if (!React.isValidElement(node)) return; nodes.push(node); React.Children.forEach(node.props.children, visit); }
    visit(exports.TitleBar());
    return nodes;
  }
  return { render, prompts, errors, opened, checked, launched, state: () => state,
    item: path => render().find(node => node.type === 'Menu.Item' && node.key === path),
    async select(path) {
      render().find(node => node.type === 'Menu.Item' && node.key === path).props.onSelect();
      await new Promise(resolve => setImmediate(resolve));
    },
    refresh: () => render().find(node => node.props.onBeforeOpen).props.onBeforeOpen(),
  };
}

test('recent projects refresh missing colors and clear them when a directory returns', async () => {
  let missing = true;
  const bar = titleBar({ exists: async path => path !== 'C:/missing' || !missing });
  await bar.refresh();
  assert.match(bar.item('C:/missing').props.className, /recent-project-missing/);
  assert.doesNotMatch(bar.item('C:/existing').props.className, /recent-project-missing/);
  missing = false;
  await bar.refresh();
  assert.doesNotMatch(bar.item('C:/missing').props.className, /recent-project-missing/);
});

test('project badge shows two letters or one Chinese character and retains the full name', () => {
  for (const [rootPath, shortName, fullName] of [
    ['C:/NoteIDE', 'NO', 'NoteIDE'],
    ['C:/笔记项目', '笔', '笔记项目'],
    [null, 'NO', 'NoteIDE'],
  ]) {
    const badge = titleBar({ rootPath }).render().find(node => node.props.className === 'project-badge');
    assert.equal(badge.props.children, shortName);
    assert.equal(badge.props.title, fullName);
  }
});

test('new project launches a process and leaves the current project intact', async () => {
  const bar = titleBar({ rootPath: 'C:/current' });
  await bar.select('C:/existing');
  assert.equal(bar.render().find(node => node.type === 'Dialog.Root').props.open, true);
  await bar.render().find(node => node.type === 'button' && node.props.onClick?.name === 'openInNewWindow').props.onClick();
  assert.deepEqual(bar.launched, [{ command: 'open_project_instance', path: 'C:/existing' }]);
  assert.equal(bar.render().find(node => node.type === 'Dialog.Root').props.open, false);
  assert.equal(bar.state().rootPath, 'C:/current');
  assert.deepEqual(bar.opened, []);
});

test('process launch failure keeps the project dialog open and displays the error', async () => {
  const bar = titleBar({ rootPath: 'C:/current', launchError: 'Cannot start instance' });
  await bar.select('C:/existing');
  await bar.render().find(node => node.type === 'button' && node.props.onClick?.name === 'openInNewWindow').props.onClick();
  assert.equal(bar.render().find(node => node.type === 'Dialog.Root').props.open, true);
  const alert = bar.render().find(node => node.props.role === 'alert');
  assert.match(React.Children.toArray(alert.props.children).join(''), /Cannot start instance/);
  assert.deepEqual(bar.opened, []);
});

for (const confirmed of [false, true]) {
  test(`missing project prompts and ${confirmed ? 'removes only its record' : 'keeps its record'}`, async () => {
    const bar = titleBar({ exists: async () => false, confirmed });
    await bar.select('C:/missing');
    assert.equal(bar.prompts.length, 1);
    assert.match(bar.prompts[0][0], /C:\/missing/);
    assert.equal(bar.state().recentProjects.includes('C:/missing'), !confirmed);
    assert.ok(bar.state().recentProjects.includes('C:/existing'));
    assert.deepEqual(bar.opened, []);
  });
}

test('click checks a current project deleted after opening the menu', async () => {
  let exists = true;
  const bar = titleBar({ rootPath: 'C:/existing', exists: async () => exists });
  await bar.refresh();
  exists = false;
  await bar.select('C:/existing');
  assert.equal(bar.prompts.length, 1);
  assert.deepEqual(bar.opened, []);
});

test('existing project opens and directory check errors do not offer removal', async () => {
  const bar = titleBar();
  await bar.select('C:/existing');
  assert.deepEqual(bar.opened, ['C:/existing']);
  const failed = titleBar({ exists: async () => { throw new Error('access denied'); } });
  await failed.select('C:/existing');
  assert.equal(failed.prompts.length, 0);
  assert.match(failed.errors[0], /access denied/);
  assert.deepEqual(failed.opened, []);
  assert.equal(failed.state().recentProjects.length, 2);
});
