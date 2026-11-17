import { hierarchy, tree } from "d3-hierarchy";

export interface TreeGraphNode { id: number; name: string; comment?: string; children: TreeGraphNode[] }
export interface ReverseTreeNode extends TreeGraphNode { sourcePath: string; sourceLine: number; children: ReverseTreeNode[] }

// Source line IDs distinguish nodes with identical names.
export function changeTreeNode(content: string, line: number, action: "edit" | "add" | "delete" | "comment" | "paste", value = ""): string {
  const roots = parseTreeGraph(content);
  const flatten = (nodes: TreeGraphNode[]): TreeGraphNode[] => nodes.flatMap(node => [node, ...flatten(node.children)]);
  const all = flatten(roots);
  const node = all.find(item => item.id === line - 1);
  if (!node) return content;
  const lines = content.split(/\r?\n/);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const indent = lines[node.id].match(/^[\t \uFEFF]*/)?.[0] ?? "";
  const descendants = flatten(node.children);
  const end = descendants.length ? descendants[descendants.length - 1].id + 1 : node.id + 1;
  if (action === "delete") lines.splice(node.id, end - node.id);
  else if (action === "paste") {
    const children = parseTreeGraph(value);
    if (!children.length) return content;
    const unit = indent.includes("\t") || lines.some(text => /^\t/.test(text)) ? "\t" : "  ";
    const childIndent = lines[node.children[0]?.id]?.match(/^[\t ]*/)?.[0] ?? indent.replace(/^\uFEFF/, "") + unit;
    const serialize = (items: TreeGraphNode[], prefix: string): string[] => items.flatMap(item => [
      `${prefix}${item.name}${item.comment ? ` // ${item.comment}` : ""}`,
      ...serialize(item.children, prefix + unit),
    ]);
    lines.splice(end, 0, ...serialize(children, childIndent));
  } else if (action === "add") {
    const name = value.trim();
    if (!name || /[\r\n]|\/\//.test(name)) return content;
    const childIndent = node.children.length ? lines[node.children[0].id].match(/^[\t ]*/)?.[0] : undefined;
    const unit = indent.includes("\t") || lines.some(text => /^\t/.test(text)) ? "\t" : "  ";
    lines.splice(end, 0, `${childIndent ?? indent.replace(/^\uFEFF/, "") + unit}${name}`);
  } else {
    const name = action === "edit" ? value.trim() : node.name;
    if (!name || /[\r\n]|\/\//.test(name)) return content;
    const comment = action === "comment" ? value.replace(/[\r\n]+/g, " ").trim() : node.comment;
    lines[node.id] = `${indent}${name}${comment ? ` // ${comment}` : ""}`;
  }
  return lines.join(newline);
}

export function getTreeSubtree(content: string, line: number): string {
  const find = (nodes: TreeGraphNode[]): TreeGraphNode | undefined => {
    for (const node of nodes) {
      if (node.id === line - 1) return node;
      const found = find(node.children);
      if (found) return found;
    }
  };
  const node = find(parseTreeGraph(content));
  const serialize = (item: TreeGraphNode, indent = ""): string =>
    `${indent}${item.name}${item.comment ? ` // ${item.comment}` : ""}` + item.children.map(child => `\n${serialize(child, indent + "  ")}`).join("");
  return node ? serialize(node) : "";
}

export function countTreeGraphNames(trees: { path: string; content: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { content } of trees) {
    const seen = new Set<string>();
    const visit = (nodes: TreeGraphNode[]) => nodes.forEach(node => { seen.add(node.name); visit(node.children); });
    visit(parseTreeGraph(content));
    seen.forEach(name => counts.set(name, (counts.get(name) ?? 0) + 1));
  }
  return counts;
}

export function buildReverseTree(name: string, trees: { path: string; content: string }[]): ReverseTreeNode {
  const root: ReverseTreeNode = { id: -1, name, children: [], sourcePath: "", sourceLine: 0 };
  for (const { path, content } of trees) {
    const visit = (nodes: TreeGraphNode[], ancestors: TreeGraphNode[]): void => {
      for (const node of nodes) {
        if (node.name === name) {
          if (!root.sourcePath) { root.sourcePath = path; root.sourceLine = node.id + 1; }
          let parent = root;
          for (const ancestor of [...ancestors].reverse()) {
            let child = parent.children.find(item => item.name === ancestor.name && item.sourcePath === path && item.sourceLine === ancestor.id + 1);
            if (!child) {
              child = { ...ancestor, children: [], sourcePath: path, sourceLine: ancestor.id + 1 };
              parent.children.push(child);
            }
            parent = child;
          }
          parent.children.push({ ...node, children: [], sourcePath: path, sourceLine: node.id + 1 });
        }
        visit(node.children, [...ancestors, node]);
      }
    };
    visit(parseTreeGraph(content), []);
  }
  return root;
}

export interface MindMapNode {
  node: TreeGraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  side: -1 | 0 | 1;
  parent?: number;
}

// Match the renderer's typography; conservatively estimate wrapping without a DOM.
function labelSize(node: TreeGraphNode, depth: number) {
  const fontSize = depth === 0 ? 22 : depth === 1 ? 16 : 13;
  const lineHeight = depth === 0 ? 30 : depth === 1 ? 24 : 20;
  const padding = depth === 0 ? 32 : 16;
  const units = Array.from(node.name).reduce((sum, char) => sum + (/[^\x00-\x7f]/.test(char) ? 1 : 0.65), 0);
  const textWidth = units * fontSize;
  const width = Math.min(240, Math.max(depth === 0 ? 88 : 40, Math.ceil(textWidth + padding)));
  return { width, height: Math.max(1, Math.ceil(textWidth / (width - padding))) * lineHeight + (depth === 0 ? 20 : 8) };
}

export function layoutTreeMindMap(roots: TreeGraphNode[], counts: ReadonlyMap<string, number> = new Map()): MindMapNode[] {
  const result: MindMapNode[] = [];
  let forestTop = 0;
  for (const root of roots) {
    const sizes = new Map<number, ReturnType<typeof labelSize>>();
    const weights = new Map<number, number>();
    const measure = (node: TreeGraphNode, depth: number): number => {
      const size = labelSize(node, depth);
      if ((counts.get(node.name) ?? 0) > 1) size.width += 32;
      sizes.set(node.id, size);
      const weight = Math.max(size.height + 16, node.children.reduce((sum, child) => sum + measure(child, depth + 1), 0));
      weights.set(node.id, weight);
      return weight;
    };
    measure(root, 0);
    const groups: [TreeGraphNode[], TreeGraphNode[]] = [[], []];
    const totals = [0, 0];
    root.children.forEach(child => {
      const index = totals[0] <= totals[1] ? 0 : 1;
      groups[index].push(child);
      totals[index] += weights.get(child.id)!;
    });
    const rootSize = sizes.get(root.id)!;
    const placed: MindMapNode[] = [{ node: root, x: 0, y: -rootSize.height / 2, ...rootSize, depth: 0, side: 0 }];
    groups.forEach((children, index) => {
      if (!children.length) return;
      const side = index === 0 ? 1 : -1;
      const branch = hierarchy({ ...root, children });
      // Separate entire depth columns, including cousins with different label widths.
      const widths: number[] = [];
      branch.each(item => {
        widths[item.depth] = Math.max(widths[item.depth] ?? 0, sizes.get(item.data.id)!.width);
      });
      const offsets = [0];
      for (let depth = 1; depth < widths.length; depth++) {
        offsets[depth] = offsets[depth - 1] + widths[depth - 1] + 54;
      }
      const layout = tree<TreeGraphNode>().nodeSize([1, 1]).separation((a, b) =>
        (sizes.get(a.data.id)!.height + sizes.get(b.data.id)!.height) / 2 + (a.parent === b.parent ? 12 : 24));
      const positioned = layout(branch);
      positioned.eachBefore(item => {
        if (!item.parent) return;
        const size = sizes.get(item.data.id)!;
        const x = side === 1 ? offsets[item.depth] : rootSize.width - offsets[item.depth] - size.width;
        placed.push({ node: item.data, x, y: item.x - positioned.x - size.height / 2,
          ...size, depth: item.depth, side, parent: item.parent.data.id });
      });
    });
    const minY = Math.min(...placed.map(item => item.y));
    const maxY = Math.max(...placed.map(item => item.y + item.height));
    placed.forEach(item => result.push({ ...item, y: item.y - minY + forestTop }));
    forestTop += maxY - minY + 64;
  }
  return result;
}

export function parseTreeGraph(content: string): TreeGraphNode[] {
  const roots: TreeGraphNode[] = [];
  const stack: { indent: number; node: TreeGraphNode }[] = [];
  content.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((line, id) => {
    if (!line.trim()) return;
    let indent = 0;
    for (const char of line.match(/^[\t ]*/)?.[0] ?? "") indent += char === "\t" ? 4 - indent % 4 : 1;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const raw = line.trim();
    const separator = raw.indexOf("//");
    const name = (separator >= 0 ? raw.slice(0, separator) : raw).trim();
    const comment = separator >= 0 ? raw.slice(separator + 2).trim() : undefined;
    if (!name) return;
    const node: TreeGraphNode = { id, name, ...(comment ? { comment } : {}), children: [] };
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ indent, node });
  });
  return roots;
}
