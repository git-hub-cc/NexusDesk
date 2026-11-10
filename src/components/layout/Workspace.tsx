import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Cloud, GitBranch, Mic, Package, X } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { DndContext, PointerSensor, useSensor, useSensors, DragEndEvent, DragStartEvent, closestCenter, DragOverlay } from "@dnd-kit/core";
import { setLayoutResizing, useLayoutStore } from "@/store/layoutStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { WindowTitleBar } from "./WindowTitleBar";
import { ActivityBar } from "./ActivityBar";
import { Sidebar } from "./Sidebar";
import { BottomPanel } from "./BottomPanel";
import { TabUI } from "@/components/editor/EditorTabs";
import { AndroidMirrorWorkspace } from "@/components/editor/AndroidMirrorWorkspace";
import { EditorGroupPanel } from "@/components/editor/EditorGroupPanel";
import { RelationalView } from "@/components/relations/RelationalView";
import { GitSettings } from "./GitSettings";
import { SpeechRecognitionSettings } from "./SpeechRecognitionSettings";
import { SoftwareSettings } from "./SoftwareSettings";
import { CodexSettings } from "./CodexSettings";
import { NavigationSyncSettings } from "@/components/navigation/NavigationSyncSettings";
import openAiIcon from "@/assets/openai.svg";
import { sidebarMaxSize, workspacePanelMinSize } from "@/lib/workspacePanelSizing";

export const Workspace: React.FC = () => {
  const rightSidebarWidth = useLayoutStore(state => state.rightSidebarWidth);
  const setRightSidebarWidth = useLayoutStore(state => state.setRightSidebarWidth);
  const editorSplitRatio = useLayoutStore(state => state.editorSplitRatio);
  const setEditorSplitRatio = useLayoutStore(state => state.setEditorSplitRatio);
  const leftSidebarVisible = useLayoutStore(state => state.leftSidebarVisible);
  const rightSidebarVisible = useLayoutStore(state => state.rightSidebarVisible);
  const bottomPanelVisible = useLayoutStore(state => state.bottomPanelVisible);
  const bottomPanelHeight = useLayoutStore(state => state.bottomPanelHeight);
  const bottomPanelWidth = useLayoutStore(state => state.bottomPanelWidth);
  const bottomPanelAtSidebar = bottomPanelWidth === "sidebar" && leftSidebarVisible;
  const setBottomPanelHeight = useLayoutStore(state => state.setBottomPanelHeight);
  const leftSidebarWidth = useLayoutStore(state => state.leftSidebarWidth);
  const setLeftSidebarWidth = useLayoutStore(state => state.setLeftSidebarWidth);
  const pendingPanelSizes = useRef<Partial<Record<"leftSidebarWidth" | "rightSidebarWidth" | "editorSplitRatio" | "bottomPanelHeight", number>>>({});
  const panelDraggingRef = useRef(false);
  const tabLayoutUpdater = useRef<(() => void) | null>(null);
  const updatePanelSize = (key: "leftSidebarWidth" | "rightSidebarWidth" | "editorSplitRatio" | "bottomPanelHeight", value: number, update: (value: number) => void) => {
    workspaceContainer.current?.style.setProperty(`--${key}`, `${value}%`);
    if (panelDraggingRef.current) pendingPanelSizes.current[key] = value;
    else update(value);
  };
  const onPanelDragging = (dragging: boolean) => {
    if (panelDraggingRef.current === dragging) return;
    window.dispatchEvent(new CustomEvent("terminal-panel-drag", { detail: dragging }));
    if (dragging) {
      panelDraggingRef.current = true;
      setLayoutResizing(true);
      workspaceContainer.current?.setAttribute("data-panel-dragging", "true");
      return;
    }
    const sizes = pendingPanelSizes.current;
    pendingPanelSizes.current = {};
    if (sizes.leftSidebarWidth !== undefined) setLeftSidebarWidth(sizes.leftSidebarWidth);
    if (sizes.rightSidebarWidth !== undefined) setRightSidebarWidth(sizes.rightSidebarWidth);
    if (sizes.editorSplitRatio !== undefined) setEditorSplitRatio(sizes.editorSplitRatio);
    if (sizes.bottomPanelHeight !== undefined) setBottomPanelHeight(sizes.bottomPanelHeight);
    panelDraggingRef.current = false;
    setLayoutResizing(false);
    workspaceContainer.current?.removeAttribute("data-panel-dragging");
    tabLayoutUpdater.current?.();
  };
  useEffect(() => () => onPanelDragging(false), []);
  const horizontalContainer = useRef<HTMLDivElement>(null);
  const panelContainer = useRef<HTMLDivElement>(null);
  const sidebarContainer = useRef<HTMLDivElement>(null);
  const bottomContainer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = panelContainer.current;
    const sidebar = sidebarContainer.current;
    const bottom = bottomContainer.current;
    if (!container) return;
    // 使用实际像素同步占位和宽度，让文件树拖动时底部面板保持对齐。
    const update = () => {
      const height = bottom?.getBoundingClientRect().height ?? 0;
      container.style.setProperty("--bottom-panel-height", `${height}px`);
      container.style.setProperty("--bottom-panel-width", `${sidebar?.getBoundingClientRect().width ?? container.clientWidth * leftSidebarWidth / 100}px`);
    };
    const observer = new ResizeObserver(update);
    observer.observe(container);
    if (sidebar) observer.observe(sidebar);
    if (bottom) observer.observe(bottom);
    update();
    return () => observer.disconnect();
  }, [leftSidebarVisible, bottomPanelVisible, leftSidebarWidth]);
  const workspaceContainer = useRef<HTMLDivElement>(null);
  const leftEditorContainer = useRef<HTMLDivElement>(null);
  const rightEditorContainer = useRef<HTMLDivElement>(null);
  const [tabLayout, setTabLayout] = useState<{ left: number; split: number } | null>(null);
  const isSplitMode = useWorkspaceStore(state => state.isSplitMode);
  useLayoutEffect(() => {
    const workspace = workspaceContainer.current;
    const left = leftEditorContainer.current;
    const group = horizontalContainer.current?.firstElementChild;
    if (!workspace || !left || !group) return;
    const updateTabLayout = () => {
      if (panelDraggingRef.current) return;
      const origin = workspace.getBoundingClientRect().left;
      const leftEdge = left.getBoundingClientRect().left - origin;
      const splitEdge = rightEditorContainer.current?.getBoundingClientRect().left;
      const split = splitEdge === undefined ? 0 : splitEdge - origin;
      setTabLayout(previous => previous?.left === leftEdge && previous.split === split
        ? previous : { left: leftEdge, split });
    };
    tabLayoutUpdater.current = updateTabLayout;
    updateTabLayout();
    const observer = new ResizeObserver(updateTabLayout);
    observer.observe(workspace);
    observer.observe(left);
    // Observe the outer panels too: resizing a sidebar also moves the editors.
    Array.from(group.children).forEach(child => observer.observe(child));
    return () => { observer.disconnect(); if (tabLayoutUpdater.current === updateTabLayout) tabLayoutUpdater.current = null; };
  }, [isSplitMode, leftSidebarVisible, rightSidebarVisible]);
  const [horizontalMinSize, setHorizontalMinSize] = useState(0);
  useLayoutEffect(() => {
    const group = horizontalContainer.current?.firstElementChild;
    if (!(group instanceof HTMLElement)) return;
    const updateMinimum = () => {
      const handleWidth = Array.from(group.children)
        .filter(child => child.hasAttribute("data-panel-resize-handle-id"))
        .reduce((width, child) => width + child.getBoundingClientRect().width, 0);
      // Minimized/hidden windows can report empty bounds. Keep the last valid
      // constraints so the splitter does not redistribute and persist the widths.
      if (group.clientWidth <= handleWidth || group.clientHeight <= 0) return;
      const panelCount = 1 + Number(leftSidebarVisible) + Number(rightSidebarVisible);
      setHorizontalMinSize(workspacePanelMinSize(group.clientWidth, handleWidth, panelCount));
    };
    updateMinimum();
    const observer = new ResizeObserver(updateMinimum);
    observer.observe(group);
    return () => observer.disconnect();
  }, [leftSidebarVisible, rightSidebarVisible]);
  const horizontalPanelMinimum = { minSize: horizontalMinSize };
  const leftEditorPanel = useRef<ImperativePanelHandle>(null);
  useLayoutEffect(() => {
    if (isSplitMode) leftEditorPanel.current?.resize(editorSplitRatio);
  }, [isSplitMode]);
  const activeLeftTabId = useWorkspaceStore(state => state.activeLeftTabId);
  const activeRightTabId = useWorkspaceStore(state => state.activeRightTabId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"git" | "speech" | "software" | "codex" | "navigation">("git");
  useEffect(() => {
    if (activeLeftTabId || activeRightTabId) setSettingsOpen(false);
  }, [activeLeftTabId, activeRightTabId]);

  const [activeDragTab, setActiveDragTab] = useState<{ tab: any; pane: "left" | "right" } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    if (active.data.current?.type === "tab") {
      setActiveDragTab({
        tab: (active.data.current.pane === "left" ? useWorkspaceStore.getState().leftTabs : useWorkspaceStore.getState().rightTabs).find(tab => tab.id === active.data.current?.tab.id) ?? active.data.current.tab,
        pane: active.data.current.pane as "left" | "right",
      });
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragTab(null);
    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    if (!activeData) return;

    const activeId = activeData.tab.id;
    const sourcePane = activeData.pane as "left" | "right";
    let targetPane = sourcePane;
    let overId: string | null = null;

    if (overData?.type === "tab") {
      targetPane = overData.pane as "left" | "right";
      overId = overData.tab.id;
    } else if (overData?.type === "tab-container") {
      targetPane = overData.pane as "left" | "right";
    }

    const { leftTabs, rightTabs, reorderTabs, moveTabAcrossPanes } = useWorkspaceStore.getState();

    if (sourcePane === targetPane) {
      if (overId && activeId !== overId) {
        const tabs = sourcePane === "left" ? leftTabs : rightTabs;
        if (tabs.find(tab => tab.id === overId)?.isPinned) return;
        const oldIndex = tabs.findIndex(t => t.id === activeId);
        const newIndex = tabs.findIndex(t => t.id === overId);
        if (oldIndex !== -1 && newIndex !== -1) {
          reorderTabs(sourcePane, oldIndex, newIndex);
        }
      }
    } else {
      const targetTabs = targetPane === "left" ? leftTabs : rightTabs;
      let newIndex = targetTabs.length;
      if (overId) {
        newIndex = targetTabs.findIndex(t => t.id === overId);
        if (newIndex === -1) newIndex = targetTabs.length;
      }
      moveTabAcrossPanes(activeId, sourcePane, targetPane, newIndex);
    }
  };

  const handleDragCancel = () => {
    setActiveDragTab(null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
      <div ref={workspaceContainer} className="flex h-full min-h-0 flex-col">
        <WindowTitleBar editorLayout={tabLayout} />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ActivityBar settingsOpen={settingsOpen} onLeaveSettings={() => setSettingsOpen(false)} />
          <div ref={panelContainer} className="relative min-w-0 flex-1 overflow-hidden">
              <div ref={horizontalContainer} className="h-full min-w-0" style={{ paddingBottom: bottomPanelVisible && !bottomPanelAtSidebar ? "var(--bottom-panel-height)" : 0 }}>
                <PanelGroup direction="horizontal" className="h-full w-full">
                  {leftSidebarVisible && (
                    <>
                      <Panel
                        id="file-tree"
                        order={1}
                        defaultSize={leftSidebarWidth || 20}
                        {...horizontalPanelMinimum}
                        maxSize={sidebarMaxSize}
                        onResize={size => updatePanelSize("leftSidebarWidth", size, setLeftSidebarWidth)}
                        className="bg-ide-panel-bg"
                      >
                        <div ref={sidebarContainer} className="h-full min-w-0" style={{ paddingBottom: bottomPanelVisible && bottomPanelAtSidebar ? "var(--bottom-panel-height)" : 0 }}><Sidebar /></div>
                      </Panel>
                      <PanelResizeHandle onDragging={onPanelDragging} className="ide-resize-handle ide-resize-handle-x" />
                    </>
                  )}

                  <Panel id="editor-area" order={2} {...horizontalPanelMinimum} className="flex flex-col bg-ide-bg">
                    <PanelGroup direction="horizontal">
                        {/* Keep the left group mounted when opening or closing a split. */}
                        {/* 左侧编辑器组 */}
                        <Panel key="left" ref={leftEditorPanel} id="left-editor" order={1} defaultSize={isSplitMode ? editorSplitRatio : 100} onResize={size => { if (isSplitMode) updatePanelSize("editorSplitRatio", size, setEditorSplitRatio); }} minSize={20} className="flex flex-col relative">
                          <div ref={leftEditorContainer} className="h-full min-w-0"><EditorGroupPanel groupId="left" /></div>
                        </Panel>

                        {isSplitMode && <PanelResizeHandle key="split-handle" onDragging={onPanelDragging} className="ide-resize-handle ide-resize-handle-x z-10" />}

                        {/* 右侧编辑器组 */}
                        {isSplitMode && <Panel key="right" id="right-editor" order={2} defaultSize={100 - editorSplitRatio} minSize={20} className="flex flex-col relative">
                          <div ref={rightEditorContainer} className="h-full min-w-0"><EditorGroupPanel groupId="right" /></div>
                        </Panel>}
                    </PanelGroup>
                  </Panel>
                  {rightSidebarVisible && (
                    <>
                      <PanelResizeHandle onDragging={onPanelDragging} className="ide-resize-handle ide-resize-handle-x" />
                      <Panel id="relations-sidebar" order={3} defaultSize={rightSidebarWidth} onResize={size => updatePanelSize("rightSidebarWidth", size, setRightSidebarWidth)} {...horizontalPanelMinimum} maxSize={sidebarMaxSize} className="bg-ide-panel-bg"><RelationalView /></Panel>
                    </>
                  )}
                </PanelGroup>

              </div>
            <div ref={bottomContainer} className="absolute bottom-0 left-0 z-20 flex flex-col bg-ide-panel-bg" style={{ display: bottomPanelVisible ? "flex" : "none", height: `${bottomPanelHeight}%`, width: bottomPanelAtSidebar ? "var(--bottom-panel-width)" : "100%" }}>
              <div role="separator" aria-label="调整底部面板高度" aria-orientation="horizontal" aria-valuemin={15} aria-valuemax={80} aria-valuenow={Math.round(bottomPanelHeight)} tabIndex={0} className="ide-resize-handle ide-resize-handle-y relative before:absolute before:-inset-y-1 before:inset-x-0" onKeyDown={event => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                setBottomPanelHeight(Math.min(80, Math.max(15, bottomPanelHeight + (event.key === "ArrowUp" ? 2 : -2))));
              }} onPointerDown={event => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                onPanelDragging(true);
              }} onPointerMove={event => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                const bounds = panelContainer.current?.getBoundingClientRect();
                if (!bounds || bounds.height <= 0) return;
                const height = Math.min(80, Math.max(15, (bounds.bottom - event.clientY) / bounds.height * 100));
                if (bottomContainer.current) bottomContainer.current.style.height = `${height}%`;
                updatePanelSize("bottomPanelHeight", height, setBottomPanelHeight);
              }} onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); onPanelDragging(false); }} onLostPointerCapture={() => onPanelDragging(false)} />
              <div className="min-h-0 flex-1 overflow-hidden"><BottomPanel /></div>
            </div>
          </div>
        </div>
      </div>
      <AndroidMirrorWorkspace />
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-glass settings-dialog" onKeyDown={event => event.stopPropagation()}>
          <header className="flex items-center justify-between border-b border-ide-panel-border px-5 py-4">
            <Dialog.Title className="text-lg font-semibold">设置</Dialog.Title>
            <Dialog.Close type="button" aria-label="关闭设置" className="rounded p-1 hover:bg-white/10"><X size={20} /></Dialog.Close>
          </header>
          <Dialog.Description className="sr-only">管理应用设置。</Dialog.Description>
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <nav className="shrink-0 border-b border-ide-panel-border bg-ide-panel-bg p-4 sm:w-48 sm:border-b-0 sm:border-r" aria-label="设置列表">
              <button type="button" onClick={() => setSettingsSection("git")} className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${settingsSection === "git" ? "bg-ide-selection text-ide-fg" : "text-gray-400 hover:bg-white/5 hover:text-ide-fg"}`} aria-current={settingsSection === "git" ? "page" : undefined}><GitBranch size={16} />版本控制</button>
              <button type="button" onClick={() => setSettingsSection("speech")} className={`mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${settingsSection === "speech" ? "bg-ide-selection text-ide-fg" : "text-gray-400 hover:bg-white/5 hover:text-ide-fg"}`} aria-current={settingsSection === "speech" ? "page" : undefined}><Mic size={16} />语音识别</button>
              <button type="button" onClick={() => setSettingsSection("software")} className={`mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${settingsSection === "software" ? "bg-ide-selection text-ide-fg" : "text-gray-400 hover:bg-white/5 hover:text-ide-fg"}`} aria-current={settingsSection === "software" ? "page" : undefined}><Package size={16} />软件管理</button>
              <button type="button" onClick={() => setSettingsSection("codex")} className={`mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${settingsSection === "codex" ? "bg-ide-selection text-ide-fg" : "text-gray-400 hover:bg-white/5 hover:text-ide-fg"}`} aria-current={settingsSection === "codex" ? "page" : undefined}><img src={openAiIcon} alt="" aria-hidden="true" className="h-4 w-4 shrink-0" />Codex</button>
              <button type="button" onClick={() => setSettingsSection("navigation")} className={`mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${settingsSection === "navigation" ? "bg-ide-selection text-ide-fg" : "text-gray-400 hover:bg-white/5 hover:text-ide-fg"}`} aria-current={settingsSection === "navigation" ? "page" : undefined}><Cloud size={16} />导航云同步</button>
            </nav>
            <div className="min-h-0 min-w-0 flex-1 overflow-auto">{settingsSection === "git" ? <GitSettings /> : settingsSection === "speech" ? <SpeechRecognitionSettings /> : settingsSection === "software" ? <SoftwareSettings /> : settingsSection === "codex" ? <CodexSettings /> : <NavigationSyncSettings />}</div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      </Dialog.Root>

      <DragOverlay dropAnimation={null}>
        {activeDragTab ? (
          <TabUI
            tab={activeDragTab.tab}
            pane={activeDragTab.pane}
            isActive={true}
            isOverlay={true}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};
