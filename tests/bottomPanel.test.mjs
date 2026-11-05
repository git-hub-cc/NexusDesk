import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/components/layout/BottomPanel.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function harness(installed) {
  const layout = { bottomPanelTab: 'terminal', setBottomPanelTab: tab => { layout.bottomPanelTab = tab; } };
  const terminal = { profiles: [], sessions: [], activeSessionId: '' };
  const states = [];
  let index = 0;
  let effects = [];
  const GitPanel = () => {};
  const mocks = {
    react: {
      useState(initial) {
        const slot = index++;
        if (!(slot in states)) states[slot] = initial;
        return [states[slot], value => { states[slot] = value; }];
      },
      useEffect: effect => effects.push(effect),
    },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '@/lib/api': { gitApi: { isInstalled: async () => installed } },
    '@/store/layoutStore': { useLayoutStore: () => layout },
    '@/store/terminalStore': { useTerminalStore: () => terminal },
    '@/components/git/GitPanel': { GitPanel },
  };
  const context = { exports: {}, require: name => mocks[name] ?? {} };
  vm.runInNewContext(compiled, context);
  function render() {
    index = 0;
    effects = [];
    const tree = context.exports.BottomPanel();
    effects.forEach(effect => effect());
    return tree;
  }
  return { layout, terminal, render, GitPanel };
}

function contains(tree, type) {
  if (Array.isArray(tree)) return tree.some(child => contains(child, type));
  return !!tree && typeof tree === 'object' && (tree.type === type || contains(tree.props?.children, type));
}

test('restored terminal tab without sessions shows Git once detection completes', async () => {
  const f = harness(true);
  f.render();
  assert.equal(f.layout.bottomPanelTab, 'terminal', 'wait for Git detection');
  await new Promise(resolve => setImmediate(resolve));
  f.render();
  assert.equal(f.layout.bottomPanelTab, 'git');
  assert.ok(contains(f.render(), f.GitPanel));
  // Switching projects may restore another terminal tab after detection.
  f.layout.bottomPanelTab = 'terminal';
  f.render();
  assert.equal(f.layout.bottomPanelTab, 'git');
});

test('existing terminal sessions stay selected; closing the last session selects Git', async () => {
  const f = harness(true);
  f.terminal.sessions = [{ id: 'shell', name: '终端', command: '' }];
  f.terminal.activeSessionId = 'shell';
  f.render();
  await new Promise(resolve => setImmediate(resolve));
  f.render();
  assert.equal(f.layout.bottomPanelTab, 'terminal');
  f.terminal.sessions = [];
  f.render();
  assert.equal(f.layout.bottomPanelTab, 'git');
});

test('Git is not selected when it is unavailable', async () => {
  const f = harness(false);
  f.render();
  await new Promise(resolve => setImmediate(resolve));
  f.render();
  assert.equal(f.layout.bottomPanelTab, 'terminal');
});
