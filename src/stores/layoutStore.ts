import { create } from "zustand";
import { readUI, writeUI } from "@/lib/uiPersistence";

interface LayoutState {
  leftSidebarVisible: boolean;
  bottomPanelVisible: boolean;
  bottomPanelTab: "git" | "terminal";
  rightSidebarVisible: boolean;
  leftSidebarWidth: number;
  bottomPanelHeight: number;
  bottomPanelWidth: "full" | "sidebar";
  rightSidebarWidth: number;
  editorSplitRatio: number;
  markdownSplitRatio: number;
  gitDiffSplitRatio: number;
  setRightSidebarWidth: (width: number) => void;
  setEditorSplitRatio: (ratio: number) => void;
  setMarkdownSplitRatio: (ratio: number | ((current: number) => number)) => void;
  setGitDiffSplitRatio: (ratio: number) => void;

  toggleLeftSidebar: () => void;
  openBottomPanel: (tab: "git" | "terminal") => void;
  setBottomPanelTab: (tab: "git" | "terminal") => void;
  toggleRightSidebar: () => void;
  setLeftSidebarWidth: (width: number) => void;
  setBottomPanelHeight: (height: number) => void;
  setBottomPanelWidth: (width: "full" | "sidebar") => void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  rightSidebarWidth: 18,
  editorSplitRatio: 50,
  markdownSplitRatio: 50,
  gitDiffSplitRatio: 50,
  setRightSidebarWidth: (rightSidebarWidth) => set({ rightSidebarWidth }),
  setEditorSplitRatio: (editorSplitRatio) => set({ editorSplitRatio }),
  setMarkdownSplitRatio: (ratio) => set(state => ({ markdownSplitRatio: typeof ratio === "function" ? ratio(state.markdownSplitRatio) : ratio })),
  setGitDiffSplitRatio: (gitDiffSplitRatio) => set({ gitDiffSplitRatio }),
  leftSidebarVisible: false,
  bottomPanelVisible: false,
  bottomPanelTab: "git",
  rightSidebarVisible: false,
  leftSidebarWidth: 20, // 百分比
  bottomPanelHeight: 25, // 百分比
  bottomPanelWidth: "full",

  toggleLeftSidebar: () => set((state) => ({ leftSidebarVisible: !state.leftSidebarVisible })),
  openBottomPanel: (tab) => set({ bottomPanelVisible: true, bottomPanelTab: tab }),
  setBottomPanelTab: (tab) => set({ bottomPanelTab: tab }),
  toggleRightSidebar: () => set((state) => ({ rightSidebarVisible: !state.rightSidebarVisible })),
  setLeftSidebarWidth: (width) => set({ leftSidebarWidth: width }),
  setBottomPanelHeight: (height) => set({ bottomPanelHeight: height }),
  setBottomPanelWidth: (width) => set({ bottomPanelWidth: width }),
}));

const defaults = Object.fromEntries(Object.entries(useLayoutStore.getState()).filter(([, value]) => typeof value !== "function"));
let layoutProject: string | null = null;
let restoring = false;
let layoutResizing = false;
let layoutChangedDuringResize = false;

export function setLayoutResizing(resizing: boolean) {
  if (layoutResizing === resizing) return;
  layoutResizing = resizing;
  if (layoutResizing || !layoutChangedDuringResize) return;
  layoutChangedDuringResize = false;
  const state = useLayoutStore.getState();
  if (layoutProject && !restoring) {
    writeUI(layoutProject, "layout", Object.fromEntries(Object.entries(state).filter(([, value]) => typeof value !== "function")));
  }
}
export function restoreProjectLayout(root: string) {
  const saved = readUI<Record<string, unknown>>(root, "layout");
  const values = { ...defaults };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = saved?.[key];
    if (typeof value !== typeof fallback) continue;
    if (typeof value === "number" && (!Number.isFinite(value) || value <= 0 || value >= 100)) continue;
    if (key === "bottomPanelTab" && value !== "git" && value !== "terminal") continue;
    if (key === "bottomPanelWidth" && value !== "full" && value !== "sidebar") continue;
    values[key] = value;
  }
  restoring = true;
  layoutProject = root;
  useLayoutStore.setState(values);
  restoring = false;
  return !!saved;
}
useLayoutStore.subscribe(state => {
  if (!layoutProject || restoring) return;
  if (layoutResizing) {
    layoutChangedDuringResize = true;
    return;
  }
  writeUI(layoutProject, "layout", Object.fromEntries(Object.entries(state).filter(([, value]) => typeof value !== "function")));
});
