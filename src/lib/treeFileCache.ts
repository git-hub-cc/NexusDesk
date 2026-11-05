// mtime is the frontend read time; freshness is driven by save/watcher events,
// without a metadata round trip on every tab switch.
const entries = new Map<string, { mtime: number; content: string }>();
const pending = new Map<string, Promise<string>>();
const keyFor = (path: string) => path.startsWith("sftp://") ? path : path.replace(/\\/g, "/").toLowerCase();

export function readCachedTreeFile(path: string, read: (path: string) => Promise<string>): Promise<string> {
  const key = keyFor(path);
  const cached = entries.get(key);
  if (cached) return Promise.resolve(cached.content);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = read(path).then(content => {
    // Invalidation also detaches in-flight reads, which must not repopulate cache.
    if (pending.get(key) === request) entries.set(key, { mtime: Date.now(), content });
    return content;
  }).finally(() => {
    if (pending.get(key) === request) pending.delete(key);
  });
  pending.set(key, request);
  return request;
}

export function invalidateTreeFiles(paths: string[]) {
  if (!paths.length) { entries.clear(); pending.clear(); return; }
  for (const path of paths) {
    const key = keyFor(path).replace(/\/$/, "");
    // Directory changes cover deleted/renamed descendants as well.
    for (const candidate of new Set([...entries.keys(), ...pending.keys()])) {
      if (candidate === key || candidate.startsWith(`${key}/`)) {
        entries.delete(candidate);
        pending.delete(candidate);
      }
    }
  }
}
