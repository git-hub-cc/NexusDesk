import { PanelMinimizeButton } from "@/components/layout/PanelMinimizeButton";
import React, { useEffect, useState } from "react";
import { Link, ArrowRight, ArrowLeft, Activity, ChevronDown, ChevronRight } from "lucide-react";
import { fsApi } from "@/lib/api";
import { flushEditorContent, useWorkspaceStore } from "@/store/workspaceStore";
import { NetworkMonitor } from "@/components/NetworkMonitor";

type FileLink = [string, string];
type Relations = { path: string; root: string | null; backlinks: FileLink[]; outgoing: FileLink[]; error?: string };

export const RelationalView: React.FC = () => {
  const path = useWorkspaceStore(state => {
    const tabs = state.focusedPane === "left" ? state.leftTabs : state.rightTabs;
    const id = state.focusedPane === "left" ? state.activeLeftTabId : state.activeRightTabId;
    return tabs.find(tab => tab.id === id)?.path;
  });
  const root = useWorkspaceStore(state => state.rootPath);
  const indexRevision = useWorkspaceStore(state => state.indexRevision);
  const openTab = useWorkspaceStore(state => state.openTab);
  const [relations, setRelations] = useState<Relations | null>(null);
  const [navigationError, setNavigationError] = useState("");
  const [relationsOpen, setRelationsOpen] = useState(true);

  useEffect(() => {
    let live = true;
    setNavigationError("");
    if (!path) { setRelations(null); return; }
    Promise.all([fsApi.getFileLinks(path, true), fsApi.getFileLinks(path, false)])
      .then(([backlinks, outgoing]) => {
        if (live) setRelations({ path, root, backlinks, outgoing });
      })
      .catch(error => {
        if (live) setRelations({ path, root, backlinks: [], outgoing: [], error: "关联加载失败：" + String(error) });
      });
    return () => { live = false; };
  }, [path, root, indexRevision]);

  // Keep results scoped to the file and project that requested them.
  const current = relations?.path === path && relations?.root === root ? relations : null;
  const nav = async (target: string) => {
    setNavigationError("");
    try {
      flushEditorContent();
      const state = useWorkspaceStore.getState();
      const existing = [...state.leftTabs, ...state.rightTabs].find(tab => tab.path === target && !tab.revision && tab.diff === undefined);
      const content = existing?.content ?? await fsApi.readFile(target);
      if (useWorkspaceStore.getState().rootPath !== root) return;
      openTab({ id: target, path: target, title: target.split(/[\\/]/).pop() ?? target, content });
    } catch (error) { setNavigationError("打开关联文件失败：" + String(error)); }
  };
  const group = (title: string, Icon: typeof ArrowLeft, items: FileLink[]) => (
    <div className="mb-4">
      <div className="flex items-center gap-1 text-gray-300 mb-1"><Icon size={14}/><span>{title} ({items.length})</span></div>
      {items.map(([target, anchor]) => <button key={JSON.stringify([target, anchor])} title={target + (anchor ? "#" + anchor : "")} onClick={() => void nav(target)} className="block w-full pl-4 text-left text-gray-400 hover:text-white truncate">{target.split(/[\\/]/).pop()} {anchor && "#" + anchor}</button>)}
    </div>
  );
  return <div className="group/panel flex h-full w-full min-h-0 flex-col bg-ide-panel-bg">
    <section className={`flex min-h-0 flex-col ${relationsOpen ? "max-h-[50%] shrink" : "shrink-0"}`}>
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-ide-panel-border px-2 text-xs font-semibold">
        <button type="button" onClick={() => setRelationsOpen(value => !value)} aria-expanded={relationsOpen} className="flex items-center gap-1 text-gray-200 hover:text-white">
          {relationsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Link size={14} />关联
        </button>
        <PanelMinimizeButton panel="right" className="!ml-auto" />
      </header>
      <div className={`min-h-0 overflow-auto p-2 text-sm ${relationsOpen ? "" : "hidden"}`}>
      {!path ? <p className="text-gray-500">请选择文件</p> : !current ? <p className="text-gray-500">正在加载关联…</p> : <>{group("反向链接", ArrowLeft, current.backlinks)}{group("正向链接", ArrowRight, current.outgoing)}</>}
      {(current?.error || navigationError) && <p role="alert" className="text-xs text-red-400 break-words">{navigationError || current?.error}</p>}
      </div>
    </section>
    <section className="flex min-h-0 flex-1 flex-col border-t border-ide-panel-border">
      <div className="flex h-8 shrink-0 items-center gap-1 px-2 text-xs font-semibold"><Activity size={14} />Codex 捕获</div>
      <div className="min-h-0 flex-1"><NetworkMonitor /></div>
    </section>
  </div>;
};
