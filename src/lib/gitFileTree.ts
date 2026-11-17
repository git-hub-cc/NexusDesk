export interface GitTreeNode {
  id: string;
  name: string;
  path: string;
  root?: boolean;
  children?: GitTreeNode[];
}

export function buildGitTree(paths: string[], rootName?: string): GitTreeNode[] {
  const root: GitTreeNode = { id: "git-project-root", name: rootName ?? "", path: "", root: true, children: [] };
  const directories = new Map<string, GitTreeNode>([["", root]]);
  for (const path of paths) {
    const parts = path.split("/");
    let parent = root;
    let currentPath = "";
    parts.forEach((name, index) => {
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      if (index === parts.length - 1) {
        parent.children!.push({ id: `file:${path}`, name, path });
      } else {
        let directory = directories.get(currentPath);
        if (!directory) {
          directory = { id: `dir:${currentPath}`, name, path: currentPath, children: [] };
          directories.set(currentPath, directory);
          parent.children!.push(directory);
        }
        parent = directory;
      }
    });
  }
  for (const directory of directories.values()) {
    directory.children!.sort((a, b) => Number(!a.children) - Number(!b.children) || a.name.localeCompare(b.name));
  }
  return rootName ? [root] : root.children!;
}

interface Counts { total: number; eligible: number; checked: number; pending: number }

export function summarizeGitTree(nodes: GitTreeNode[], fileCounts: (path: string) => Omit<Counts, "total">): Map<string, Counts> {
  const result = new Map<string, Counts>();
  function visit(node: GitTreeNode): Counts {
    const counts: Counts = node.children ? { total: 0, eligible: 0, checked: 0, pending: 0 } : { total: 1, ...fileCounts(node.path) };
    for (const child of node.children ?? []) {
      const nested = visit(child);
      counts.total += nested.total;
      counts.eligible += nested.eligible;
      counts.checked += nested.checked;
      counts.pending += nested.pending;
    }
    result.set(node.id, counts);
    return counts;
  }
  nodes.forEach(visit);
  return result;
}
