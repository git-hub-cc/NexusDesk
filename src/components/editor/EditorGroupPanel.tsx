import React, { useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDroppable } from "@dnd-kit/core";
import { BrowserEditor } from "./BrowserEditor";
import { MarkdownEditor, VideoTabPreview } from "./MarkdownEditor";
import { ImageEditor } from "./ImageEditor";
import { HttpEditor } from "./HttpEditor";
import { DocumentPreview } from "./DocumentPreview";
import { isImage, isVideo, isPreviewDocument } from "@/lib/assets";
import { MIRROR_HOME, isFileConflict, resolveFileConflict, useWorkspaceStore, type Tab } from "@/stores/workspaceStore";
import { confirmAction, showError } from "@/lib/dialogs";

function FileConflictNotice({ tab }: { tab: Tab }) {
  const [busy, setBusy] = useState(false);
  if (!isFileConflict(tab.saveError) || tab.revision || tab.diffReadOnly || tab.diffStaged) return null;
  const resolve = async (action: "compare" | "reload" | "overwrite") => {
    setBusy(true);
    try {
      if (action !== "compare" && !await confirmAction(action === "reload"
        ? "载入磁盘版本将丢弃当前未保存的编辑。请先查看差异并保留需要的内容。"
        : "将使用当前编辑内容覆盖磁盘版本。覆盖前会保留磁盘版本的本地历史。", {
        title: action === "reload" ? "载入磁盘版本" : "覆盖保存",
        confirmLabel: action === "reload" ? "载入磁盘版本" : "覆盖保存", cancelLabel: "取消",
      })) return;
      await resolveFileConflict(tab.path, action);
    } catch (error) { showError(String(error)); }
    finally { setBusy(false); }
  };
  return <div role="alert" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-ide-panel-border bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
    <span className="flex-1">文件已被外部修改，自动保存已暂停。当前编辑内容已保留。</span>
    <button disabled={busy} className="disabled:opacity-40" onClick={() => void resolve("compare")}>查看差异</button>
    <button disabled={busy} className="disabled:opacity-40" onClick={() => void resolve("reload")}>载入磁盘版本</button>
    <button disabled={busy} className="disabled:opacity-40" onClick={() => void resolve("overwrite")}>覆盖保存</button>
  </div>;
}

interface EditorGroupPanelProps {
  groupId: string;
}

function TextTabPanel({ tab, pane, active }: { tab: Tab; pane: "left" | "right"; active: boolean }) {
  const visited = useRef(false);
  if (active) visited.current = true;
  if (!visited.current) return null;

  // Retain the document and its viewport until the tab closes. Keeping its
  // layout also preserves scroll offsets when the cursor is elsewhere.
  return <div className="absolute inset-0 flex flex-col"
    // Keep inactive editors mounted for cursor/undo state, but remove them
    // from painting so graph previews cannot bleed through the active tab.
    style={{ display: active ? "flex" : "none", visibility: active ? "visible" : "hidden", pointerEvents: active ? "auto" : "none" }}
    aria-hidden={!active} inert={!active}>
    <FileConflictNotice tab={tab} />
    <div className="relative min-h-0 flex-1">
      {isPreviewDocument(tab.path) && tab.diff === undefined && !tab.revision
        ? <DocumentPreview path={tab.path} active={active} />
        : /\.(http|rest)$/i.test(tab.path) && tab.diff === undefined && !tab.revision
        ? <HttpEditor tab={tab} pane={pane} active={active} />
        : <MarkdownEditor tabId={tab.id} pane={pane} active={active} />}
    </div>
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
