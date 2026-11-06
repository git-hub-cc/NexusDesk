import { useEffect } from "react";
import { isSnapshot } from "@/lib/snapshot";
import { listen } from "@tauri-apps/api/event";
import debounce from "lodash/debounce";
import { fsApi } from "@/lib/api";
import { isRecentlySavedPath, refreshOpenFiles, useWorkspaceStore } from "@/store/workspaceStore";

export function useWorkspaceWatcher() {
  useEffect(() => {
    if (isSnapshot) return;
    let disposed = false;
    let queue = Promise.resolve();
    const pending = new Map<string, Set<string>>();
    const flush = debounce(() => {
      const batches = [...pending];
      pending.clear();
      for (const [root, paths] of batches) {
        const payload = { root, paths: [...paths] };
        queue = queue.then(async () => {
          const state = useWorkspaceStore.getState();
          if (disposed || state.rootPath !== payload.root) return;
          const directories = new Set<string>([payload.root]);
          const walk = (nodes: any[]) => nodes.forEach(node => {
            if (!node.isLeaf && node.children?.length) { directories.add(node.id); walk(node.children); }
          });
          walk(state.fileTreeData);
          await Promise.all([...directories].map(path => state.loadDirectory(path, false, true)));
          await state.refreshTreeStatuses();
          await refreshOpenFiles(payload.paths);
          if (useWorkspaceStore.getState().rootPath !== payload.root) return;
          await fsApi.syncProjectIndex(payload.root);
          if (useWorkspaceStore.getState().rootPath === payload.root) await state.fetchLogicalTree();
        }).catch(console.error);
      }
    }, 300);
    const subscription = listen<{ root: string; paths: string[] }>("workspace-changed", ({ payload }) => {
      if (disposed || useWorkspaceStore.getState().rootPath !== payload.root) return;
      fsApi.invalidateTreeFiles(payload.paths);
      // Classify on arrival, before debounce/queued work can outlive the 1s window.
      // Autosave already updates the matching tabs' dirty/error state silently.
      const externalPaths = payload.paths.filter(path => !isRecentlySavedPath(path));
      if (payload.paths.length && !externalPaths.length) return;
      const paths = pending.get(payload.root) ?? new Set<string>();
      externalPaths.forEach(path => paths.add(path));
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
