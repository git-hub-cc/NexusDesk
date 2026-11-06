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
  const terminal = { profiles: [], sessions: [], activeSessionId: '', createSession: async () => true };
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
      useRef: initial => ({ current: initial }),
      useEffect: effect => effects.push(effect),
    },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '@/lib/api': { gitApi: { isInstalled: async () => installed } },
    '@/store/layoutStore': { useLayoutStore: () => layout },
    '@/store/terminalStore': { useTerminalStore: Object.assign(() => terminal, { getState: () => terminal, setState: () => {} }) },
    '@/store/workspaceStore': { useWorkspaceStore: { getState: () => ({ rootPath: 'C:/workspace' }) } },
    '@/components/git/GitPanel': { GitPanel },
    '@dnd-kit/core': { DndContext: 'DndContext', PointerSensor: 'PointerSensor', closestCenter: () => {}, useSensor: () => ({}), useSensors: () => [] },
    '@dnd-kit/sortable': { SortableContext: 'SortableContext', horizontalListSortingStrategy: () => {}, useSortable: () => ({}) },
    '@dnd-kit/utilities': { CSS: { Transform: { toString: () => '' } } },
  };
  const context = {
    exports: {},
    window: { addEventListener() {}, removeEventListener() {} },
    require: name => mocks[name] ?? {},
  };
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

test('configured CLI tools get launch buttons that use their profile', async () => {
  const f = harness(false);
  const claude = { id: 'claude', name: 'Claude', command: 'claude' };
  f.terminal.profiles = [{ id: 'shell', name: '终端', command: '' }, { id: 'codex', name: 'Codex', command: 'codex' }, claude];
  let launch;
  f.terminal.createSession = async (profile, cwd) => { launch = { profile, cwd }; return true; };
  const tree = f.render();
  function findButton(node) {
    if (Array.isArray(node)) return node.flatMap(findButton);
    if (!node || typeof node !== 'object') return [];
    return [...(node.type === 'button' && node.props.title === '启动 Claude' ? [node] : []), ...findButton(node.props?.children)];
  }
  const [button] = findButton(tree);
  assert.ok(button);
  await button.props.onClick();
  assert.deepEqual(launch, { profile: claude, cwd: 'C:/workspace' });
});
