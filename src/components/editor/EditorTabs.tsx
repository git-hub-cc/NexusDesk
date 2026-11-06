import { isImage } from "@/lib/assets";
import { shallow } from "zustand/vanilla/shallow";
import { useShallow } from "zustand/react/shallow";
import React, { useState, useEffect, useLayoutEffect, forwardRef, useRef } from "react";
import * as ContextMenu from "@/lib/nativeMenu";
import * as DropdownMenu from "@/lib/nativeDropdownMenu";
import { X, ChevronDown, Pin, ExternalLink, GitBranch, Clock, Globe, Compass, Music2, Video, Smartphone, MessageCircle } from "lucide-react";
import { BROWSER_HOME } from "./BrowserEditor";
import { MUSIC_HOME, VIDEO_HOME, CHAT_HOME, MIRROR_HOME, retryFileSave, useWorkspaceStore, type Tab } from "@/store/workspaceStore";
import { openContextMenuFromKeyboard } from "@/lib/contextMenu";
import { confirmAction } from "@/lib/dialogs";
import { setSpeechTarget } from "@/lib/speechTarget";
import { SortableContext, horizontalListSortingStrategy, useSortable, type SortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useDroppable } from "@dnd-kit/core";

interface EditorTabsProps {
  pane: "left" | "right";
}

const NewTabButtons = ({ pane }: EditorTabsProps) => {
  const open = (kind: "navigation" | "music" | "video" | "chat" | "mirror") => {
    const state = useWorkspaceStore.getState();
    state.setFocusedPane(pane);
    const root = state.rootPath ?? "";
    if (kind === "navigation") {
      state.openTab({ id: "browser:navigation", path: "browser:navigation", title: "导航", browser: { root, url: BROWSER_HOME } });
    } else if (kind === "mirror") {
      state.openTab({ id: MIRROR_HOME, path: MIRROR_HOME, title: "安卓投屏", browser: { root, url: MIRROR_HOME } });
    } else if (kind === "music") {
      state.openTab({ id: "browser:music", path: "browser:music", title: "音乐", browser: { root, url: MUSIC_HOME } });
    } else if (kind === "chat") {
      state.openTab({ id: "browser:chat", path: "browser:chat", title: "对话", browser: { root, url: CHAT_HOME } });
    } else {
      state.openTab({ id: "browser:video", path: "browser:video", title: "视频", browser: { root, url: VIDEO_HOME } });
    }
  };
  return (
    <div className="flex h-full shrink-0 items-center">
      <button type="button" aria-label="打开导航" title="导航" onClick={() => open("navigation")} className="flex h-9 shrink-0 items-center gap-1.5 px-2 text-xs text-gray-400 outline-none hover:bg-ide-tab-hover hover:text-white">
        <Compass size={14} />
      </button>
      <button type="button" aria-label="打开音乐" title="音乐" onClick={() => open("music")} className="flex h-9 shrink-0 items-center gap-1.5 px-2 text-xs text-gray-400 outline-none hover:bg-ide-tab-hover hover:text-white">
        <Music2 size={14} />
      </button>
      <button type="button" aria-label="打开视频" title="视频" onClick={() => open("video")} className="flex h-9 shrink-0 items-center gap-1.5 px-2 text-xs text-gray-400 outline-none hover:bg-ide-tab-hover hover:text-white">
        <Video size={14} />
      </button>
      <button type="button" aria-label="打开对话" title="对话" onClick={() => open("chat")} className="flex h-9 shrink-0 items-center gap-1.5 px-2 text-xs text-gray-400 outline-none hover:bg-ide-tab-hover hover:text-white">
        <MessageCircle size={14} />
      </button>
      <button type="button" aria-label="打开安卓投屏" title="安卓投屏" onClick={() => open("mirror")} className="flex h-9 shrink-0 items-center gap-1.5 px-2 text-xs text-gray-400 outline-none hover:bg-ide-tab-hover hover:text-white">
        <Smartphone size={14} />
      </button>
    </div>
  );
};

// Avoid flashing the pending indicator for normal, fast autosaves.
const SaveIndicator: React.FC<{ isDirty: boolean; error?: string; path: string }> = ({ isDirty, error, path }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isDirty) {
      setVisible(false);
      return;
    }

    const timer = window.setTimeout(() => setVisible(true), 300);
    return () => window.clearTimeout(timer);
  }, [isDirty]);

  return (
      <button type="button" disabled={!error} onClick={event => { event.stopPropagation(); retryFileSave(path); }} aria-label={error ? `保存失败：${error}` : isDirty ? "尚未保存" : "已保存"} className="flex w-2 shrink-0 items-center justify-center" title={error ? `保存失败：${error}` : isDirty ? "尚未保存" : "已保存"}>
        <span className={`w-2 h-2 rounded-full ${error ? "bg-red-500" : "bg-blue-400"} ${error || (isDirty && visible) ? "visible" : "invisible"}`} />
      </button>
  );
};

// 提取纯视觉组件，方便在 SortableTab 和 DragOverlay 中复用
export const TabUI = forwardRef<HTMLDivElement, {
  tab: any;
  pane: "left" | "right";
  isActive: boolean;
  isOverlay?: boolean;
  isDraggingPlaceholder?: boolean;
  onClose?: (e: React.MouseEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent<any>) => void;
  style?: React.CSSProperties;
} & React.HTMLAttributes<HTMLDivElement>>(({ tab, pane, isActive, isOverlay, isDraggingPlaceholder, onClose, onClick, onKeyDown, style, ...props }, ref) => {
  return (
      <div
          ref={ref}
          style={style}
          data-tab-id={tab.id}
          tabIndex={isOverlay ? -1 : 0}
          aria-label={(tab.isTemporary ?? !!tab.reverseTree) ? `${tab.title}（临时视图）` : tab.isExternal ? `${tab.title}（不属于当前项目）` : tab.title}
          onKeyDown={onKeyDown}
          onClick={onClick}
          className={`group flex items-center gap-2 px-3 min-w-[120px] max-w-[200px] h-9 border-r border-ide-panel-border text-sm select-none shrink-0 outline-none ${
              isOverlay ? "cursor-grabbing shadow-xl bg-ide-tab-active-bg text-white border-t-2 border-t-transparent opacity-90" :
                  isDraggingPlaceholder ? "opacity-20 bg-ide-tab-bg border-t-2 border-t-transparent" :
                  isActive ? `bg-ide-tab-active-bg text-white border-t-2 border-t-transparent ${tab.browser?.url === MIRROR_HOME ? "cursor-default" : tab.isPinned ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"}` :
                          `text-gray-400 hover:bg-ide-tab-hover border-t-2 border-t-transparent ${tab.browser?.url === MIRROR_HOME ? "cursor-default" : tab.isPinned ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"}`
          }`}
          {...props}
      >
        <span className="truncate flex-1 flex items-center gap-1" title={(tab.isTemporary ?? !!tab.reverseTree) ? "临时视图 · 反向生成树" : tab.isExternal ? `不属于当前项目\n${tab.path}` : tab.path}>
          {(tab.isVersionControl ?? (tab.diff !== undefined || !!tab.revision)) && <GitBranch size={12} aria-label="版本控制" className="shrink-0" />}
          {!(tab.isTemporary ?? !!tab.reverseTree) && tab.isExternal && <ExternalLink size={12} aria-hidden="true" className="shrink-0 text-amber-400" />}
          {(tab.isTemporary ?? !!tab.reverseTree) && <Clock size={12} aria-label="临时视图" className="shrink-0 text-sky-400" />}
          {tab.isBrowser && (tab.browser?.url === "nexusdesk:nav" ? <Compass size={12} className="shrink-0 text-sky-400" /> : tab.browser?.url === MUSIC_HOME ? <Music2 size={12} className="shrink-0 text-sky-400" /> : tab.browser?.url === MIRROR_HOME ? <Smartphone size={12} className="shrink-0 text-sky-400" /> : tab.browser?.url === VIDEO_HOME ? <Video size={12} className="shrink-0 text-sky-400" /> : tab.browser?.url === CHAT_HOME ? <MessageCircle size={12} className="shrink-0 text-sky-400" /> : <Globe size={12} className="shrink-0 text-sky-400" />)}
          <span className="truncate">{tab.browser?.url === MIRROR_HOME ? "安卓投屏" : tab.title}</span>
        </span>
        {tab.isPinned && <Pin size={12} className="shrink-0 text-gray-400 rotate-45" />}
        <SaveIndicator isDirty={!!tab.isDirty} error={tab.saveError} path={tab.path} />
        <button
            aria-label={`关闭 ${tab.title}`}
            onClick={onClose}
            className={`flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-white/15 hover:text-white active:bg-white/20 ${isActive || isOverlay ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        >
          <X size={14} />
        </button>
      </div>
  );
});
TabUI.displayName = "TabUI";

const SortableTab = ({ tab, pane, isActive, closeImages, tabs }: { tab: any, pane: "left" | "right", isActive: boolean, closeImages: any, tabs: any[] }) => {
  const { setActiveTab, closeTab, closeOtherTabs, closeLeftTabs, closeRightTabs, splitRight, closeSplit, toggleTabPin } = useWorkspaceStore(useShallow(state => ({ setActiveTab: state.setActiveTab, closeTab: state.closeTab, closeOtherTabs: state.closeOtherTabs, closeLeftTabs: state.closeLeftTabs, closeRightTabs: state.closeRightTabs, splitRight: state.splitRight, closeSplit: state.closeSplit, toggleTabPin: state.toggleTabPin })));
  const sortableId = `${pane}-${tab.id}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    data: { type: "tab", pane, tab },
    disabled: !!tab.isPinned,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
      <ContextMenu.Root key={tab.id}>
        <ContextMenu.Trigger asChild>
          <TabUI
              ref={setNodeRef}
              tab={tab}
              pane={pane}
              isActive={isActive}
              isDraggingPlaceholder={isDragging}
              style={style}
              {...attributes}
              {...listeners}
              onKeyDown={event => {
                openContextMenuFromKeyboard(event as any);
                if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  setActiveTab(tab.id, pane);
                }
              }}
              onClick={(e) => {
                e.stopPropagation();
                setActiveTab(tab.id, pane);
              }}
              onClose={(e) => {
                e.stopPropagation();
                void closeImages([tab.id], () => closeTab(tab.id, pane));
              }}
          />
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content aria-label="标签页操作" collisionPadding={8} className="ide-menu w-48 text-sm" onClick={event => event.stopPropagation()}>
            <ContextMenu.Item className="ide-menu-item" onSelect={() => toggleTabPin(tab.id, pane)}>{tab.isPinned ? "取消固定" : "固定"}</ContextMenu.Item>
            <ContextMenu.Separator className="h-px bg-[#4b5054] my-1 mx-2" />
            <ContextMenu.Item className="ide-menu-item" onSelect={() => void closeImages(tabs.filter(t => t.id !== tab.id && !t.isPinned).map(t => t.id), () => closeOtherTabs(tab.id, pane))}>关闭其他</ContextMenu.Item>
            <ContextMenu.Item className="ide-menu-item" onSelect={() => void closeImages(tabs.slice(0, tabs.indexOf(tab)).filter(t => !t.isPinned).map(t => t.id), () => closeLeftTabs(tab.id, pane))}>关闭左侧</ContextMenu.Item>
            <ContextMenu.Item className="ide-menu-item" onSelect={() => void closeImages(tabs.slice(tabs.indexOf(tab) + 1).filter(t => !t.isPinned).map(t => t.id), () => closeRightTabs(tab.id, pane))}>关闭右侧</ContextMenu.Item>
            <ContextMenu.Separator className="h-px bg-[#4b5054] my-1 mx-2" />
            {pane === "left" ? (
                <ContextMenu.Item className="ide-menu-item" onSelect={() => splitRight(tab.id, pane)}>向右拆分</ContextMenu.Item>
            ) : (
                <ContextMenu.Item className="ide-menu-item" onSelect={() => void closeImages(tabs.map(t => t.id), closeSplit)}>关闭拆分</ContextMenu.Item>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
  );
};

const getEditorTabSortingStrategy = (pane: EditorTabsProps["pane"]): SortingStrategy => args => {
  const tabs = pane === "left"
    ? useWorkspaceStore.getState().leftTabs
    : useWorkspaceStore.getState().rightTabs;
  const pinnedCount = tabs.filter(tab => tab.isPinned).length;
  return args.index < pinnedCount ? null : horizontalListSortingStrategy(args);
};

function useTabMetadata(pane: EditorTabsProps["pane"]) {
  // Subscribe only to metadata displayed by the tab bar, never document content.
  const selectTabs = React.useMemo(() => {
    let previous: (Pick<Tab, "id" | "path" | "title" | "isDirty" | "saveError" | "isPinned" | "isExternal" | "browser"> & { isBrowser: boolean; isVersionControl: boolean; isTemporary: boolean })[] = [];
    return (state: ReturnType<typeof useWorkspaceStore.getState>) => {
      previous = (pane === "left" ? state.leftTabs : state.rightTabs).map(tab => {
        const { id, path, title, isDirty, saveError, isPinned, isExternal, browser } = tab;
        const metadata = { id, path, title, isDirty, saveError, isPinned, isExternal, browser, isBrowser: !!tab.browser, isTemporary: !!tab.reverseTree, isVersionControl: tab.diff !== undefined || !!tab.revision };
        const old = previous.find(item => item.id === id);
        return old && shallow(old, metadata) ? old : metadata;
      });
      return previous;
    };
  }, [pane]);
  return useWorkspaceStore(useShallow(selectTabs));
}

export const EditorTabs: React.FC<EditorTabsProps> = ({ pane }) => {
  const tabs = useTabMetadata(pane);
  const sortingStrategy = React.useMemo(() => getEditorTabSortingStrategy(pane), [pane]);
  const activeTabId = useWorkspaceStore(state => pane === "left" ? state.activeLeftTabId : state.activeRightTabId);
  const isFocused = useWorkspaceStore(state => state.focusedPane === pane);
  const setFocusedPane = useWorkspaceStore(state => state.setFocusedPane);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const closeImages = async (ids: string[], action: () => void) => {
    const state = useWorkspaceStore.getState();
    const candidates = (pane === "left" ? state.leftTabs : state.rightTabs).filter(tab => ids.includes(tab.id) && isImage(tab.path) && tab.isDirty && !tab.revision && tab.diff === undefined);
    if (candidates.length && !await confirmAction("图片有尚未保存的修改。确定放弃修改并关闭吗？", { title: "未保存的图片", confirmLabel: "放弃修改", cancelLabel: "继续编辑" })) return;
    action();
  };

  const { setNodeRef } = useDroppable({
    id: `tabs-container-${pane}`,
    data: { type: "tab-container", pane }
  });

  // 自动滚动逻辑：当激活的 Tab 改变时，确保其在可视区域内
  useLayoutEffect(() => {
    if (!activeTabId || !scrollContainerRef.current) return;
    const container = scrollContainerRef.current;
    const activeEl = Array.from(container.querySelectorAll<HTMLElement>("[data-tab-id]")).find(
      element => element.dataset.tabId === activeTabId,
    );

    if (activeEl) {
      const containerRect = container.getBoundingClientRect();
      const elRect = activeEl.getBoundingClientRect();

      if (elRect.left < containerRect.left) {
        container.scrollLeft -= (containerRect.left - elRect.left);
      } else if (elRect.right > containerRect.right) {
        container.scrollLeft += (elRect.right - containerRect.right);
      }
    }
  }, [activeTabId, tabs]);

  if (tabs.length === 0) {
    return (
        <div
            ref={setNodeRef}
            className="h-9 min-h-[36px] max-h-[36px] bg-ide-tab-bg border-b border-ide-panel-border flex items-center cursor-pointer"
            onClick={() => { setFocusedPane(pane); setSpeechTarget({ kind: "editor", pane }); }}
        >
          <NewTabButtons pane={pane} />
          <div data-tauri-drag-region className="drag-region h-full min-w-8 flex-1" />
        </div>
    );
  }

  return (
      <>
        <style>{`.hide-scroll::-webkit-scrollbar { display: none; }`}</style>
        <div className="flex h-9 min-h-[36px] max-h-[36px] bg-ide-tab-bg border-b border-ide-panel-border w-full">
          <div
              ref={(node) => {
                setNodeRef(node);
                scrollContainerRef.current = node;
              }}
              data-tabs-container={pane}
              className={`w-max min-w-0 flex-[0_1_auto] relative flex overflow-x-auto overflow-y-hidden hide-scroll ${isFocused ? '' : 'opacity-80'}`}
              style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', scrollBehavior: 'smooth' }}
              onClick={() => { setFocusedPane(pane); setSpeechTarget({ kind: "editor", pane }); }}
          >
            <SortableContext items={tabs.map(t => `${pane}-${t.id}`)} strategy={sortingStrategy}>
              {tabs.map((tab) => (
                  <SortableTab key={tab.id} tab={tab} pane={pane} isActive={tab.id === activeTabId} closeImages={closeImages} tabs={tabs} />
              ))}
            </SortableContext>
          </div>
          <div className="flex h-full shrink-0 items-center no-drag-region">
            <EditorTabList pane={pane} />
            <NewTabButtons pane={pane} />
          </div>
          <div data-tauri-drag-region className="drag-region h-full min-w-0 flex-1" />

        </div>
      </>
  );
};

export function EditorTabList({ pane }: EditorTabsProps) {
  const tabs = useTabMetadata(pane);
  const activeTabId = useWorkspaceStore(state => pane === "left" ? state.activeLeftTabId : state.activeRightTabId);
  const { setActiveTab, reorderTabs } = useWorkspaceStore(useShallow(state => ({ setActiveTab: state.setActiveTab, reorderTabs: state.reorderTabs })));
  const [hasOverflow, setHasOverflow] = React.useState(false);

  useEffect(() => {
    const container = document.querySelector(`[data-tabs-container="${pane}"]`);
    if (!(container instanceof HTMLElement)) return;

    const updateOverflow = () => setHasOverflow(container.scrollWidth > container.clientWidth + 1);
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(container);
    if (container.parentElement) observer.observe(container.parentElement);
    updateOverflow();
    return () => observer.disconnect();
  }, [pane, tabs]);

  if (!hasOverflow) return null;

  return (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="window-control" aria-label="显示所有标签页" title="显示所有标签页" disabled={tabs.length === 0}>
              <ChevronDown size={14} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className="ide-menu w-64 max-h-[50vh] overflow-y-auto z-50">
                {tabs.map(tab => (
                    <DropdownMenu.Item
                        key={tab.id}
                        className={`ide-menu-item flex items-center justify-between ${tab.id === activeTabId ? 'bg-ide-selection/30 text-white' : ''}`}
                        onSelect={() => {
                          if (!tab.isPinned) {
                            const index = tabs.findIndex(item => item.id === tab.id);
                            const firstUnpinnedIndex = tabs.filter(item => item.isPinned).length;
                            if (index !== firstUnpinnedIndex) reorderTabs(pane, index, firstUnpinnedIndex);
                          }
                          setActiveTab(tab.id, pane);
                        }}
                    >
                      <span className="truncate flex-1 flex items-center gap-1" title={tab.isTemporary ? "临时视图 · 反向生成树" : tab.isExternal ? `不属于当前项目\n${tab.path}` : tab.path}>
                        {tab.isVersionControl && <GitBranch size={12} aria-label="版本控制" className="shrink-0" />}
                        {!tab.isTemporary && tab.isExternal && <ExternalLink size={12} aria-label="不属于当前项目" className="shrink-0 text-amber-400" />}
                        {tab.isTemporary && <Clock size={12} aria-label="临时视图" className="shrink-0 text-sky-400" />}
                        {tab.isBrowser && (tab.browser?.url === "nexusdesk:nav" ? <Compass size={12} className="shrink-0 text-sky-400" /> : tab.browser?.url === MUSIC_HOME ? <Music2 size={12} className="shrink-0 text-sky-400" /> : tab.browser?.url === MIRROR_HOME ? <Smartphone size={12} className="shrink-0 text-sky-400" /> : tab.browser?.url === VIDEO_HOME ? <Video size={12} className="shrink-0 text-sky-400" /> : tab.browser?.url === CHAT_HOME ? <MessageCircle size={12} className="shrink-0 text-sky-400" /> : <Globe size={12} className="shrink-0 text-sky-400" />)}
                        <span className="truncate">{tab.browser?.url === MIRROR_HOME ? "安卓投屏" : tab.title}</span>
                      </span>
                      {tab.isPinned && <Pin size={12} className="shrink-0 text-gray-400 rotate-45 mr-1" />}
                      {tab.isDirty && <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />}
                    </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
  );
}
