export function displayPath(path: string): string {
  return normalizePath(path);
}

export function normalizePath(path: string): string {
  if (path.startsWith("sftp://")) return path.replace(/\/+$/, "");
  const value = path.replace(/\\/g, "/")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\/(?=[a-z]:\/)/i, "")
    .replace(/\/+$/, "");
  if (/^[a-z]:$/i.test(value) && /[/\\]$/.test(path)) return `${value}/`;
  return value || (path.startsWith("/") ? "/" : "");
}

export function pathName(path: string): string {
  const value = normalizePath(path);
  return value.split("/").pop() || value;
}

export function pathTitles(paths: readonly string[]): Map<string, string> {
  const unique = new Map(paths.map(path => [pathKey(path), normalizePath(path)]));
  const groups = new Map<string, { key: string; parts: string[]; keyParts: string[] }[]>();
  for (const [key, path] of unique) {
    const filename = pathName(key);
    const group = groups.get(filename) ?? [];
    group.push({ key, parts: path.split("/").reverse(), keyParts: key.split("/").reverse() });
    groups.set(filename, group);
  }
  const titles = new Map<string, string>();
  for (const group of groups.values()) {
    for (const entry of group) {
      let depth = 0;
      for (const other of group) {
        if (entry === other) continue;
        let common = 0;
        while (common < entry.parts.length && common < other.parts.length
          && entry.keyParts[common] === other.keyParts[common]) common++;
        depth = Math.max(depth, common);
      }
      const filename = entry.parts[0];
      titles.set(entry.key, depth >= entry.parts.length ? entry.parts.slice().reverse().join("/")
        : depth === 1 ? `${entry.parts[1]}/${filename}`
        : depth > 1 ? `${entry.parts[depth]}/../${filename}` : filename);
    }
  }
  return titles;
}

export function pathKey(path: string): string {
  const value = normalizePath(path);
  return /^(?:[a-z]:|\/\/)/i.test(value) ? value.toLowerCase() : value;
}

export function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

export function isWithinPath(path: string, root: string): boolean {
  const candidate = pathKey(path);
  const parent = pathKey(root);
  return candidate === parent || !!parent && candidate.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}
