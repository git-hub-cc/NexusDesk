// src/components/layout/BottomPanel.tsx
import { PanelMinimizeButton } from "./PanelMinimizeButton";
import { isSnapshot } from "@/lib/snapshot";
import { useEffect, useRef, useState } from "react";
import { gitApi } from "@/lib/api";
import { ClipboardCheck, GitBranch, Settings, Terminal, X, CircleDot, ChevronDown, Pin } from "lucide-react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable, type SortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as DropdownMenu from "@/lib/nativeDropdownMenu";
import * as ContextMenu from "@/lib/nativeMenu";
import openaiIcon from "@/assets/openai.svg";
import { useLayoutStore } from "@/store/layoutStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { isRemotePath } from "@/lib/remote";
import { settingsStorage } from "@/lib/globalSettings";
import { AUTO_REVIEW_PROMPT_KEY, DEFAULT_AUTO_REVIEW_PROMPT } from "@/lib/codexReview";
import { useTerminalStore, type TerminalProfile } from "@/store/terminalStore";
import { GitPanel } from "@/components/git/GitPanel";
import { TerminalSettings } from "./TerminalSettings";
import { TerminalSession } from "./TerminalSession";

function SessionTab({ id, pinned, children }: { id: string; pinned: boolean; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: pinned });
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : undefined }} {...attributes} {...listeners} className="flex h-full shrink-0 items-center">
    {children}
  </div>;
}

function getSessionLabel(cwd: string | null, fallback: string) {
  const directory = cwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return directory || fallback;
}

const sessionSortingStrategy: SortingStrategy = args => {
  const pinnedCount = useTerminalStore.getState().sessions.filter(session => session.isPinned).length;
  return args.index < pinnedCount ? null : horizontalListSortingStrategy(args);
};

export function BottomPanel() {
  const { bottomPanelTab: activeTab, setBottomPanelTab } = useLayoutStore();
  const { profiles, sessions, activeSessionId, createSession, removeSession, setActiveSessionId, reorderSessions, toggleSessionPin, launchError, clearLaunchError } = useTerminalStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [gitInstalled, setGitInstalled] = useState<boolean | null>(null);
  const [exitedSessions, setExitedSessions] = useState<Record<string, boolean>>({});
  const [autoReviewEnabled, setAutoReviewEnabled] = useState(() => settingsStorage.getItem("nexusdesk.codex.autoReview") === "true");
  const [reviewing, setReviewing] = useState(false);
  const autoReviewing = useRef(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [hasTabOverflow, setHasTabOverflow] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    const container = tabsRef.current;
    if (!container) return;
    const updateOverflow = () => setHasTabOverflow(container.scrollWidth > container.clientWidth + 1);
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(container);
    if (container.parentElement) observer.observe(container.parentElement);
    updateOverflow();
    return () => observer.disconnect();
  }, [sessions, gitInstalled, activeTab, autoReviewEnabled]);

  useEffect(() => {
    const container = tabsRef.current;
    const active = container?.querySelector<HTMLElement>(`[data-session-id="${activeSessionId}"]`);
    if (!container || !active) return;
    const parent = container.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.left < parent.left) container.scrollLeft -= parent.left - item.left;
    else if (item.right > parent.right) container.scrollLeft += item.right - parent.right;
  }, [activeSessionId, sessions]);

  const handleSessionDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    if (sessions.find(session => session.id === active.id)?.isPinned || sessions.find(session => session.id === over.id)?.isPinned) return;
    reorderSessions(sessions.findIndex(session => session.id === active.id), sessions.findIndex(session => session.id === over.id));
  };

  const closeSessions = (ids: string[]) => {
    ids.forEach(id => {
      removeSession(id);
      setExitedSessions(prev => { const next = { ...prev }; delete next[id]; return next; });
    });
    if (ids.length === sessions.length && gitInstalled) setBottomPanelTab("git");
  };

  useEffect(() => {
    const updateAutoReview = () => setAutoReviewEnabled(settingsStorage.getItem("nexusdesk.codex.autoReview") === "true");
    window.addEventListener("global-settings-changed", updateAutoReview);
    return () => window.removeEventListener("global-settings-changed", updateAutoReview);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void gitApi.isInstalled().catch(() => false).then(installed => {
      if (!cancelled) setGitInstalled(installed);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (gitInstalled === false && activeTab === "git") setBottomPanelTab("terminal");
    // Layout is restored per project, but terminal sessions are not persisted.
    if (gitInstalled === true && activeTab === "terminal" && sessions.length === 0) setBottomPanelTab("git");
  }, [gitInstalled, activeTab, sessions.length, setBottomPanelTab]);

  const handleExit = (id: string) => {
    setExitedSessions(prev => ({ ...prev, [id]: true }));
  };

  const addSession = async (profile: TerminalProfile) => {
    if (await createSession(profile, useWorkspaceStore.getState().rootPath)) {
      const id = useTerminalStore.getState().activeSessionId;
      setExitedSessions(prev => { const next = { ...prev }; delete next[id]; return next; });
      setBottomPanelTab("terminal");
    }
  };
  const runCodexReview = async () => {
    if (autoReviewing.current) return;
    autoReviewing.current = true;
    setReviewing(true);
    try {
      const root = useWorkspaceStore.getState().rootPath;
      if (!root || isRemotePath(root)) throw new Error("自动审核仅支持本地 Git 仓库");
      const changes = await gitApi.status(root);
      let commitId: string;
      if (changes.length) {
        for (const change of changes) await gitApi.stage(root, change.path, true);
        commitId = await gitApi.commit(root, "自动审核：提交 Codex 变更");
      } else {
        const [latestCommit] = await gitApi.log(root, 1);
        if (!latestCommit) throw new Error("仓库中没有可审核的提交");
        commitId = latestCommit.id;
      }
      const prompt = settingsStorage.getItem(AUTO_REVIEW_PROMPT_KEY)?.trim() || DEFAULT_AUTO_REVIEW_PROMPT;
      const reviewText = `${commitId}${prompt}`.replace(/[\r\n]+/g, " ").replace(/'/g, "''");
      const reviewCommand = `codex --no-alt-screen '${reviewText}'`;
      const reviewProfile = { id: "codex-auto-review", name: "Codex 自动审核", command: reviewCommand };
      if (await createSession(reviewProfile, root)) {
        const id = useTerminalStore.getState().activeSessionId;
        setExitedSessions(prev => { const next = { ...prev }; delete next[id]; return next; });
        setBottomPanelTab("terminal");
      }
    } catch (error) {
      useTerminalStore.setState({ launchError: `自动审核失败：${String(error)}` });
      setBottomPanelTab("terminal");
    } finally {
      autoReviewing.current = false;
      setReviewing(false);
    }
  };
  const terminalProfile = profiles.find(profile => profile.id === "shell") ?? { id: "shell", name: "终端", command: "" };
  const codexProfile = profiles.find(profile => profile.id === "codex"
    || /\bcodex\b/i.test(profile.command)
    || profile.name.toLowerCase() === "codex")
    ?? { id: "codex", name: "Codex", command: "codex" };
  const tabClass = (selected: boolean) => `group flex shrink-0 items-center gap-1 px-3 h-full text-gray-400 ${selected ? "bg-ide-tab-active-bg text-white hover:bg-ide-tab-active-bg" : "hover:bg-ide-tab-hover hover:text-white"}`;

  if (isSnapshot) return <div className="flex flex-col h-full"><div className="flex items-center justify-between px-3 h-8 shrink-0 border-b border-ide-panel-border text-xs"><span>历史快照 · 只读（终端已禁用）</span><PanelMinimizeButton panel="bottom" /></div><div className="flex-1 min-h-0"><GitPanel /></div></div>;

  return <div className="group/panel flex flex-col h-full">
    <div className="flex items-center justify-between pl-0 pr-2 h-8 shrink-0 border-b border-ide-panel-border bg-ide-panel-bg text-xs">
      <div className="flex h-full min-w-0 flex-1 items-stretch">
        <div ref={tabsRef} className="flex h-full min-w-0 shrink items-stretch overflow-hidden">
        {gitInstalled && <button className={`${tabClass(activeTab === "git")} min-w-[120px] max-w-[200px] border-r border-ide-panel-border`} onClick={() => setBottomPanelTab("git")}><GitBranch size={14} />版本控制</button>}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleSessionDragEnd}>
          <SortableContext items={sessions.map(session => session.id)} strategy={sessionSortingStrategy}>
          {sessions.map(session => {
          const isCodex = session.command.toLowerCase().includes("codex") || session.name.toLowerCase().includes("codex");
          const isExited = exitedSessions[session.id];

          const sessionLabel = getSessionLabel(session.cwd, session.name);
          return <ContextMenu.Root key={session.id}><SessionTab id={session.id} pinned={!!session.isPinned}><ContextMenu.Trigger asChild>
            <div data-session-id={session.id} title={session.cwd || session.name} className={`group flex items-center shrink-0 h-full min-w-[120px] max-w-[200px] border-r border-ide-panel-border ${activeTab === "terminal" && activeSessionId === session.id ? "bg-ide-tab-active-bg hover:bg-ide-tab-active-bg" : "hover:bg-ide-tab-hover"}`}>
            <button className={`${tabClass(false)} min-w-0 flex-1 hover:bg-transparent ${activeTab === "terminal" && activeSessionId === session.id ? "text-white" : ""} ${session.isPinned ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"}`} onClick={() => { setActiveSessionId(session.id); setBottomPanelTab("terminal"); }}>
              {isExited ? <CircleDot size={14} className="text-gray-500" /> : isCodex ? <img src={openaiIcon} alt="" className="h-3.5 w-3.5 shrink-0 opacity-70 group-hover:opacity-100" /> : <Terminal size={14} />}
              <span className="truncate">{sessionLabel}</span>
              {session.isPinned && <Pin size={12} className="shrink-0 text-gray-400 rotate-45" />}
            </button>
            <button aria-label={`关闭 ${sessionLabel} 会话`} title={`关闭 ${sessionLabel} 会话`} className="flex h-5 w-5 items-center justify-center rounded text-gray-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-white/15 hover:text-white active:bg-white/20" onClick={() => {
              removeSession(session.id);
              setExitedSessions(prev => { const next = { ...prev }; delete next[session.id]; return next; });
              if (sessions.length === 1 && gitInstalled) setBottomPanelTab("git");
            }}><X size={12} /></button>
            </div>
          </ContextMenu.Trigger></SessionTab>
          <ContextMenu.Portal>
            <ContextMenu.Content aria-label="终端标签操作" className="ide-menu w-48 text-sm" onClick={event => event.stopPropagation()}>
              <ContextMenu.Item className="ide-menu-item" onSelect={() => toggleSessionPin(session.id)}>{session.isPinned ? "取消固定" : "固定"}</ContextMenu.Item>
              <ContextMenu.Separator className="h-px bg-[#4b5054] my-1 mx-2" />
              <ContextMenu.Item className="ide-menu-item" onSelect={() => closeSessions(sessions.filter(item => item.id !== session.id && !item.isPinned).map(item => item.id))}>关闭其他</ContextMenu.Item>
              <ContextMenu.Item className="ide-menu-item" onSelect={() => closeSessions(sessions.slice(0, sessions.indexOf(session)).filter(item => !item.isPinned).map(item => item.id))}>关闭左侧</ContextMenu.Item>
              <ContextMenu.Item className="ide-menu-item" onSelect={() => closeSessions(sessions.slice(sessions.indexOf(session) + 1).filter(item => !item.isPinned).map(item => item.id))}>关闭右侧</ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
          </ContextMenu.Root>
        })}
          </SortableContext>
        </DndContext>
        </div>
        {hasTabOverflow && <DropdownMenu.Root>
          <DropdownMenu.Trigger className="flex h-8 w-8 shrink-0 items-center justify-center text-gray-400 hover:bg-ide-tab-hover hover:text-white" aria-label="显示所有面板标签" title="显示所有面板标签"><ChevronDown size={14} /></DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className="ide-menu w-64 max-h-[50vh] overflow-y-auto z-50">
              {gitInstalled && <DropdownMenu.Item className={`ide-menu-item ${activeTab === "git" ? "bg-ide-selection/30 text-white" : ""}`} onSelect={() => setBottomPanelTab("git")}>版本控制</DropdownMenu.Item>}
              {sessions.map(session => <DropdownMenu.Item key={session.id} title={session.cwd || session.name} className={`ide-menu-item ${activeTab === "terminal" && activeSessionId === session.id ? "bg-ide-selection/30 text-white" : ""}`} onSelect={() => { setActiveSessionId(session.id); setBottomPanelTab("terminal"); }}>{getSessionLabel(session.cwd, session.name)}</DropdownMenu.Item>)}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>}
        <button type="button" title="新建终端" aria-label="新建终端" onClick={() => void addSession(terminalProfile)} className="flex h-full shrink-0 items-center gap-1.5 px-3 text-gray-400 hover:bg-ide-tab-hover hover:text-white">
          <Terminal size={14} />
        </button>
        <button type="button" title="启动 Codex" aria-label="启动 Codex" onClick={() => void addSession(codexProfile)} className="group flex h-full shrink-0 items-center gap-1.5 px-3 text-gray-400 hover:bg-ide-tab-hover hover:text-white">
          <img src={openaiIcon} alt="" className="h-3.5 w-3.5 shrink-0 opacity-70 group-hover:opacity-100" />
        </button>
        {autoReviewEnabled && <button type="button" title="审核 Codex 变更" aria-label="审核 Codex 变更" disabled={reviewing} onClick={() => void runCodexReview()} className="flex h-full shrink-0 items-center gap-1.5 px-3 text-gray-400 hover:bg-ide-tab-hover hover:text-white disabled:cursor-wait disabled:opacity-50">
          <ClipboardCheck size={14} />
        </button>}
      </div>
      <div className="flex gap-1 shrink-0">
        <button title="命令行工具设置" aria-label="命令行工具设置" onClick={() => setSettingsOpen(true)} className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-white/10 hover:text-white active:bg-white/15 opacity-0 group-hover/panel:opacity-100 transition-opacity"><Settings size={14} /></button>
        <PanelMinimizeButton panel="bottom" />
      </div>
    </div>
    {launchError && <div role="alert" className="flex items-center gap-2 px-3 py-2 text-xs text-red-400">
      <span className="flex-1">{launchError}</span>
      <button onClick={() => setSettingsOpen(true)} className="underline shrink-0">修改配置</button>
      <button onClick={clearLaunchError} aria-label="关闭错误提示"><X size={14} /></button>
    </div>}
    <div className="flex-1 min-h-0 overflow-hidden">
      {gitInstalled && activeTab === "git" && <GitPanel />}
      {sessions.map(session => <TerminalSession key={session.id} session={session} active={activeTab === "terminal" && activeSessionId === session.id} onExit={handleExit} />)}
    </div>
    {settingsOpen && <TerminalSettings onClose={() => setSettingsOpen(false)} />}
  </div>;
}
