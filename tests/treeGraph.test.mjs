import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync(new URL('../src/lib/treeGraph.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText.replace('"d3-hierarchy"', JSON.stringify(import.meta.resolve('d3-hierarchy')));
const { parseTreeGraph, layoutTreeMindMap, countTreeGraphNames, buildReverseTree, changeTreeNode, getTreeSubtree } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('cut and paste moves the entire subtree with comments and adapts indentation', () => {
  const source = 'root\n  same // note\n    leaf\n  same';
  const clipboard = getTreeSubtree(source, 2);
  assert.equal(clipboard, 'same // note\n  leaf');
  const cut = changeTreeNode(source, 2, 'delete');
  assert.equal(changeTreeNode(cut, 2, 'paste', clipboard), 'root\n  same\n    same // note\n      leaf');
  assert.equal(changeTreeNode('target\r\n\texisting', 1, 'paste', clipboard), 'target\r\n\texisting\r\n\tsame // note\r\n\t\tleaf');
  assert.equal(getTreeSubtree(source, 99), '');
  assert.equal(changeTreeNode(source, 1, 'paste', ''), source);
});

test('node mutations target source lines, preserve comments and line endings, and remove subtrees', () => {
  const source = 'root\r\n\tsame // note\r\n\t\tleaf\r\n\tsame\r\nother';
  assert.equal(changeTreeNode(source, 4, 'edit', 'renamed'), source.replace('\tsame\r\nother', '\trenamed\r\nother'));
  assert.equal(changeTreeNode(source, 2, 'edit', 'renamed'), source.replace('same // note', 'renamed // note'));
  assert.equal(changeTreeNode(source, 2, 'add', 'new'), source.replace('\t\tleaf\r\n', '\t\tleaf\r\n\t\tnew\r\n'));
  assert.equal(changeTreeNode(source, 2, 'delete'), 'root\r\n\tsame\r\nother');
  assert.equal(changeTreeNode(source, 2, 'comment', 'a\nb'), source.replace('// note', '// a b'));
  assert.equal(changeTreeNode(source, 2, 'edit', 'bad//name'), source);
  assert.equal(changeTreeNode(source, 99, 'delete'), source);
});

test('counts shared names by distinct tree file and builds reverse ancestor paths', () => {
  const trees = [
    { path: 'one.tree', content: 'root\n  shared\n  shared' },
    { path: 'two.tree', content: 'other\n  shared\n    leaf' },
    { path: 'three.tree', content: 'alone' },
  ];
  assert.equal(countTreeGraphNames(trees).get('shared'), 2);
  const reverse = buildReverseTree('shared', trees);
  assert.equal(reverse.children.length, 2);
  assert.deepEqual(reverse.children.map(parent => parent.name).sort(), ['other', 'root']);
  assert.equal(reverse.children.find(parent => parent.name === 'other').children[0].sourcePath, 'two.tree');
});

test('mind map distributes branches on both sides and keeps descendants on their branch side', () => {
  const nodes = layoutTreeMindMap(parseTreeGraph('root\n  first\n    child\n  second\n  third'));
  assert.equal(nodes.length, 5);
  assert.equal(nodes[0].x, 0);
  assert.ok(nodes.some(node => node.x < 0));
  assert.ok(nodes.some(node => node.x > 0));
  const child = nodes.find(item => item.node.name === 'child');
  const parent = nodes.find(item => item.node.id === child.parent);
  assert.equal(child.side, parent.side);
  assert.ok(Math.abs(child.x) > Math.abs(parent.x));
});

test('mind map reserves nonoverlapping space for long labels and multiple roots', () => {
  const nodes = layoutTreeMindMap(parseTreeGraph(`root\n  ${'长文本'.repeat(60)}\n  short\n  another\nother root\n  leaf`));
  for (const node of nodes) {
    for (const other of nodes) {
      if (node.node.id >= other.node.id) continue;
      assert.ok(node.x + node.width <= other.x || other.x + other.width <= node.x ||
        node.y + node.height <= other.y || other.y + other.height <= node.y);
    }
  }
  assert.deepEqual(layoutTreeMindMap([]), []);
});

test('compact layout adapts label widths and centers a single child on its parent', () => {
  const nodes = layoutTreeMindMap(parseTreeGraph('root\n  branch\n    8K\n  another branch\n    a considerably longer label'));
  const short = nodes.find(item => item.node.name === '8K');
  const long = nodes.find(item => item.node.name === 'a considerably longer label');
  const parent = nodes.find(item => item.node.id === short.parent);
  assert.ok(short.width < long.width);
  assert.equal(short.y + short.height / 2, parent.y + parent.height / 2);
  assert.equal(short.depth, 2);
});

test('depth columns clear long cousins on both sides, including shared-name badges', () => {
  const long = '长名称节点'.repeat(12);
  const source = ['root'];
  for (let branch = 0; branch < 6; branch++) {
    source.push(`  branch${branch}`, `    ${branch < 2 ? long : 'short'}`, '      child', '        descendant');
  }
  const roots = parseTreeGraph(source.join('\n'));
  const counts = new Map([[long, 2], ['short', 3], ['root', 2]]);
  const nodes = layoutTreeMindMap(roots, counts);
  for (const side of [-1, 1]) {
    const topics = nodes.filter(node => node.side === side && node.depth === 2);
    const children = nodes.filter(node => node.side === side && node.depth === 3);
    assert.ok(topics.length && children.length);
    for (const topic of topics) {
      for (const child of children) {
        assert.ok(side === 1 ? child.x >= topic.x + topic.width + 54 : child.x + child.width + 54 <= topic.x);
      }
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    for (const other of nodes.slice(i + 1)) {
      const node = nodes[i];
      assert.ok(node.x + node.width <= other.x || other.x + other.width <= node.x ||
        node.y + node.height <= other.y || other.y + other.height <= node.y);
    }
  }
  const plain = layoutTreeMindMap(roots);
  assert.equal(nodes[0].width, plain[0].width + 32);
});

test('indentation defines parents and siblings across blank lines and multiple roots', () => {
  const tree = parseTreeGraph('\uFEFF根\r\n  子一\r\n    孙\r\n\r\n  子二\r\n另根\r\n\t制表子');
  assert.equal(tree.length, 2);
  assert.deepEqual(tree[0].children.map(node => node.name), ['子一', '子二']);
  assert.equal(tree[0].children[0].children[0].name, '孙');
  assert.equal(tree[1].children[0].name, '制表子');
});

test('supports arbitrary indentation widths, tabs, duplicate labels, and empty content', () => {
  const tree = parseTreeGraph('  root\n     same\n         descendant\n     same\n\t sibling');
  assert.equal(tree[0].children.length, 3);
  assert.equal(tree[0].children[0].children[0].name, 'descendant');
  assert.notEqual(tree[0].children[0].id, tree[0].children[1].id);
  assert.deepEqual(parseTreeGraph(' \n\t'), []);
});

test('preserves Chinese labels and every nonblank line', () => {
  const content = '图片\n  艺术风格与媒介\n    绘画风格\n      写实主义\n      水墨画\n  技术参数与渲染\n    画质要求\n      8K';
  const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children)]);
  const nodes = flatten(parseTreeGraph(content));
  assert.equal(nodes.length, content.split(/\r?\n/).filter(line => line.trim()).length);
  assert.equal(nodes[0].name, '图片');
});
