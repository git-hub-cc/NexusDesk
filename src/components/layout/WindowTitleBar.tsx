import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EditorTabs, EditorTabList } from "@/components/editor/EditorTabs";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useLayoutStore } from "@/store/layoutStore";
import { TitleBar } from "./TitleBar";

export function WindowTitleBar({ editorLayout }: { editorLayout: { left: number; split: number } | null }) {
  const isSplitMode = useWorkspaceStore(state => state.isSplitMode);
  const leftSidebarVisible = useLayoutStore(state => state.leftSidebarVisible);
  const leftSidebarWidth = useLayoutStore(state => state.leftSidebarWidth);
  const appWindow = getCurrentWindow();

  return (
    <header className="window-title-bar flex h-9 shrink-0 items-center border-b border-ide-panel-border bg-ide-tab-bg select-none">
      <div className="flex h-full shrink-0 items-center" style={{ width: editorLayout?.left ?? (leftSidebarVisible ? `calc(44px + max(260px, ${leftSidebarWidth}vw - ${44 * leftSidebarWidth / 100}px))` : 44) }}>
        <TitleBar expanded={leftSidebarVisible} />
      </div>
      <div className="flex min-w-0 flex-1">
        <div className="flex min-w-0" style={isSplitMode && editorLayout ? { width: editorLayout.split - editorLayout.left, flexShrink: 0 } : { flex: 1 }}>
          <div className="min-w-0 flex-1"><EditorTabs pane="left" /></div>
          {isSplitMode && <div className="shrink-0 no-drag-region"><EditorTabList pane="left" /></div>}
        </div>
        {isSplitMode && <div className="min-w-0 flex-1 border-l border-ide-panel-border"><EditorTabs pane="right" /></div>}
      </div>
      <div className="flex h-full shrink-0 no-drag-region">
        <EditorTabList pane={isSplitMode ? "right" : "left"} />
        <button type="button" className="window-control" aria-label="最小化窗口" onClick={() => void appWindow.minimize()}><Minus size={16} /></button>
        <button type="button" className="window-control" aria-label="最大化或还原窗口" onClick={() => void appWindow.toggleMaximize()}><Square size={14} /></button>
        <button type="button" className="window-control window-control-close" aria-label="关闭窗口" onClick={() => void appWindow.close()}><X size={16} /></button>
      </div>
    </header>
  );
}
