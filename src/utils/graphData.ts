import type { GraphCategory } from "./api";
import { pathKey } from "./paths";
import { countTreeGraphNames } from "./treeGraph";

export interface GraphData {
  root: string | null;
  categories: GraphCategory[];
  trees: { path: string; content: string }[];
  counts: Map<string, number>;
  error: string;
}

export function createGraphDataResource(dependencies: {
  root: () => string | null;
  categories: () => Promise<GraphCategory[]>;
  content: (path: string) => string | undefined;
  read: (path: string) => Promise<string>;
}) {
  const empty = (root: string | null): GraphData => ({ root, categories: [], trees: [], counts: new Map(), error: "" });
  let snapshot = empty(null);
  let generation = 0;
  let pending: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (value: GraphData) => {
    snapshot = value;
    listeners.forEach(listener => listener());
  };
  const refresh = (): Promise<void> => {
    const root = dependencies.root();
    if (snapshot.root !== root) {
      generation++;
      pending = undefined;
      publish(empty(root));
    }
    if (!root) return Promise.resolve();
    if (pending) return pending;
    const token = generation;
    const current = () => generation === token && dependencies.root() === root;
    const request = (async () => {
      try {
        const categories = await dependencies.categories();
        if (!current()) return;
        const paths = new Map<string, string>();
        for (const category of categories) {
          const missing = new Set(category.missingFiles.map(pathKey));
          for (const path of category.files) if (!missing.has(pathKey(path))) paths.set(pathKey(path), path);
        }
        const files = [...paths.values()];
        const results = await Promise.allSettled(files.map(async path => ({
          path, content: dependencies.content(path) ?? await dependencies.read(path),
        })));
        if (!current()) return;
        const trees = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
        const errors = results.flatMap((result, index) => result.status === "rejected" ? [`${files[index]}: ${String(result.reason)}`] : []);
        publish({ root, categories, trees, counts: countTreeGraphNames(trees), error: errors.join("\n") });
      } catch (error) {
        if (current()) publish({ ...snapshot, error: String(error) });
      }
    })().finally(() => { if (pending === request) pending = undefined; });
    pending = request;
    return request;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    invalidate: () => { generation++; pending = undefined; },
  };
}
