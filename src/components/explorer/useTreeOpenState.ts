import { useEffect, type RefObject } from "react";
import { useWorkspaceStore } from "@/store/workspaceStore";

const emptyOpenState: Record<string, boolean> = {};

export function useTreeOpenState(
  treeRef: RefObject<any>,
  rootPath: string | null,
  mode: "physical" | "logical",
  data: any[],
) {
  const projectKey = rootPath?.replace(/\\/g, "/").replace(/\/$/, "");
  const openState = useWorkspaceStore(state =>
    (projectKey && state.projectTreeOpenState[projectKey]?.[mode]) || emptyOpenState);
  const loadDirectory = useWorkspaceStore(state => state.loadDirectory);

  // Initial visibility alone does not load the children of lazy directories.
  // Each loaded level makes the next saved level available to this effect.
  useEffect(() => {
    if (!rootPath) return;
    const visit = (nodes: any[], category?: string) => {
      for (const node of nodes) {
        const id = category ? `${category}:${node.id}` : node.id;
        if (!openState[id] || node.missing || !node.children) continue;
        if (mode === "physical" || category) void loadDirectory(node.id, mode === "logical");
        visit(node.children, mode === "logical" ? category ?? node.id : undefined);
      }
    };
    visit(data);
  }, [rootPath, mode, data, openState, loadDirectory]);

  return {
    initialOpenState: openState,
    onToggle: (id: string) => {
      if (!rootPath || !treeRef.current) return;
      useWorkspaceStore.getState().setTreeNodeOpen(rootPath, mode, id, treeRef.current.isOpen(id));
    },
  };
}
