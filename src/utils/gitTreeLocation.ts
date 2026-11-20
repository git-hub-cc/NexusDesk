import { isWithinPath, normalizePath, samePath } from "./paths";

export type TreeLocationEntry = { id: string; isLeaf: boolean };

export async function findGitTreeLocation(
  root: string,
  path: string,
  readDirectory: (path: string) => Promise<TreeLocationEntry[] | undefined>,
  isCurrent: () => boolean,
) {
  if (!isWithinPath(path, root)) return { kind: "outside" } as const;
  const base = normalizePath(root).replace(/\/$/, "");
  const parts = normalizePath(path).slice(base.length + 1).split("/").filter(Boolean);
  let directory: TreeLocationEntry | undefined;
  let current = root;
  let prefix = base;
  for (const [index, part] of parts.entries()) {
    prefix += `/${part}`;
    const entries = await readDirectory(current);
    if (!isCurrent()) return { kind: "cancelled" } as const;
    if (!entries) return { kind: "unavailable" } as const;
    const entry = entries.find(node => samePath(node.id, prefix));
    const last = index === parts.length - 1;
    if (entry?.isLeaf && last) return { kind: "file", entry, parent: current } as const;
    if (!entry || entry.isLeaf || last) break;
    directory = entry;
    current = entry.id;
  }
  return { kind: "missing", directory } as const;
}
