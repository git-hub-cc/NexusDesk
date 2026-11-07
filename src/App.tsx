import { AppDialog } from "@/components/AppDialog";
import { useWorkspaceWatcher } from "@/hooks/useWorkspaceWatcher";
import { Workspace } from "@/components/layout/Workspace";
import { useShortcuts } from "@/hooks/useShortcuts";
import { useFileDrop } from "@/hooks/useFileDrop";
import "./App.css";
import { useCallback, useState, useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { scheduleWindowReveal } from "@/lib/windowStartup";
import { SearchEverywhere } from "@/components/search/SearchEverywhere";
import { flushEditorContent, useWorkspaceStore } from "@/store/workspaceStore";
import { isSnapshot } from "@/lib/snapshot";

function App() {
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => { setRecentOpen(false); setSearchOpen(true); }, []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const [recentOpen, setRecentOpen] = useState(false);
  const openRecent = useCallback(() => { setSearchOpen(false); setRecentOpen(true); }, []);
  useShortcuts(openSearch, openRecent);
  useWorkspaceWatcher();
  const { isDragging, error, dismissError } = useFileDrop();
  const setProject = useWorkspaceStore(state => state.setProject);
  const rootPath = useWorkspaceStore(state => state.rootPath);
  const tabsRestored = useWorkspaceStore(state => state.pinnedTabsRestored);
  const startup = useRef<Promise<unknown> | null>(null);
  const startupUrlOpened = useRef(false);
  const [startupReady, setStartupReady] = useState(false);

  useEffect(() => {
    const flushAfterComposition = () => window.setTimeout(flushEditorContent, 0);
    window.addEventListener("blur", flushAfterComposition);
    return () => window.removeEventListener("blur", flushAfterComposition);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!startup.current) {
      const projectPath = new URLSearchParams(window.location.search).get("project");
      // Reuse initialization across StrictMode's effect replay.
      startup.current = (async () => {
        const path = projectPath ?? (isTauri() ? await invoke<string | null>("startup_project") : null)
          ?? useWorkspaceStore.getState().recentProjects[0];
        if (path) await setProject(path);
      })()
        .catch(console.error);
    }
    void startup.current.then(() => { if (!cancelled) setStartupReady(true); });
    return () => { cancelled = true; };
  }, [setProject]);

  useEffect(() => {
    if (!startupReady || !isTauri()) return;
    return scheduleWindowReveal(() => {
      void getCurrentWindow().show().catch(error => console.error("Failed to show window:", error));
    });
  }, [startupReady]);

  useEffect(() => {
    if (!startupReady || !isTauri() || startupUrlOpened.current) return;
    startupUrlOpened.current = true;
    void invoke<string | null>("startup_url").then(url => {
      if (!url) return;
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return;
      const id = `browser:${crypto.randomUUID()}`;
      useWorkspaceStore.getState().openTab({ id, path: id, title: parsed.hostname, browser: { root: rootPath ?? "", url: parsed.href } });
    }).catch(console.error);
  }, [rootPath, startupReady]);

  return (
    <div className="flex flex-col h-screen w-screen min-w-[640px] overflow-hidden bg-ide-bg text-ide-fg font-sans">
      <AppDialog />
      {recentOpen && <SearchEverywhere recent onClose={() => setRecentOpen(false)} />}
      {searchOpen && <SearchEverywhere onClose={closeSearch} />}
      <div className="flex-1 min-h-0 overflow-hidden">
        {startupReady && (isSnapshot || !rootPath || tabsRestored) && <Workspace key={rootPath} />}
      </div>
      {isDragging && (
        <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center border-2 border-ide-accent bg-ide-bg/80">
          <div className="rounded border border-ide-accent bg-ide-bg px-8 py-6 text-center" role="status">
            <div className="text-lg">松开以打开文件或目录</div>
            <div className="mt-2 text-sm text-gray-400">文件将在编辑器中打开，目录将作为项目打开</div>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="fixed bottom-4 right-4 z-50 max-w-lg rounded border border-red-500 bg-ide-bg p-4 text-sm shadow-lg">
          <div className="mb-2 flex items-center justify-between gap-4">
            <span>打开失败</span>
            <button onClick={dismissError} aria-label="关闭错误提示">关闭</button>
          </div>
          <div className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{error}</div>
        </div>
      )}
    </div>
  );
}

export default App;
