import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import * as ContextMenu from "@/lib/nativeMenu";
import { ChevronRight, FileText, Folder } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { fsApi, type GraphCategory } from "@/lib/api";
import { buildReverseTree, countTreeGraphNames, parseTreeGraph, type TreeGraphNode } from "@/lib/treeGraph";
import { openContextMenuFromKeyboard } from "@/lib/contextMenu";
import { flushEditorContent, useWorkspaceStore } from "@/store/workspaceStore";
import { CreateNameDialog } from "@/components/explorer/CreateNameDialog";
import { useDeleteConfirmation } from "@/components/explorer/useDeleteConfirmation";
import { matchTreeName, useNameSpeedSearch } from "@/components/explorer/useTreeSpeedSearch";

const filename = (path: string) => path.split(/[\\/]/).pop() || path;
const dragTypes = ["application/x-nexusdesk-file", "application/x-nexusdesk-files", "application/x-nexusdesk-logical-file"];
const categoryColors = [
  { name: "蓝色", value: "#60a5fa" },
  { name: "绿色", value: "#4ade80" },
  { name: "黄色", value: "#facc15" },
  { name: "橙色", value: "#fb923c" },
  { name: "红色", value: "#f87171" },
  { name: "紫色", value: "#c084fc" },
  { name: "粉色", value: "#f472b6" },
];

function containsLine(node: TreeGraphNode, line: number): boolean {
  return node.id + 1 === line || node.children.some(child => containsLine(child, line));
}

function TreeNode({ node, onLocate, location, counts, onContextNode }: { node: TreeGraphNode; onLocate: (line: number) => void; location: { line: number } | null; counts: Map<string, number>; onContextNode: (name: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const target = useRef<HTMLButtonElement>(null);
  const selected = location?.line === node.id + 1;
  useEffect(() => {
    if (location && node.children.some(child => containsLine(child, location.line))) setExpanded(true);
    if (selected) target.current?.scrollIntoView({ block: "nearest" });
  }, [location, node, selected]);
  return <div>
    <div className={`flex items-center hover:bg-ide-tree-hover rounded-sm ${selected ? "bg-ide-selection text-white" : ""}`}>
      {node.children.length ? <button type="button" className="p-1 shrink-0" aria-label={`${expanded ? "折叠" : "展开"} ${node.name}`} aria-expanded={expanded} onClick={event => { if (event.detail < 2) setExpanded(value => !value); }}><ChevronRight size={12} className={expanded ? "rotate-90" : ""} /></button> : <span className="w-5 shrink-0" />}
      <button ref={target} type="button" data-graph-node={node.name} className="text-left truncate py-0.5 min-w-0 flex-1 flex items-center gap-1" title={`${node.name} · 单击展开，双击定位`} aria-expanded={node.children.length ? expanded : undefined} onContextMenu={() => onContextNode(node.name)} onClick={event => { if (event.detail < 2) setExpanded(value => !value); }} onDoubleClick={() => onLocate(node.id + 1)}><span className="truncate">{node.name}</span>{(counts.get(node.name) ?? 0) > 1 && <span className="shrink-0 text-[10px] text-amber-300">×{counts.get(node.name)}</span>}</button>
    </div>
    {expanded && <div className="ml-2 pl-2 border-l border-ide-panel-border">{node.children.map(child => <TreeNode key={child.id} node={child} onLocate={onLocate} location={location} counts={counts} onContextNode={onContextNode} />)}</div>}
  </div>;
}

function TreeFile({ path, root, missing, counts, onContextNode, selected, label, searchRef }: { path: string; root: string; missing: boolean; counts: Map<string, number>; onContextNode: (name: string) => void; selected?: boolean; label?: ReactNode; searchRef?: (element: HTMLButtonElement | null) => void }) {
  const revision = useWorkspaceStore(state => state.indexRevision);
  const graphLocation = useWorkspaceStore(state => state.graphLocation);
  const location = graphLocation?.path === path ? graphLocation : null;
  useEffect(() => { if (location && !missing) setExpanded(true); }, [location, missing]);
  const buffer = useWorkspaceStore(state => [...state.leftTabs, ...state.rightTabs].find(tab => tab.path === path && !tab.revision && tab.diff === undefined)?.content);
  const [nodes, setNodes] = useState<TreeGraphNode[] | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded || missing) return;
    let live = true;
    setError(""); setNodes(null);
    (buffer !== undefined ? Promise.resolve(buffer) : fsApi.readFile(path))
      .then(content => { if (live) setNodes(parseTreeGraph(content)); })
      .catch(cause => { if (live) setError("读取图谱失败：" + String(cause)); });
    return () => { live = false; };
  }, [path, revision, buffer, expanded, missing]);
  const open = async (line?: number) => {
    if (missing) return;
    try {
      flushEditorContent();
      const state = useWorkspaceStore.getState();
      const existing = [...state.leftTabs, ...state.rightTabs].find(tab => tab.path === path && !tab.revision && tab.diff === undefined);
      const content = existing?.content ?? await fsApi.readFile(path);
      if (useWorkspaceStore.getState().rootPath !== root) return;
      useWorkspaceStore.getState().openTab({ id: path, path, title: filename(path), content, markdownMode: existing?.markdownMode });
      useWorkspaceStore.getState().locateGraph(path, line ?? 1, useWorkspaceStore.getState().focusedPane);
    } catch (cause) { setError("打开文件失败：" + String(cause)); }
  };
  return <div className="ml-4" data-graph-file={path}>
    <div className={`flex items-center rounded-sm ${selected ? "bg-ide-selection text-white" : "hover:bg-ide-tree-hover"} ${missing ? "text-gray-500 opacity-60" : ""}`}>
      <button disabled={missing} type="button" aria-label={`${expanded ? "折叠" : "展开"} ${filename(path)}`} aria-expanded={expanded} className="p-1" onClick={() => setExpanded(!expanded)}><ChevronRight size={14} className={expanded ? "rotate-90" : ""} /></button>
      <button ref={searchRef} type="button" aria-disabled={missing} title={missing ? `${path}\n文件已不存在，可取消关联` : path} aria-expanded={expanded && !missing} className="flex items-center gap-1 min-w-0 flex-1 text-left py-1" onClick={event => { if (!missing && event.detail < 2) setExpanded(previous => !previous); }} onDoubleClick={() => void open(1)}><FileText size={14} className="shrink-0" /><span className="truncate">{label ?? filename(path)}</span></button>
    </div>
    {expanded && !missing && <div className="ml-3 border-l border-ide-panel-border pl-2">
      {error ? <p role="alert" className="text-red-400 break-words">{error}</p> : nodes === null ? <p className="text-gray-500 p-1">正在加载…</p> : nodes.length ? nodes.map(node => <TreeNode key={node.id} node={node} onLocate={line => void open(line)} location={location} counts={counts} onContextNode={onContextNode} />) : <p className="text-gray-500 p-1">暂无图谱节点。</p>}
    </div>}
    {!missing && !expanded && error && <p role="alert" className="text-red-400 break-words">{error}</p>}
  </div>;
}

export function GraphView() {
  const root = useWorkspaceStore(state => state.rootPath);
  const graphLocation = useWorkspaceStore(state => state.graphLocation);
  const locateSignal = useWorkspaceStore(state => state.locateSignal);
  const focusedPane = useWorkspaceStore(state => state.focusedPane);
  const leftTabs = useWorkspaceStore(state => state.leftTabs);
  const rightTabs = useWorkspaceStore(state => state.rightTabs);
  const revision = useWorkspaceStore(state => state.indexRevision);
  const [categories, setCategories] = useState<GraphCategory[]>([]);
  const [treeContents, setTreeContents] = useState<Map<string, string>>(new Map());
  const [nodeCounts, setNodeCounts] = useState<Map<string, number>>(new Map());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [hovered, setHovered] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const initializedFolders = useRef(false);
  const [contextCategory, setContextCategory] = useState<string | null>(null);
  const [contextFile, setContextFile] = useState<string | null>(null);
  const [contextNode, setContextNode] = useState<string | null>(null);
  const [locatedPath, setLocatedPath] = useState<string | null>(null);
  const [rename, setRename] = useState<GraphCategory | null>(null);
  const { confirmDelete, confirmationDialog } = useDeleteConfirmation(root);
  const busy = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchTargets = useRef(new Map<string, HTMLButtonElement>());
  const [searchSelected, setSearchSelected] = useState<string | null>(null);
  const categoryId = (name: string) => JSON.stringify([name]);
  const fileId = (name: string, path: string) => JSON.stringify([name, path]);
  const searchEntries = categories.flatMap(category => [
    { id: categoryId(category.name), name: category.name, category: category.name, file: false },
    ...category.files.map(path => ({ id: fileId(category.name, path), name: filename(path), category: category.name, file: true })),
  ]);
  const speedSearch = useNameSpeedSearch({
    label: "图谱目录快速搜索",
    entries: () => searchEntries,
    selectedId: () => searchSelected,
    select: id => {
      setSearchSelected(id);
      const entry = searchEntries.find(item => item.id === id);
      if (entry?.file) setCollapsed(previous => {
        if (!previous.has(entry.category)) return previous;
        const next = new Set(previous); next.delete(entry.category); return next;
      });
    },
    activate: id => {
      const target = searchTargets.current.get(id);
      if (searchEntries.find(entry => entry.id === id)?.file) target?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      else target?.click();
    },
    focus: () => containerRef.current?.focus(),
  }, root);
  useEffect(() => { searchTargets.current.get(searchSelected ?? "")?.scrollIntoView({ block: "nearest" }); }, [searchSelected, collapsed]);
  useEffect(() => { setSearchSelected(null); }, [root]);
  const registerSearchTarget = (id: string, element: HTMLButtonElement | null) => {
    if (element) searchTargets.current.set(id, element);
    else searchTargets.current.delete(id);
  };
  const filteredCategories = speedSearch.filterTerm ? categories.filter(category =>
    matchTreeName(category.name, speedSearch.filterTerm) || category.files.some(path => matchTreeName(filename(path), speedSearch.filterTerm))) : categories;
  useEffect(() => {
    if (!graphLocation) return;
    setCollapsed(previous => {
      const next = new Set(previous);
      categories.filter(category => category.files.includes(graphLocation.path)).forEach(category => next.delete(category.name));
      return next;
    });
  }, [graphLocation, categories]);
  useEffect(() => {
    if (!locateSignal || !categories.length) return;
    const tabs = focusedPane === "left" ? leftTabs : rightTabs;
    const activeId = focusedPane === "left" ? useWorkspaceStore.getState().activeLeftTabId : useWorkspaceStore.getState().activeRightTabId;
    const path = tabs.find(tab => tab.id === activeId)?.path;
    if (!path) return;
    const category = categories.find(item => item.files.some(file => file.toLocaleLowerCase() === path.toLocaleLowerCase()));
    // A locate signal is shared by the explorers. Ignore files outside graph
    // categories so opening a regular file does not force the sidebar away
    // from the graph partition.
    if (!category) return;
    setLocatedPath(path);
    setCollapsed(previous => { const next = new Set(previous); next.delete(category.name); return next; });
  }, [locateSignal, categories, focusedPane, leftTabs, rightTabs]);
  const selectedCategory = categories.find(category => category.name === contextCategory);
  const dialogFromMenu = useRef(false);
  const request = useRef(0);
  const refresh = async () => {
    const id = ++request.current;
    const data = await fsApi.getGraphCategories();
    const paths = [...new Set(data.flatMap(category => category.files.filter(path => !category.missingFiles.includes(path))))];
    const results = await Promise.allSettled(paths.map(async path => {
      const buffered = [...useWorkspaceStore.getState().leftTabs, ...useWorkspaceStore.getState().rightTabs].find(tab => tab.path === path && !tab.revision && tab.diff === undefined)?.content;
      return [path, buffered ?? await fsApi.readFile(path)] as const;
    }));
    if (id === request.current && useWorkspaceStore.getState().rootPath === root) {
      const entries = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      const failures = results.flatMap((result, index) => result.status === "rejected" ? [`${paths[index]}: ${String(result.reason)}`] : []);
      setError(failures.join("\n"));
      setCategories(data);
      if (!initializedFolders.current) {
        setCollapsed(new Set(data.map(category => category.name)));
        initializedFolders.current = true;
      }
      setTreeContents(new Map(entries));
      setNodeCounts(countTreeGraphNames(entries.map(([path, content]) => ({ path, content }))));
    }
  };
  useEffect(() => {
    setCategories([]); setTreeContents(new Map()); setNodeCounts(new Map()); setCreating(false); setRename(null); setContextFile(null); setContextCategory(null); setContextNode(null); setError(""); setHovered(null); setCollapsed(new Set()); initializedFolders.current = false;
    return () => { request.current++; };
  }, [root]);

  useEffect(() => {
    const receive = () => { if (root) void refresh().catch(cause => setError(String(cause))); };
    receive();
    window.addEventListener("nexusdesk:files-moved", receive);
    return () => window.removeEventListener("nexusdesk:files-moved", receive);
  }, [root, revision]);

  const link = async (name: string, paths: string[]) => {
    setError("");
    try {
      if (!paths.length || paths.some(path => !/\.tree$/i.test(path))) throw new Error("图谱分类仅接受 .tree 文件");
      await fsApi.linkGraphFiles(name, paths);
      if (useWorkspaceStore.getState().rootPath !== root) return;
      setCollapsed(previous => { const next = new Set(previous); next.delete(name); return next; });
      await refresh();
    } catch (cause) { if (useWorkspaceStore.getState().rootPath === root) setError(String(cause)); }
  };
  const drop = (event: DragEvent, name: string) => {
    event.preventDefault(); event.stopPropagation(); setHovered(null);
    try {
      const multiple = event.dataTransfer.getData("application/x-nexusdesk-files");
      const single = event.dataTransfer.getData("application/x-nexusdesk-file") || event.dataTransfer.getData("application/x-nexusdesk-logical-file");
      const paths: unknown = multiple ? JSON.parse(multiple) : single ? [single] : [];
      if (!Array.isArray(paths) || !paths.every(path => typeof path === "string")) throw new Error("无效的文件拖拽数据");
      void link(name, paths);
    } catch (cause) { setError(String(cause)); }
  };

  useEffect(() => {
    const receive = (event: Event) => {
      const { category, paths } = (event as CustomEvent<{ category?: string; paths: string[] }>).detail;
      if (category) void link(category, paths);
      else setError("请将 .tree 文件拖入图谱分类，不能放在根目录。");
    };
    window.addEventListener("nexusdesk-graph-drop", receive);
    return () => window.removeEventListener("nexusdesk-graph-drop", receive);
  }, [root]);

  const setCategoryColor = (name: string, color: string) => {
    void fsApi.setGraphCategoryColor(name, color).then(async () => { await refresh(); window.dispatchEvent(new Event("nexusdesk:graph-colors")); }).catch(cause => setError(String(cause)));
  };

  const openReverseTree = (name: string) => {
    const reverseTree = buildReverseTree(name, [...treeContents].map(([path, content]) => ({ path, content })));
    useWorkspaceStore.getState().openTab({ id: `reverse-tree:${root}:${name}:${Date.now()}`, path: `reverse-tree:${name}`, title: `反向树 · ${name}`, content: "", reverseTree, markdownMode: "preview" });
  };

  const remove = async (category: GraphCategory, path: string | null) => {
    if (busy.current) return;
    busy.current = true;
    dialogFromMenu.current = true;
    setError("");
    try {
      const confirmed = await confirmDelete(path
        ? { title: "取消关联", description: `仅移除该文件在“${category.name}”中的关联，物理文件及内容会保留。`, paths: [path], confirmLabel: "取消关联" }
        : { title: "删除图谱分类", description: "删除分类及其文件关联，磁盘中的实际文件会保留。", paths: [category.name] });
      if (!confirmed || useWorkspaceStore.getState().rootPath !== root) return;
      if (path) await fsApi.removeGraphFile(category.name, path);
      else await fsApi.editGraphCategory(category.name, null);
      await refresh();
    } catch (cause) { if (useWorkspaceStore.getState().rootPath === root) setError(String(cause)); }
    finally { busy.current = false; }
  };

  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild disabled={!root} onContextMenu={event => {
      if (!root) event.preventDefault();
      setContextCategory((event.target as HTMLElement).closest<HTMLElement>("[data-graph-category]")?.dataset.graphCategory ?? null);
      setContextFile((event.target as HTMLElement).closest<HTMLElement>("[data-graph-file]")?.dataset.graphFile ?? null);
      setContextNode((event.target as HTMLElement).closest<HTMLElement>("[data-graph-node]")?.dataset.graphNode ?? null);
    }}>
      <div ref={containerRef} data-graph-root tabIndex={0} onKeyDown={openContextMenuFromKeyboard} onKeyDownCapture={speedSearch.onKeyDownCapture} className="relative flex flex-col h-full overflow-hidden text-xs"
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "none"; }}
        onDrop={event => { event.preventDefault(); event.stopPropagation(); if (root) setError("请将 .tree 文件拖入图谱分类，不能放在根目录。"); }}>
        {speedSearch.searchBox}
        <div className="flex-1 min-h-0 overflow-auto p-1">
        {error && <p role="alert" className="text-red-400 break-words px-2 py-1">{error}</p>}
        {!root || !categories.length ? <p className="p-4 text-gray-500 text-center">暂无图谱分类。</p> : filteredCategories.map(category => <div key={category.name} data-graph-category={category.name}
          onDragOver={event => { if (dragTypes.some(type => event.dataTransfer.types.includes(type))) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "link"; setHovered(category.name); } }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovered(null); }}
          onDrop={event => drop(event, category.name)}
          >
          <div className="flex items-center"><button ref={element => registerSearchTarget(categoryId(category.name), element)} type="button" className={`flex items-center gap-1 flex-1 min-w-0 text-left px-1 py-1 rounded-sm ${!!speedSearch.searchBox && searchSelected === categoryId(category.name) ? "bg-ide-selection text-white" : ""} ${hovered === category.name ? "bg-sky-500/30 ring-1 ring-inset ring-sky-400/70" : "hover:bg-ide-tree-hover"}`} aria-expanded={!!speedSearch.filterTerm || !collapsed.has(category.name)} onClick={() => { useWorkspaceStore.getState().setPartitionSearchPaths(category.files.filter(path => !category.missingFiles.includes(path))); setCollapsed(previous => { const next = new Set(previous); if (next.has(category.name)) next.delete(category.name); else next.add(category.name); return next; }); }}>
            <ChevronRight size={14} className={`shrink-0 ${!speedSearch.filterTerm && collapsed.has(category.name) ? "" : "rotate-90"}`} /><Folder size={14} className="shrink-0" style={{ color: category.color ?? undefined }} /><span className="truncate">{speedSearch.highlight(category.name)}</span>
          </button>
          </div>
          {(!!speedSearch.filterTerm || !collapsed.has(category.name)) && category.files.filter(path => !speedSearch.filterTerm || matchTreeName(category.name, speedSearch.filterTerm) || matchTreeName(filename(path), speedSearch.filterTerm)).map(path => <TreeFile key={path} path={path} root={root} missing={category.missingFiles.includes(path)} counts={nodeCounts} onContextNode={setContextNode} label={speedSearch.highlight(filename(path))} searchRef={element => registerSearchTarget(fileId(category.name, path), element)} selected={(!!speedSearch.searchBox && searchSelected === fileId(category.name, path)) || locatedPath?.toLocaleLowerCase() === path.toLocaleLowerCase()} />)}
        </div>)}
        {!!categories.length && !filteredCategories.length && <p className="p-4 text-gray-500 text-center">无匹配目录或文件。</p>}
        </div>
      </div>
    </ContextMenu.Trigger>
    <ContextMenu.Portal><ContextMenu.Content className="ide-menu w-52 text-xs" collisionPadding={8} aria-label="图谱分类操作" onCloseAutoFocus={event => { if (dialogFromMenu.current) { event.preventDefault(); dialogFromMenu.current = false; } }}>
      {!contextFile && <ContextMenu.Item className="ide-menu-item" onSelect={() => { dialogFromMenu.current = true; setCreating(true); }}>新建分类...</ContextMenu.Item>}
      {contextFile && <ContextMenu.Item className="ide-menu-item" onSelect={() => { void revealItemInDir(contextFile).catch(cause => setError(String(cause))); }}>打开文件所在目录</ContextMenu.Item>}
      {selectedCategory && <>
        {!contextFile && <ContextMenu.Separator className="h-px my-1 bg-ide-panel-border" />}
        {contextFile ? <ContextMenu.Item className="ide-menu-item" onSelect={() => void remove(selectedCategory, contextFile)}>取消关联...</ContextMenu.Item> : <>
          <ContextMenu.Item className="ide-menu-item" onSelect={() => { dialogFromMenu.current = true; setRename(selectedCategory); }}>重命名...</ContextMenu.Item>
          <ContextMenu.Item className="ide-menu-item" onSelect={() => void remove(selectedCategory, null)}>删除...</ContextMenu.Item>
        </>}
      </>}
      {contextNode && (nodeCounts.get(contextNode) ?? 0) > 1 && <ContextMenu.Item className="ide-menu-item" onSelect={() => openReverseTree(contextNode)}>查看反向生成树</ContextMenu.Item>}
      {selectedCategory && !contextFile && <ContextMenu.Sub>
        <ContextMenu.SubTrigger className="ide-menu-item">设置目录颜色<ChevronRight size={14} className="ml-auto" /></ContextMenu.SubTrigger>
        <ContextMenu.Portal><ContextMenu.SubContent className="ide-menu w-40 text-xs" collisionPadding={8}>
          {categoryColors.map(color => <ContextMenu.Item key={color.value} className="ide-menu-item" onSelect={() => setCategoryColor(selectedCategory.name, color.value)}>
            <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: color.value }} />{color.name}{selectedCategory.color === color.value && <span className="ml-auto">✓</span>}
          </ContextMenu.Item>)}
          <ContextMenu.Separator className="h-px my-1 bg-ide-panel-border" />
          <label className="ide-menu-item">自定义颜色<input type="color" aria-label={`${selectedCategory.name} 目录颜色`} className="ml-auto w-5 h-5 cursor-pointer bg-transparent" value={selectedCategory.color ?? "#60a5fa"} onChange={event => setCategoryColor(selectedCategory.name, event.target.value)} /></label>
        </ContextMenu.SubContent></ContextMenu.Portal>
      </ContextMenu.Sub>}
    </ContextMenu.Content></ContextMenu.Portal>
    {confirmationDialog}
    {rename && root && <CreateNameDialog key={`${root}:${rename.name}`} title="重命名图谱分类" description="修改分类名称，保留文件关联和目录颜色。" label="分类名称" initialName={rename.name}
      validate={name => categories.some(category => category.name !== rename.name && category.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ? "该分类已存在。" : undefined}
      onCreate={async name => {
        if (name === rename.name) return;
        if (rename.color) await fsApi.setGraphCategoryColor(name, rename.color);
        await fsApi.editGraphCategory(rename.name, name);
        setCollapsed(previous => { const next = new Set(previous); if (next.delete(rename.name)) next.add(name); return next; });
        await refresh();
        window.dispatchEvent(new Event("nexusdesk:graph-colors"));
      }} onClose={() => setRename(null)} />}
    {creating && root && <CreateNameDialog key={root} title="新建图谱分类" description="在当前项目中创建图谱分类，拖入 .tree 文件建立关联。" label="分类名称" validate={name => categories.some(category => category.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ? "该分类已存在。" : undefined} onCreate={async name => { await fsApi.createGraphCategory(name); await refresh(); }} onClose={() => setCreating(false)} />}
  </ContextMenu.Root>;
}
