import { PanelMinimizeButton } from "@/components/layout/PanelMinimizeButton";
import React, { useEffect, useState } from "react";
import { Link, ArrowRight, ArrowLeft, Activity } from "lucide-react";
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
  const [networkOpen, setNetworkOpen] = useState(true);

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
  return <div className="group/panel flex flex-col h-full w-full bg-ide-panel-bg">
    <div className="px-2 py-1 border-b border-ide-panel-border text-xs font-semibold flex items-center gap-1"><button type="button" onClick={() => setNetworkOpen(false)} className={networkOpen ? "text-gray-400" : "text-white"}><Link size={14} className="inline mr-1"/>关联</button><button type="button" onClick={() => setNetworkOpen(true)} className={networkOpen ? "text-white ml-1" : "text-gray-400 ml-1"}><Activity size={14} className="inline mr-1"/>Codex 捕获</button><PanelMinimizeButton panel="right" className="!ml-auto" /></div>
    <div className={`flex-1 overflow-auto p-2 text-sm ${networkOpen ? "hidden" : ""}`}>
      {!path ? <p className="text-gray-500">请选择文件</p> : !current ? <p className="text-gray-500">正在加载关联…</p> : <>{group("反向链接", ArrowLeft, current.backlinks)}{group("正向链接", ArrowRight, current.outgoing)}</>}
      {(current?.error || navigationError) && <p role="alert" className="text-xs text-red-400 break-words">{navigationError || current?.error}</p>}
    </div>
    <div className={`flex-1 min-h-0 ${networkOpen ? "" : "hidden"}`}><NetworkMonitor /></div>
  </div>;
};
