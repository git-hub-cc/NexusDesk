import React, { useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDroppable } from "@dnd-kit/core";
import { BrowserEditor } from "./BrowserEditor";
import { MarkdownEditor, VideoTabPreview } from "./MarkdownEditor";
import { ImageEditor } from "./ImageEditor";
import { HttpEditor } from "./HttpEditor";
import { isImage, isVideo } from "@/lib/assets";
import { MIRROR_HOME, useWorkspaceStore, type Tab } from "@/store/workspaceStore";

interface EditorGroupPanelProps {
  groupId: string;
}

function TextTabPanel({ tab, pane, active }: { tab: Tab; pane: "left" | "right"; active: boolean }) {
  const visited = useRef(false);
  if (active) visited.current = true;
  if (!visited.current) return null;

  // Retain the document and its viewport until the tab closes. Keeping its
  // layout also preserves scroll offsets when the cursor is elsewhere.
  return <div className="absolute inset-0"
    // Keep inactive editors mounted for cursor/undo state, but remove them
    // from painting so graph previews cannot bleed through the active tab.
    style={{ display: active ? "block" : "none", visibility: active ? "visible" : "hidden", pointerEvents: active ? "auto" : "none" }}
    aria-hidden={!active} inert={!active}>
    {/\.(http|rest)$/i.test(tab.path) && tab.diff === undefined && !tab.revision
      ? <HttpEditor tab={tab} pane={pane} active={active} />
      : <MarkdownEditor tabId={tab.id} pane={pane} active={active} />}
  </div>;
}

export const EditorGroupPanel: React.FC<EditorGroupPanelProps> = ({ groupId }) => {
  const pane = groupId === "right" ? "right" : "left";
  const setFocusedPane = useWorkspaceStore(state => state.setFocusedPane);
  const activeTabId = useWorkspaceStore(state => pane === "left" ? state.activeLeftTabId : state.activeRightTabId);
  const videoTabs = useWorkspaceStore(useShallow(state => (pane === "left" ? state.leftTabs : state.rightTabs).filter(tab => isVideo(tab.path) && tab.diff === undefined && !tab.revision)));
  const imageTabs = useWorkspaceStore(useShallow(state => (pane === "left" ? state.leftTabs : state.rightTabs).filter(tab => isImage(tab.path) && !/\.svg$/i.test(tab.path) && tab.diff === undefined && !tab.revision)));
  const browserTabs = useWorkspaceStore(useShallow(state => (pane === "left" ? state.leftTabs : state.rightTabs).filter(tab => tab.browser)));
  const textTabs = useWorkspaceStore(useShallow(state => (pane === "left" ? state.leftTabs : state.rightTabs).filter(tab =>
    !tab.browser && (tab.diff !== undefined || tab.revision || (!isVideo(tab.path) && (!isImage(tab.path) || /\.svg$/i.test(tab.path)))))));

  // 设置该区域为可放置区域 (Droppable)
  const { setNodeRef, isOver } = useDroppable({
    id: groupId,
    data: { type: "group", groupId },
  });


  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col h-full w-full relative ${isOver ? "bg-white/5" : ""}`}
      onClick={() => { setFocusedPane(pane); }}
    >
      <div className="flex-1 overflow-hidden relative" data-editor-mirror-host={pane}>
        {browserTabs.filter(tab => tab.browser?.url !== MIRROR_HOME).map(tab => <BrowserEditor key={tab.id} tab={tab} pane={pane} active={tab.id === activeTabId} />)}
        {videoTabs.map(tab => <VideoTabPreview key={tab.id} tab={tab} active={tab.id === activeTabId} />)}
        {imageTabs.map(tab => <div key={tab.id} className={`absolute inset-0 ${tab.id === activeTabId ? "" : "hidden"}`}>
          <ImageEditor path={tab.path} sourceUrl={tab.path.startsWith("android://") ? tab.content : undefined} />
        </div>)}
        {textTabs.map(tab => <TextTabPanel key={tab.id} tab={tab} pane={pane} active={tab.id === activeTabId} />)}
        {!activeTabId && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 bg-ide-bg">
            <div className="text-center">
              <div className="text-4xl mb-4">NexusDesk</div>
              <div className="text-sm">欢迎使用 NexusDesk... 请在左上角打开项目或页面。</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
