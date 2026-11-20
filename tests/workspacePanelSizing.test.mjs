import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const sizingSource = readFileSync(new URL('../src/utils/workspacePanelSizing.ts', import.meta.url), 'utf8');
const sizing = ts.transpileModule(sizingSource.replace(/export /g, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const { workspacePanelMinSize, sidebarMaxSize, fileTreeMinWidth, sidebarPanelSizing } = vm.runInNewContext(
  `(() => { ${sizing}; return { workspacePanelMinSize, sidebarMaxSize, fileTreeMinWidth, sidebarPanelSizing }; })()`,
);

// Exercise the installed splitter's actual redistribution with our constraints.
const splitterSource = readFileSync(new URL('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.esm.js', import.meta.url), 'utf8');
const splitterAlgorithm = splitterSource.slice(splitterSource.indexOf('function assert('), splitterSource.indexOf('function calculateAriaValues('));
const adjustLayoutByDelta = vm.runInNewContext(
  `(() => { const PRECISION = 10; ${splitterAlgorithm}; return adjustLayoutByDelta; })()`,
);

function drag(initialLayout, delta, pivotIndices) {
  const minSize = workspacePanelMinSize(1208, 8, 3);
  const treeMin = workspacePanelMinSize(1208, 8, 3, fileTreeMinWidth);
  return Array.from(adjustLayoutByDelta({
    initialLayout, prevLayout: initialLayout, delta, pivotIndices, trigger: 'mouse-or-touch',
    panelConstraints: [
      { minSize: treeMin, maxSize: sidebarMaxSize }, { minSize }, { minSize, maxSize: sidebarMaxSize },
    ],
  }));
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
}

// Run the workspace's actual measurement callback with minimized window bounds.
const workspaceSource = readFileSync(new URL('../src/components/layout/Workspace.tsx', import.meta.url), 'utf8');
const measurementStart = workspaceSource.indexOf('    const updateMinimum = () => {');
const measurementEnd = workspaceSource.indexOf('    updateMinimum();', measurementStart);
const measurement = ts.transpileModule(workspaceSource.slice(measurementStart, measurementEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function measurementHarness(rightSidebarVisible) {
  const values = [];
  const treeValues = [];
  const handle = { hasAttribute: () => true, getBoundingClientRect: () => ({ width: 4 }) };
  const group = { clientWidth: 1208, clientHeight: 800, children: rightSidebarVisible ? [handle, handle] : [handle] };
  const update = vm.runInNewContext(`(() => { ${measurement}; return updateMinimum; })()`, {
    group, leftSidebarVisible: true, rightSidebarVisible, workspacePanelMinSize, fileTreeMinWidth,
    setHorizontalMinSize: value => values.push(value),
    setFileTreeMinSize: value => treeValues.push(value),
  });
  return { group, values, treeValues, update };
}

for (const rightSidebarVisible of [false, true]) {
  test(`minimize and restore preserves panel constraints (${rightSidebarVisible ? 'two sidebars' : 'file tree'})`, () => {
    const h = measurementHarness(rightSidebarVisible);
    h.update();
    const original = h.values[0];
    const originalTree = h.treeValues[0];
    h.group.clientWidth = 0;
    h.update();
    h.group.clientWidth = 160;
    h.group.clientHeight = 0;
    h.update();
    assert.deepEqual(h.values, [original]);
    assert.deepEqual(h.treeValues, [originalTree]);
    h.group.clientWidth = 1208;
    h.group.clientHeight = 800;
    h.update();
    assert.deepEqual(h.values, [original, original]);
    assert.deepEqual(h.treeValues, [originalTree, originalTree]);
    // A genuinely narrow visible window must still enforce its minimum sizes.
    h.group.clientWidth = 600;
    h.update();
    const handleWidth = rightSidebarVisible ? 8 : 4;
    near(h.values.at(-1), workspacePanelMinSize(600, handleWidth, rightSidebarVisible ? 3 : 2));
    const treeMinimum = h.treeValues.at(-1);
    near(treeMinimum / 100 * (600 - handleWidth), 180);
    near(sidebarPanelSizing(20, treeMinimum).defaultSize, treeMinimum);
  });
}

test('panel minimum accounts for splitter widths and changes with the window', () => {
  near(workspacePanelMinSize(1208, 8, 3) / 100 * 1200, 260);
  near(workspacePanelMinSize(1004, 4, 2), 26);
  near(workspacePanelMinSize(600, 8, 3), 100 / 3);
  near(workspacePanelMinSize(0, 0, 3), 100 / 3);
});

test('growing file tree pushes the editor at minimum into spare right sidebar space', () => {
  const min = workspacePanelMinSize(1208, 8, 3);
  const treeMin = workspacePanelMinSize(1208, 8, 3, fileTreeMinWidth);
  const layout = drag([treeMin, min, 100 - treeMin - min], 10, [0, 1]);
  near(layout[0], treeMin + 10);
  near(layout[1], min);
  near(layout[2], 90 - treeMin - min);
});

test('growing right sidebar pushes the editor at minimum into spare file tree space', () => {
  const min = workspacePanelMinSize(1208, 8, 3);
  const treeMin = workspacePanelMinSize(1208, 8, 3, fileTreeMinWidth);
  const layout = drag([100 - 2 * min, min, min], -60, [1, 2]);
  near(layout[0], treeMin);
  near(layout[1], min);
  near(layout[2], 100 - treeMin - min);
});

test('dragging stops when both shrinking panels have reached minimum', () => {
  const min = workspacePanelMinSize(1208, 8, 3);
  const treeMin = workspacePanelMinSize(1208, 8, 3, fileTreeMinWidth);
  const layout = drag([treeMin, min, 100 - treeMin - min], 60, [0, 1]);
  near(layout[0], 100 - 2 * min);
  near(layout[1], min);
  near(layout[2], min);
});
