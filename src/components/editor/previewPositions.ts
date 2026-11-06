import { readUI, writeUI } from "@/lib/uiPersistence";
import { useWorkspaceStore } from "@/store/workspaceStore";
type PreviewPosition = { top: number; left: number };

function positionsForPane(pane: string) {
  return {
    get(id: string) {
      const root = useWorkspaceStore.getState().rootPath;
      if (!root) return undefined;
      const saved = readUI<PreviewPosition>(root, `preview:${pane}:${id}`);
      return saved && [saved.top, saved.left].every(value => Number.isFinite(value) && value >= 0) ? saved : undefined;
    },
    set(id: string, value: PreviewPosition) {
      const root = useWorkspaceStore.getState().rootPath;
      if (root) writeUI(root, `preview:${pane}:${id}`, value);
    },
  };
}

export const previewPositions = {
  left: positionsForPane("left"),
  right: positionsForPane("right"),
};
