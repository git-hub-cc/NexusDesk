import { FileIcon } from "./FileIcon";
import { selectTreeNode, activateTreeFile } from "./treeInteraction";
import { useTreeSpeedSearch } from "./useTreeSpeedSearch";
import { useTreeOpenState } from "./useTreeOpenState";
import * as ContextMenu from "@/lib/nativeMenu";
import { useDeleteConfirmation } from "./useDeleteConfirmation";
import { openContextMenuFromKeyboard } from "@/lib/contextMenu";
import { CreateNameDialog } from "./CreateNameDialog";
import React, { useEffect, useState, useRef } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import { ChevronRight, ChevronDown, File } from "lucide-react";
import { useElementSize } from "@/hooks/useElementSize";
import { useWorkspaceStore, flushPendingWrites } from "@/store/workspaceStore";
import { fsApi } from "@/lib/api";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { isRemotePath } from "@/lib/remote";
import { useTerminalStore } from "@/store/terminalStore";
import { useLayoutStore } from "@/store/layoutStore";

const LogicalNodeContext = React.createContext<((props: NodeRendererProps<any>) => React.ReactElement) | null>(null);
function LogicalTreeNode(props: NodeRendererProps<any>) {
  return React.useContext(LogicalNodeContext)?.(props) ?? null;
}

const getIcon = (node: any) => node.data.missing ? <File size={14} className="shrink-0" aria-hidden="true" /> : <FileIcon name={node.data.name} directory={!node.isLeaf} open={node.isOpen} />;

export const LogicalTree: React.FC = React.memo(() => {
  const [containerRef, { width, height }] = useElementSize<HTMLDivElement>();
  const logicalTreeData = useWorkspaceStore(state => state.logicalTreeData);
  const fetchLogicalTree = useWorkspaceStore(state => state.fetchLogicalTree);
  const moveLogicalNode = useWorkspaceStore(state => state.moveLogicalNode);
  const openTab = useWorkspaceStore(state => state.openTab);
  const createLogicalFolder = useWorkspaceStore(state => state.createLogicalFolder);
  const locateSignal = useWorkspaceStore(state => state.locateSignal);
  const activeLeftTabId = useWorkspaceStore(state => state.activeLeftTabId);
  const activeRightTabId = useWorkspaceStore(state => state.activeRightTabId);
  const focusedPane = useWorkspaceStore(state => state.focusedPane);
  const leftTabs = useWorkspaceStore(state => state.leftTabs);
  const rightTabs = useWorkspaceStore(state => state.rightTabs);
  const [isCreating, setIsCreating] = useState(false);
  const [rename, setRename] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [hiddenFiles, setHiddenFiles] = useState<[string, string][]>([]);
  const dialogFromMenu = useRef(false);
  const busy = useRef(false);
  const treeRef = useRef<any>(null);
  const draggedLogicalRef = useRef<{ id: string; category: string } | null>(null);
  const rootPath = useWorkspaceStore(state => state.rootPath);
  const speedSearch = useTreeSpeedSearch(treeRef, rootPath);
  const treeOpenState = useTreeOpenState(treeRef, rootPath, "logical", logicalTreeData);
  const { confirmDelete, confirmationDialog } = useDeleteConfirmation(rootPath);
  
  useEffect(() => { setIsCreating(false); setRename(null); setError(""); }, [rootPath]);
  
  useEffect(() => {
    let active = true;
    if (!rootPath) { setHiddenFiles([]); return; }
    void fsApi.getHiddenLogicalFiles().then(files => { if (active) setHiddenFiles(files); }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [rootPath, logicalTreeData]);

  useEffect(() => {
    fetchLogicalTree();
  }, [fetchLogicalTree]);

  useEffect(() => {
    if (locateSignal === 0 || !rootPath || !logicalTreeData) return;
    const activeTabId = focusedPane === "left" ? activeLeftTabId : activeRightTabId;
    const tabs = focusedPane === "left" ? leftTabs : rightTabs;
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (!activeTab || !activeTab.path) return;

    const targetPath = activeTab.path;

    const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "").toLocaleLowerCase();
    for (const category of logicalTreeData) {
        let targetId: string | null = null;
        const ancestors: string[] = [];
        const searchNode = (nodes: any[], parents: string[]): boolean => {
            for (const node of nodes) {
                const id = `${category.id}:${node.id}`;
                if (normalize(node.id) === normalize(targetPath)) {
                    targetId = id;
                    ancestors.push(...parents);
                    return true;
                }
                if (normalize(targetPath).startsWith(`${normalize(node.id)}/`) && node.children?.length && searchNode(node.children, [...parents, id])) return true;
            }
            return false;
        };
        if (category.children && searchNode(category.children, [category.id])) {
            for (const id of ancestors) treeRef.current?.open(id);
            const trySelect = (retries = 20) => {
                if (retries <= 0) return;
                setTimeout(() => {
                    const node = treeRef.current?.get(targetId!);
                    if (node) {
                        treeRef.current?.select(targetId!);
                        treeRef.current?.scrollTo(targetId!);
                    } else trySelect(retries - 1);
                }, 50);
            };
            trySelect();
            break;
        }
    }
  }, [locateSignal, logicalTreeData]);

  const handleNodeClick = async (node: any) => {
    if (node.data.missing) return;
    if (!node.isLeaf) {
      node.toggle();
      return;
    }

    if (node.isLeaf) {
      try {
        const content = await fsApi.readFile(node.data.id);
        openTab({
          id: node.data.id,
          title: node.data.name,
          path: node.data.id,
          content: content,
          isDirty: false,
        });
      } catch (error) {
        console.error("Failed to read file:", error);
      }
    }
  };

  const handleDragStart = (e: React.DragEvent, node: any) => {
    if (node.data.missing || node.data.id.startsWith("logical_")) { e.preventDefault(); return; }
    e.stopPropagation();
    e.dataTransfer.setData("application/x-noteide-logical-file", node.data.id);
    e.dataTransfer.effectAllowed = "copyMove";
    
    const category = logicalTreeData.find(entry => node.id.startsWith(`${entry.id}:`));
    draggedLogicalRef.current = { id: node.data.id, category: category?.name || "" };
  };

  const [dragOverCategory, setDragOverCategory] = useState<string | null>(null);
  const handleDragOver = (e: React.DragEvent, node: any) => {
    if (node.data.id.startsWith("logical_") && e.dataTransfer.types.some(type => ["application/x-noteide-file", "application/x-noteide-files", "application/x-noteide-logical-file"].includes(type))) {
      e.preventDefault();
      e.stopPropagation();
      if (!draggedLogicalRef.current || draggedLogicalRef.current.category !== node.data.name) setDragOverCategory(node.data.name);
      
      if (e.dataTransfer.types.includes("application/x-noteide-logical-file") && draggedLogicalRef.current) {
          if (draggedLogicalRef.current.category === node.data.name) {
              setDragOverCategory(null);
              e.dataTransfer.dropEffect = "none";
              return;
          }
      }
      
      e.dataTransfer.dropEffect = (e.dataTransfer.types.includes("application/x-noteide-file") || e.dataTransfer.types.includes("application/x-noteide-files")) ? "link" : "move";
    }
  };

  const handleDrop = (e: React.DragEvent, node: any) => {
    setDragOverCategory(null);
    const dragged = draggedLogicalRef.current;
    draggedLogicalRef.current = null;
    
    if (!node.data.id.startsWith("logical_")) return;
    const logical = e.dataTransfer.getData("application/x-noteide-logical-file");
    const physicalFilesStr = e.dataTransfer.getData("application/x-noteide-files");
    const physical = e.dataTransfer.getData("application/x-noteide-file");
    
    let pathsToMove: string[] = [];
    if (physicalFilesStr) {
        try { pathsToMove = JSON.parse(physicalFilesStr); } catch {}
    } else if (physical) {
        pathsToMove = [physical];
    } else if (logical) {
        pathsToMove = [logical];
    }
    
    if (pathsToMove.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      
      if (logical && dragged && dragged.id === logical && dragged.category === node.data.name) {
          return;
      }
      
      void moveLogicalNode(pathsToMove, node.data.name);
    }
  };

  const run = async (action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true; setError("");
    try { await action(); } catch (cause) { setError(String(cause)); }
    finally { busy.current = false; }
  };

  const menu = (name: string | null, child: React.ReactElement, filePath?: string, directory = false, missing = false) => (
    <ContextMenu.Root key={name ?? "root"}>
      <ContextMenu.Trigger asChild disabled={!rootPath} onContextMenu={event => {
        event.stopPropagation();
        if (!rootPath) event.preventDefault();
      }}>{child}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="ide-menu w-52 text-xs" collisionPadding={8} aria-label="逻辑分类操作"
          onCloseAutoFocus={event => { if (dialogFromMenu.current) { event.preventDefault(); dialogFromMenu.current = false; } }}>
          {!filePath && <ContextMenu.Item className="ide-menu-item" disabled={!rootPath} onSelect={() => { dialogFromMenu.current = true; setIsCreating(true); }}>新建分类...</ContextMenu.Item>}
          {filePath && <ContextMenu.Item className="ide-menu-item" disabled={missing || isRemotePath(filePath)} onSelect={() => void run(async () => {
            if (directory) await openPath(filePath);
            else await revealItemInDir(filePath);
          })}>打开所在目录</ContextMenu.Item>}
          {filePath && <ContextMenu.Item className="ide-menu-item" disabled={missing || isRemotePath(filePath)} onSelect={() => void run(async () => {
            await flushPendingWrites(); await fsApi.writeFileClipboard([filePath], false);
          })}>复制 <span className="ml-auto text-gray-500">Ctrl+C</span></ContextMenu.Item>}
          {filePath && name !== null && <ContextMenu.Item className="ide-menu-item" onSelect={() => void run(async () => {
            dialogFromMenu.current = true;
            if (!await confirmDelete({ title: "取消关联", description: `仅移除该项在“${name}”中的关联，物理分区的文件及内容会保留。`, paths: [filePath], confirmLabel: "取消关联" })) return;
            await fsApi.removeLogicalFile(filePath, name);
            setHiddenFiles(await fsApi.getHiddenLogicalFiles());
            await fetchLogicalTree();
          })}>取消关联</ContextMenu.Item>}
          {name !== null && !filePath && <>
            <ContextMenu.Item className="ide-menu-item" disabled={!rootPath || isRemotePath(rootPath)} onSelect={() => void run(async () => {
              if (!rootPath) return;
              const cwd = await fsApi.prepareLogicalSandbox(rootPath, name);
              const { profiles, defaultProfileId, createSession } = useTerminalStore.getState();
              const profile = profiles.find(profile => profile.id === defaultProfileId) || profiles[0];
              if (!profile) throw new Error("请先配置终端");
              if (!await createSession(profile, cwd)) throw new Error(useTerminalStore.getState().launchError);
              useLayoutStore.getState().openBottomPanel("terminal");
            })}>打开所在目录（终端）</ContextMenu.Item>
            <ContextMenu.Separator className="h-px my-1 bg-ide-panel-border" />
            <ContextMenu.Item className="ide-menu-item" onSelect={() => { dialogFromMenu.current = true; setRename(name); }}>重命名...</ContextMenu.Item>
            <ContextMenu.Item className="ide-menu-item" onSelect={() => void run(async () => {
              dialogFromMenu.current = true;
              if (!await confirmDelete({ title: "删除逻辑分类", description: "仅移除分类及文件关联，磁盘中的实际文件会保留。", paths: [name] })) return;
              await fsApi.editLogicalFolder(name, null);
              await fetchLogicalTree();
            })}>删除...</ContextMenu.Item>
          </>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );

  return menu(null, (
    <div tabIndex={0} onKeyDown={openContextMenuFromKeyboard} className="explorer-tree flex flex-col h-full">
      {confirmationDialog}
      {error && <p role="alert" className="px-2 py-1 text-xs text-red-400">{error}</p>}
      {rename !== null && rootPath && <CreateNameDialog
        key={`${rootPath}:${rename}`}
        title="重命名"
        description="修改分类名称，保留其文件关联。"
        label="分类名称" initialName={rename}
        validate={name => logicalTreeData.some(node => node.name !== rename && node.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ? "该分类已存在。" : undefined}
        onCreate={async name => { if (name === rename) return; await fsApi.editLogicalFolder(rename, name); await fetchLogicalTree(); }}
        onClose={() => setRename(null)}
      />}

      {isCreating && rootPath && (
        <CreateNameDialog
          key={rootPath}
          title="新建逻辑分类"
          description="在当前项目中创建逻辑分类。"
          label="分类名称"
          validate={name => logicalTreeData.some(node => node.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ? "该分类已存在，请使用其他名称。" : undefined}
          onCreate={createLogicalFolder}
          onClose={() => setIsCreating(false)}
        />
      )}

      <div ref={containerRef} tabIndex={0} onKeyDown={event => {
        openContextMenuFromKeyboard(event);
        if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "c") {
          const paths = (treeRef.current?.selectedNodes ?? []).filter((node: any) => !node.data.missing && !node.data.id.startsWith("logical_") && !isRemotePath(node.data.id)).map((node: any) => node.data.id);
          if (paths.length) { event.preventDefault(); event.stopPropagation(); void run(async () => { await flushPendingWrites(); await fsApi.writeFileClipboard(paths, false); }); }
        }
      }} onKeyDownCapture={speedSearch.onKeyDownCapture} className="relative flex-1 w-full p-1 overflow-hidden">
        {speedSearch.searchBox}
        {height > 0 && logicalTreeData && logicalTreeData.length > 0 ? (
          <LogicalNodeContext.Provider value={({ node, style }) => {
            const row = (
              <div
                style={style}
                aria-disabled={node.data.missing || undefined}
                title={node.data.missing ? `${node.data.id}\n文件已不存在，可取消关联` : node.data.id}
                tabIndex={-1}
                onKeyDown={openContextMenuFromKeyboard}
                onContextMenu={() => node.select()}
                className={`flex items-center gap-1 px-1 text-sm cursor-default rounded-sm ${node.data.missing ? "text-gray-500 opacity-60" : ""} ${node.data.id.startsWith("logical_") && dragOverCategory === node.data.name ? "bg-sky-500/30 ring-1 ring-inset ring-sky-400/70" : node.isSelected ? "bg-ide-selection" : "hover:bg-ide-tree-hover"}`}
                onClick={event => selectTreeNode(event, node)}
                onDoubleClick={event => activateTreeFile(event, node)}
                draggable={!node.data.missing && !node.data.id.startsWith("logical_")}
                data-link-file={node.isLeaf && !node.data.missing ? node.data.id : undefined}
                onDragStart={e => handleDragStart(e, node)} onDragOver={e => handleDragOver(e, node)} onDrop={e => handleDrop(e, node)}
                onDragLeave={e => { if (e.currentTarget === e.target) setDragOverCategory(current => current === node.data.name ? null : current); }}
                onDragEnd={() => { draggedLogicalRef.current = null; setDragOverCategory(null); }}
              >
                <span className="w-4 flex justify-center">{!node.isLeaf && (node.isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}</span>
                {getIcon(node)}<span className="truncate ml-1">{speedSearch.highlight(node.data.name)}</span>
              </div>
            );
            if (node.data.id.startsWith("logical_")) return menu(node.data.name, row);
            const category = logicalTreeData.find(entry => node.id.startsWith(`${entry.id}:`));
            const isDirectChild = category && node.parent?.id === category.id;
            return menu(isDirectChild ? category.name : null, row, node.data.id, !node.isLeaf, node.data.missing);
          }}>
          <Tree
            {...speedSearch.treeSearchProps}
            ref={treeRef}
            onSelect={nodes => {
              const directories = nodes.filter(node => !node.isLeaf && !node.data.missing);
              useWorkspaceStore.getState().setPartitionSearchPaths(directories.length ? directories.flatMap(node => node.data.id.startsWith("logical_") ? (node.data.children ?? []).filter((entry: any) => !entry.missing).map((entry: any) => entry.id) : [node.data.id]) : null);
            }}
            onActivate={handleNodeClick}
            idAccessor="treeId"
            data={logicalTreeData.map(category => {
              const visible = (entry: any) => !hiddenFiles.some(([path, name]) => name === category.name && path === entry.id);
              const decorate = (entry: any): any => ({ ...entry, treeId: `${category.id}:${entry.id}`, children: entry.children?.filter(visible).map(decorate) });
              return { ...category, treeId: category.id, children: category.children?.filter(visible).map(decorate) };
            })}
            key={rootPath}
            {...treeOpenState}
            openByDefault={false}
            width={width}
            height={height}
            indent={16}
            rowHeight={24}
            padding={4}
            disableDrag
          >
            {LogicalTreeNode}
          </Tree>
          </LogicalNodeContext.Provider>
        ) : (
          <div className="p-4 text-xs text-gray-500 text-center">暂无逻辑分类。</div>
        )}
      </div>
    </div>
  ));
});
