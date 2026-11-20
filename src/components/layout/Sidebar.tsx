import { PanelMinimizeButton } from "./PanelMinimizeButton";
import React from "react";
import { FolderGit2, Tags, LocateFixed, Network, History } from "lucide-react";
import { GraphView } from "@/components/relations/GraphView";
import { PhysicalTree } from "@/components/explorer/PhysicalTree";
import { LogicalTree } from "@/components/explorer/LogicalTree";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { isRemotePath } from "@/utils/remote";
import { gitApi } from "@/utils/api";
import { isSnapshot } from "@/utils/snapshot";

const toolClass = "pointer-events-none opacity-0 group-hover/panel:pointer-events-auto group-hover/panel:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 flex h-6 w-6 items-center justify-center shrink-0 rounded text-gray-400 hover:bg-white/10 hover:text-white active:bg-white/15 disabled:opacity-50";

export const Sidebar: React.FC = () => {
    const { sidebarMode, setSidebarMode, rootPath } = useWorkspaceStore();
    const remote = isRemotePath(rootPath);
    const tab = useWorkspaceStore(state => state.focusedPane === "left"
        ? state.leftTabs.find(tab => tab.id === state.activeLeftTabId)
        : state.rightTabs.find(tab => tab.id === state.activeRightTabId));
    const [openingSnapshot, setOpeningSnapshot] = React.useState(false);
    const [snapshotError, setSnapshotError] = React.useState("");
    const snapshotLabel = "在历史快照中查看";
    const locateLabel = tab?.diffContext ? "在当前工作区定位" : "定位当前文件";

    const openSnapshot = async () => {
        if (!tab?.diffContext || !tab.revision) return;
        setOpeningSnapshot(true);
        setSnapshotError("");
        try { await gitApi.openSnapshot(tab.diffContext.root, tab.revision, tab.diffContext.path); }
        catch (error) { setSnapshotError(`无法打开历史快照：${String(error)}`); }
        finally { setOpeningSnapshot(false); }
    };

    const handleDragEnterLogical = (e: React.DragEvent) => {
        if (remote) return;
        e.preventDefault();
        if (e.dataTransfer.types.includes("application/x-nexusdesk-file")) {
            setSidebarMode("logical");
        }
    };

    const handleDragEnterPhysical = (e: React.DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes("application/x-nexusdesk-logical-file")) {
            setSidebarMode("physical");
        }
    };

    const locateCurrentFile = () => {
        const state = useWorkspaceStore.getState();
        const activeTabId = state.focusedPane === "left" ? state.activeLeftTabId : state.activeRightTabId;
        const tabs = state.focusedPane === "left" ? state.leftTabs : state.rightTabs;
        const currentTab = tabs.find(tab => tab.id === activeTabId);
        if (currentTab?.diffContext) {
            state.setSidebarMode("physical");
            state.triggerLocate(undefined, currentTab.diffContext);
            return;
        }
        const path = currentTab?.path;
        if (path && state.sidebarMode === "logical" && state.logicalTreeData.some(category => category.children?.some((entry: any) => entry.id === path || entry.children?.some((child: any) => child.id === path)))) {
            state.triggerLocate();
            return;
        }
        // The graph pane handles locateSignal by expanding the matching category
        // and highlighting the linked file. Keep the graph pane active when the
        // current file belongs to one of its categories.
        if (path && state.sidebarMode === "graph") {
            state.triggerLocate();
            return;
        }
        if (state.sidebarMode !== "physical") state.setSidebarMode("physical");
        state.triggerLocate();
    };

    return (
        <div className="sidebar-panel group/panel flex flex-col h-full">
            <div data-tauri-drag-region className="sidebar-toolbar drag-region flex items-center px-1.5 h-8 border-b border-ide-panel-border bg-ide-panel-bg text-xs overflow-hidden">
                <button
                    title="物理" aria-label="物理"
                    className={`flex items-center gap-1 px-1.5 py-1 rounded-sm shrink-0 transition-colors ${sidebarMode === "physical" ? "bg-ide-selection text-white" : "text-gray-400 hover:text-white hover:bg-ide-tab-hover"}`}
                    onClick={() => setSidebarMode("physical")}
                    onDragEnter={handleDragEnterPhysical}
                    onDragOver={(e) => e.preventDefault()}
                >
                    <FolderGit2 size={14} />
                    <span className="sidebar-mode-label">物理</span>
                </button>
                <button
                    title="逻辑" aria-label="逻辑"
                    className={`flex items-center gap-1 px-1.5 py-1 rounded-sm ml-0.5 shrink-0 transition-colors disabled:opacity-50 ${sidebarMode === "logical" ? "bg-ide-selection text-white" : "text-gray-400 hover:text-white hover:bg-ide-tab-hover"}`}
                    onClick={() => setSidebarMode("logical")}
                    onDragEnter={handleDragEnterLogical}
                    onDragOver={(e) => e.preventDefault()}
                >
                    <Tags size={14} />
                    <span className="sidebar-mode-label">逻辑</span>
                </button>
                <button
                    title="图谱" aria-label="图谱"
                    disabled={remote}
                    className={`flex items-center gap-1 px-1.5 py-1 rounded-sm ml-0.5 shrink-0 transition-colors disabled:opacity-50 ${sidebarMode === "graph" ? "bg-ide-selection text-white" : "text-gray-400 hover:text-white hover:bg-ide-tab-hover"}`}
                    onClick={() => setSidebarMode("graph")}
                    onDragEnter={event => {
                        if (remote) return;
                        if (event.dataTransfer.types.some(type => ["application/x-nexusdesk-file", "application/x-nexusdesk-files", "application/x-nexusdesk-logical-file"].includes(type))) {
                            event.preventDefault();
                            setSidebarMode("graph");
                        }
                    }}
                    onDragOver={event => event.preventDefault()}
                >
                    <Network size={14} />
                    <span className="sidebar-mode-label">图谱</span>
                </button>
                <button
                    type="button"
                    title={locateLabel}
                    aria-label={locateLabel}
                    onClick={locateCurrentFile}
                    className={`ml-auto ${toolClass}`}
                >
                    <LocateFixed size={14} />
                </button>
                {!isSnapshot && tab?.revision && tab.diffContext && <button type="button"
                    title={snapshotLabel} aria-label={snapshotLabel} disabled={openingSnapshot}
                    onClick={() => void openSnapshot()} className={toolClass}>
                    <History size={14} />
                </button>}
                <PanelMinimizeButton panel="left" className="!ml-0 shrink-0" />
            </div>

            {snapshotError && <div className="flex gap-2 p-2 text-xs text-red-400">
                <span role="alert" className="min-w-0 flex-1 break-words">{snapshotError}</span>
                <button type="button" aria-label="关闭提示" onClick={() => setSnapshotError("")}>×</button>
            </div>}
            <div className="flex-1 relative overflow-hidden">
                <div className={`absolute inset-0 ${sidebarMode === "physical" ? "block" : "hidden"}`}>
                    <PhysicalTree />
                </div>
                <div className={`absolute inset-0 ${sidebarMode === "logical" ? "block" : "hidden"}`}>
                    <LogicalTree />
                </div>
                <div className={`absolute inset-0 ${sidebarMode === "graph" ? "block" : "hidden"}`}>
                    {!remote && <GraphView key={rootPath} active={sidebarMode === "graph"} />}
                </div>
            </div>
        </div>
    );
};
