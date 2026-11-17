import { useEffect } from "react";
import { isSnapshot } from "@/lib/snapshot";
import { listen } from "@tauri-apps/api/event";
import debounce from "lodash/debounce";
import { fsApi, gitApi } from "@/lib/api";
import { refreshOpenFiles, useWorkspaceStore } from "@/stores/workspaceStore";

export function useWorkspaceWatcher() {
  useEffect(() => {
    if (isSnapshot) return;
    let disposed = false;
    let running = false;
    const pending = new Map<string, Set<string>>();
    const normalize = (path: string) => {
      const value = path.replace(/\\/g, "/").replace(/\/+$/, "");
      return /^(?:[a-z]:|\/\/)/i.test(value) ? value.toLowerCase() : value;
    };
    const drain = async () => {
      if (running) return;
      running = true;
      try {
        while (!disposed && pending.size) {
          const [root, changed] = pending.entries().next().value!;
          pending.delete(root);
          const state = useWorkspaceStore.getState();
          if (state.rootPath !== root) continue;
          const paths = [...changed];
          try {
            const externalPaths = await refreshOpenFiles(paths);
            if (disposed || useWorkspaceStore.getState().rootPath !== root) continue;
            if (paths.length && !externalPaths.length) continue;
            const affected = new Set(externalPaths.map(normalize));
            const parents = new Set([...affected].map(path => path.slice(0, path.lastIndexOf("/"))));
            const loaded = new Set<string>([root]);
            const walk = (nodes: any[]) => nodes.forEach(node => {
              if (!node.isLeaf && Array.isArray(node.children)) { loaded.add(node.id); walk(node.children); }
            });
            walk(state.fileTreeData);
            const directories = [...loaded].filter(directory => {
              let candidate = normalize(directory);
              if (!externalPaths.length || parents.has(candidate)) return true;
              while (candidate) {
                if (affected.has(candidate)) return true;
                const separator = candidate.lastIndexOf("/");
                if (separator < 0) break;
                candidate = candidate.slice(0, separator);
              }
              return false;
            });
            await Promise.all(directories.map(path => state.loadDirectory(path, false, true)));
            if (disposed || useWorkspaceStore.getState().rootPath !== root) continue;
            await fsApi.syncProjectIndex(root, externalPaths.length ? externalPaths : undefined);
            if (!disposed && useWorkspaceStore.getState().rootPath === root) await state.fetchLogicalTree();
          } catch (error) { console.error(error); }
        }
      } finally { running = false; }
    };
    const flush = debounce(() => { void drain(); }, 300, { maxWait: 1000 });
    const subscription = listen<{ root: string; paths: string[] }>("workspace-changed", ({ payload }) => {
      if (disposed || useWorkspaceStore.getState().rootPath !== payload.root) return;
      fsApi.invalidateTreeFiles(payload.paths);
      gitApi.invalidateStatus(payload.root);
      void useWorkspaceStore.getState().refreshTreeStatuses();
      const paths = pending.get(payload.root) ?? new Set<string>();
      payload.paths.forEach(path => paths.add(path));
      pending.set(payload.root, paths);
      flush();
    });

    const logicalTreeSub = listen("logical-tree-updated", () => {
      if (disposed) return;
      void useWorkspaceStore.getState().fetchLogicalTree();
    });

    const onFocus = () => { 
      void useWorkspaceStore.getState().refreshTreeStatuses(); 
      void useWorkspaceStore.getState().fetchLogicalTree();
    };
    window.addEventListener("focus", onFocus);
    return () => { 
      disposed = true; 
      flush.cancel();
      pending.clear();
      window.removeEventListener("focus", onFocus); 
      void subscription.then(unlisten => unlisten()); 
      void logicalTreeSub.then(unlisten => unlisten());
    };
  }, []);
}
