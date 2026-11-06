import { PanelMinimizeButton } from "./PanelMinimizeButton";
import React from "react";
import { FolderGit2, Tags, LocateFixed, Network } from "lucide-react";
import { GraphView } from "@/components/relations/GraphView";
import { PhysicalTree } from "@/components/explorer/PhysicalTree";
import { LogicalTree } from "@/components/explorer/LogicalTree";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { isRemotePath } from "@/lib/remote";

export const Sidebar: React.FC = () => {
    const { sidebarMode, setSidebarMode, rootPath } = useWorkspaceStore();
    const remote = isRemotePath(rootPath);

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
        const path = tabs.find(tab => tab.id === activeTabId)?.path;
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
        <div className="group/panel flex flex-col h-full">
            <div data-tauri-drag-region className="sidebar-toolbar drag-region flex items-center px-1.5 h-8 border-b border-ide-panel-border bg-ide-panel-bg text-xs overflow-hidden">
                <button
                    className={`flex items-center gap-1 px-1.5 py-1 rounded-sm shrink-0 transition-colors ${sidebarMode === "physical" ? "bg-ide-selection text-white" : "text-gray-400 hover:text-white hover:bg-ide-tab-hover"}`}
                    onClick={() => setSidebarMode("physical")}
                    onDragEnter={handleDragEnterPhysical}
                    onDragOver={(e) => e.preventDefault()}
                >
                    <FolderGit2 size={14} />
                    物理
                </button>
                <button
                    disabled={remote}
                    title={remote ? "SFTP 使用物理目录树" : undefined}
                    className={`flex items-center gap-1 px-1.5 py-1 rounded-sm ml-0.5 shrink-0 transition-colors disabled:opacity-50 ${sidebarMode === "logical" ? "bg-ide-selection text-white" : "text-gray-400 hover:text-white hover:bg-ide-tab-hover"}`}
                    onClick={() => setSidebarMode("logical")}
                    onDragEnter={handleDragEnterLogical}
                    onDragOver={(e) => e.preventDefault()}
                >
                    <Tags size={14} />
                    逻辑
                </button>
                <button
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
                    图谱
                </button>
                <button
                    type="button"
                    title="定位当前文件"
                    aria-label="定位当前文件"
                    onClick={locateCurrentFile}
                    className="pointer-events-none opacity-0 group-hover/panel:pointer-events-auto group-hover/panel:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 ml-auto flex h-6 w-6 items-center justify-center shrink-0 rounded text-gray-400 hover:bg-white/10 hover:text-white active:bg-white/15"
                >
                    <LocateFixed size={14} />
                </button>
                <PanelMinimizeButton panel="left" className="!ml-0 shrink-0" />
            </div>

            <div className="flex-1 relative overflow-hidden">
                <div className={`absolute inset-0 ${sidebarMode === "physical" ? "block" : "hidden"}`}>
                    <PhysicalTree />
                </div>
                <div className={`absolute inset-0 ${sidebarMode === "logical" ? "block" : "hidden"}`}>
                    {!remote && <LogicalTree />}
                </div>
                {!remote && sidebarMode === "graph" && <GraphView />}
            </div>
        </div>
    );
};
