// src/components/layout/BottomPanel.tsx
import { PanelMinimizeButton } from "./PanelMinimizeButton";
import { isSnapshot } from "@/lib/snapshot";
import { useEffect, useRef, useState } from "react";
import { gitApi } from "@/lib/api";
import { ClipboardCheck, GitBranch, Settings, Terminal, X, CircleDot } from "lucide-react";
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

export function BottomPanel() {
  const { bottomPanelTab: activeTab, setBottomPanelTab } = useLayoutStore();
  const { profiles, sessions, activeSessionId, createSession, removeSession, setActiveSessionId, launchError, clearLaunchError } = useTerminalStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [gitInstalled, setGitInstalled] = useState<boolean | null>(null);
  const [exitedSessions, setExitedSessions] = useState<Record<string, boolean>>({});
  const [autoReviewEnabled, setAutoReviewEnabled] = useState(() => settingsStorage.getItem("nexusdesk.codex.autoReview") === "true");
  const [reviewing, setReviewing] = useState(false);
  const autoReviewing = useRef(false);

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
      const reviewCommand = `codex '${reviewText}'`;
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
  const tabClass = (selected: boolean) => `group flex shrink-0 items-center gap-1 px-3 h-full border-b-2 text-gray-400 hover:bg-ide-tab-hover hover:text-white ${selected ? "border-ide-accent text-white" : "border-transparent"}`;

  if (isSnapshot) return <div className="flex flex-col h-full"><div className="flex items-center justify-between px-3 h-8 shrink-0 border-b border-ide-panel-border text-xs"><span>历史快照 · 只读（终端已禁用）</span><PanelMinimizeButton panel="bottom" /></div><div className="flex-1 min-h-0"><GitPanel /></div></div>;

  return <div className="group/panel flex flex-col h-full">
    <div className="flex items-center justify-between px-2 h-8 shrink-0 border-b border-ide-panel-border bg-ide-panel-bg text-xs">
      <div className="flex items-center h-full min-w-0 overflow-x-auto">
        {gitInstalled && <button className={tabClass(activeTab === "git")} onClick={() => setBottomPanelTab("git")}><GitBranch size={14} />版本控制</button>}
        {sessions.map(session => {
          const isCodex = session.command.toLowerCase().includes("codex") || session.name.toLowerCase().includes("codex");
          const isExited = exitedSessions[session.id];

          return <div key={session.id} className="flex items-center shrink-0 h-full">
            <button className={tabClass(activeTab === "terminal" && activeSessionId === session.id)} onClick={() => { setActiveSessionId(session.id); setBottomPanelTab("terminal"); }}>
              {isExited ? <CircleDot size={14} className="text-gray-500" /> : isCodex ? <img src={openaiIcon} alt="" className="h-3.5 w-3.5 shrink-0 opacity-70 group-hover:opacity-100" /> : <Terminal size={14} />}
              {session.name}
            </button>
            <button aria-label={`关闭 ${session.name} 会话`} className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-white/15 hover:text-white active:bg-white/20" onClick={() => {
              removeSession(session.id);
              setExitedSessions(prev => { const next = { ...prev }; delete next[session.id]; return next; });
              if (sessions.length === 1 && gitInstalled) setBottomPanelTab("git");
            }}><X size={12} /></button>
          </div>
        })}
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
