export function normalizePath(path: string): string {
  if (path.startsWith("sftp://")) return path.replace(/\/+$/, "");
  const value = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return value || (path.startsWith("/") ? "/" : "");
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
