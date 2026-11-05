import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isRemotePath, uploadLocal } from "@/lib/remote";
import { fsApi } from "@/lib/api";
import { useWorkspaceStore } from "@/store/workspaceStore";

export function useFileDrop() {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let pending = Promise.resolve();

    const openPaths = async (paths: string[]) => {
      const failures: string[] = [];
      let openedDirectory = false;
      for (const path of new Set(paths)) {
        if (disposed) return;
        try {
          const root = useWorkspaceStore.getState().rootPath;
          if (isRemotePath(root)) {
            await uploadLocal(path, root);
            await useWorkspaceStore.getState().loadDirectory(root, false, true);
            continue;
          }
          if (await fsApi.isDirectory(path)) {
            if (openedDirectory) {
              failures.push(`${path}：一次只能打开一个目录`);
              continue;
            }
            if (!await useWorkspaceStore.getState().setProject(path)) {
              throw new Error("无法打开项目目录");
            }
            openedDirectory = true;
            useWorkspaceStore.getState().setSidebarMode("physical");
          } else {
            // Reuse an open buffer so dropping a file cannot replace unsaved edits.
            const state = useWorkspaceStore.getState();
            const existing = [...state.leftTabs, ...state.rightTabs].find(tab => tab.path === path);
            const content = existing ? existing.content : await fsApi.readFile(path);
            if (disposed) return;
            useWorkspaceStore.getState().openTab(existing ?? {
              id: path,
              path,
              title: path.split(/[/\\]/).pop() || path,
              content,
              isDirty: false,
            });
          }
        } catch (cause) {
          failures.push(`${path}：${String(cause)}`);
        }
      }
      if (!disposed) setError(failures.length ? failures.join("\n") : null);
    };

    getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (disposed) return;
      if (payload.type === "enter" || payload.type === "over" || payload.type === "drop") {
        const target = document.elementFromPoint(payload.position.x / window.devicePixelRatio, payload.position.y / window.devicePixelRatio);
        if (target?.closest("[data-graph-root]")) {
          setIsDragging(false);
          if (payload.type === "drop" && useWorkspaceStore.getState().rootPath) {
            window.dispatchEvent(new CustomEvent("nexusdesk-graph-drop", { detail: {
              category: target.closest<HTMLElement>("[data-graph-category]")?.dataset.graphCategory,
              paths: payload.paths,
            } }));
          }
          return;
        }
      }
      setIsDragging(payload.type === "enter" || payload.type === "over");
      if (payload.type === "drop") {
        setError(null);
        pending = pending.then(() => openPaths(payload.paths));
      }
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(cause => {
      if (!disposed) setError(`无法启用文件拖拽：${String(cause)}`);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return { isDragging, error, dismissError: () => setError(null) };
}
