import { useEffect, useRef } from "react";
import { useLayoutStore } from "@/store/layoutStore";
import { flushPendingWrites, useWorkspaceStore } from "@/store/workspaceStore";

export const useShortcuts = (openSearch: () => void, openRecent: () => void) => {
  const { toggleLeftSidebar } = useLayoutStore();
  const lastShiftPress = useRef<number>(0);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) {
        lastShiftPress.current = 0;
        return;
      }
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const mod = isMac ? e.metaKey : e.ctrlKey;

      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void flushPendingWrites().catch(console.error);
        return;
      }

      if (e.key === "Shift" && !e.repeat && !mod && !e.altKey) {
        const now = Date.now();
        if (now - lastShiftPress.current < 300) {
          e.preventDefault();
          openSearch();
          lastShiftPress.current = 0;
          return;
        }
        lastShiftPress.current = now;
      } else if (e.key !== "Shift") {
        lastShiftPress.current = 0;
      }

      if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearch();
        return;
      }

      if (e.altKey && !mod && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const state = useWorkspaceStore.getState();
        const tabs = state.focusedPane === "left" ? state.leftTabs : state.rightTabs;
        const activeId = state.focusedPane === "left" ? state.activeLeftTabId : state.activeRightTabId;
        
        if (tabs.length > 1 && activeId) {
          const currentIndex = tabs.findIndex(t => t.id === activeId);
          let nextIndex = e.key === "ArrowLeft" ? currentIndex - 1 : currentIndex + 1;
          if (nextIndex < 0) nextIndex = tabs.length - 1;
          if (nextIndex >= tabs.length) nextIndex = 0;
          
          state.setActiveTab(tabs[nextIndex].id, state.focusedPane);
        }
        return;
      }

      if (mod && e.altKey) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          useWorkspaceStore.getState().navigateHistory("back");
          return;
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          useWorkspaceStore.getState().navigateHistory("forward");
          return;
        }
      }

      if ((e.altKey || e.metaKey) && e.key === "1") {
        e.preventDefault();
        toggleLeftSidebar();
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        openRecent();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleLeftSidebar, openSearch, openRecent]);
};
