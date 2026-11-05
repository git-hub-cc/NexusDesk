import { createContext, useContext, useEffect, useRef, useState, type DragEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, ChevronRight, FolderPlus, RefreshCw, X } from "lucide-react";
import { Tree, type NodeRendererProps } from "react-arborist";
import { FileIcon } from "@/components/explorer/FileIcon";
import { CreateNameDialog, validateEntryName } from "@/components/explorer/CreateNameDialog";
import { activateTreeFile, selectTreeNode } from "@/components/explorer/treeInteraction";
import { useDeleteConfirmation } from "@/components/explorer/useDeleteConfirmation";
import { isImage } from "@/lib/assets";
import { useElementSize } from "@/hooks/useElementSize";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { flushPendingWrites } from "@/store/workspaceStore";
import * as ContextMenu from "@/lib/nativeMenu";
import { ANDROID_FILE_TYPE, copyAndroidFiles, localDropPaths, pasteToAndroid, topLevelPaths, uploadLocalFiles } from "@/lib/androidTransfer";

type Entry = { name: string; path: string; is_dir: boolean };
type FileNode = Entry & { children?: FileNode[] };
type FileTreeActions = {
  disabled: boolean; serial: string; dropTarget: string | null;
  copy: (entries?: Entry[]) => void; paste: (directory?: string) => void;
  remove: (entries?: Entry[]) => void;
  dragOver: (event: DragEvent, directory: string) => void;
  drop: (event: DragEvent, directory: string) => void;
};
const FileTreeContext = createContext<FileTreeActions>(null!);
const parentDirectory = (path: string) => path.replace(/\/[^/]+\/?$/, "") || "/";

// Keep rows mounted when selection changes so both clicks reach the same element.
function AndroidFileNode({ node, style, dragHandle }: NodeRendererProps<FileNode>) {
  const { disabled, serial, dropTarget, copy, paste, remove, dragOver, drop } = useContext(FileTreeContext);
  const directory = node.data.is_dir ? node.id : parentDirectory(node.id);
  const selectedEntries = () => node.isSelected ? node.tree.selectedNodes.map(entry => entry.data) : [node.data];
  return <ContextMenu.Root><ContextMenu.Trigger asChild><div ref={dragHandle} style={style} title={node.id}
    draggable={!disabled} onDragStart={event => {
      event.stopPropagation();
      event.dataTransfer.setData(ANDROID_FILE_TYPE, JSON.stringify({ serial, paths: selectedEntries().map(entry => entry.path) }));
      event.dataTransfer.effectAllowed = "copy";
      if (!node.isSelected) node.select();
    }} onDragOver={event => dragOver(event, directory)} onDrop={event => drop(event, directory)}
    onContextMenu={event => { event.stopPropagation(); if (!node.isSelected) node.select(); }}
    onClick={event => { if (!disabled) selectTreeNode(event, node); }}
    onDoubleClick={event => { if (!disabled) activateTreeFile(event, node); }}
    className={`flex h-full items-center gap-1 px-2 ${dropTarget === directory ? "bg-sky-500/30 ring-1 ring-inset ring-sky-400/70" : node.isSelected ? "bg-ide-tab-active-bg" : "hover:bg-ide-tab-hover"}`}>
    {node.data.is_dir ? <button aria-label={node.isOpen ? "折叠目录" : "展开目录"} aria-expanded={node.isOpen} disabled={disabled} onClick={event => { event.stopPropagation(); node.select(); node.toggle(); }}><ChevronRight size={13} className={node.isOpen ? "rotate-90" : ""} /></button> : <span className="w-[13px] shrink-0" />}<FileIcon name={node.data.name} directory={node.data.is_dir} open={node.isOpen} /><span className="truncate">{node.data.name}</span>
  </div></ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Content className="ide-menu w-48 text-xs">
    <ContextMenu.Item className="ide-menu-item" disabled={disabled} onSelect={() => copy(selectedEntries())}>复制 <span className="ml-auto text-gray-500">Ctrl+C</span></ContextMenu.Item>
    <ContextMenu.Item className="ide-menu-item" disabled={disabled} onSelect={() => paste(directory)}>粘贴 <span className="ml-auto text-gray-500">Ctrl+V</span></ContextMenu.Item>
    <ContextMenu.Item className="ide-menu-item" disabled={disabled} onSelect={() => remove(selectedEntries())}>删除 <span className="ml-auto text-gray-500">Delete</span></ContextMenu.Item>
  </ContextMenu.Content></ContextMenu.Portal></ContextMenu.Root>;
}

export function AndroidFileManager({ serial, onClose }: { serial: string; onClose: () => void }) {
  const [path, setPath] = useState("/sdcard");
  const [input, setInput] = useState(path);
  const [directories, setDirectories] = useState<Record<string, Entry[]>>({});
  const [selection, setSelection] = useState<Entry[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [container, size] = useElementSize<HTMLDivElement>();
  const generation = useRef(0);
  const alive = useRef(true);
  const operationBusy = useRef(false);
  const { confirmDelete, confirmationDialog } = useDeleteConfirmation(serial);

  const browse = async (target: string) => {
    const request = ++generation.current; setLoading(true); setError("");
    try {
      const entries = await invoke<Entry[]>("mirror_list_files", { serial, path: target });
      if (!alive.current || request !== generation.current) return;
      setPath(target); setInput(target); setDirectories({ [target]: entries }); setSelection([]);
    } catch (reason) { if (alive.current && request === generation.current) setError(String(reason)); }
    finally { if (alive.current && request === generation.current) setLoading(false); }
  };
  useEffect(() => { alive.current = true; void browse("/sdcard"); return () => { alive.current = false; generation.current++; }; }, [serial]);
  const expand = async (target: string) => {
    if (directories[target]) return;
    try { const entries = await invoke<Entry[]>("mirror_list_files", { serial, path: target }); if (alive.current) setDirectories(previous => ({ ...previous, [target]: entries })); }
    catch (reason) { if (alive.current) setError(String(reason)); }
  };
  const run = async (action: () => Promise<void>) => {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy("处理中…"); setError(""); setMessage("");
    try { await action(); } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { operationBusy.current = false; if (alive.current) setBusy(""); }
  };
  const selected = selection[0];
  const targetDirectory = selected ? (selected.is_dir ? selected.path : parentDirectory(selected.path)) : path;
  const refreshDirectory = async (directory: string) => {
    const entries = await invoke<Entry[]>("mirror_list_files", { serial, path: directory });
    if (alive.current) setDirectories(previous => ({ ...previous, [directory]: entries }));
  };
  const createFolderFromDialog = async (name: string) => {
    if (operationBusy.current) throw new Error("Operation in progress");
    operationBusy.current = true;
    setBusy("Processing..."); setError(""); setMessage("");
    try {
      await invoke("mirror_create_folder", { serial, parent: path, name });
      await refreshDirectory(path);
      if (alive.current) setMessage(`Created folder ${name}`);
    } finally {
      operationBusy.current = false;
      if (alive.current) setBusy("");
    }
  };
  const createFolderInline = (event: React.FormEvent) => {
    event.preventDefault();
    const name = folderName.trim();
    if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
      setError("请输入有效的文件夹名称");
      return;
    }
    void run(async () => {
      await invoke("mirror_create_folder", { serial, parent: path, name });
      setCreatingFolder(false);
      setFolderName("");
      setMessage(`已创建文件夹 ${name}`);
      await refreshDirectory(path);
    });
  };
  const copy = (entries = selection) => { if (entries.length) void run(async () => {
    await copyAndroidFiles({ serial, paths: entries.map(entry => entry.path) });
    if (alive.current) setMessage(`已复制 ${entries.length} 个项目，可在本地文件树粘贴下载`);
  }); };
  const paste = (directory = targetDirectory) => run(async () => {
    await flushPendingWrites();
    try {
      const count = await pasteToAndroid(serial, directory);
      if (alive.current) setMessage(`已传输 ${count} 个项目`);
    } finally { await refreshDirectory(directory); }
  });
  const remove = (entries = selection) => { if (entries.length) void run(async () => {
    const paths = topLevelPaths(entries.map(entry => entry.path));
    if (!await confirmDelete({ title: "删除手机文件", description: `即将永久删除选中的 ${paths.length} 个项目及其全部内容，无法撤销。`, paths, permanent: true })) return;
    try {
      await invoke("mirror_delete_files", { serial, paths });
      if (alive.current) setMessage(`已删除 ${paths.length} 个项目`);
    } finally {
      if (alive.current) {
        setSelection([]);
        setDirectories(previous => Object.fromEntries(Object.entries(previous).filter(([directory]) => !paths.some(deleted => directory === deleted || directory.startsWith(deleted + "/")))));
        await Promise.all([...new Set(paths.map(parentDirectory))].map(refreshDirectory));
      }
    }
  }); };
  const dragOver = (event: DragEvent, directory: string) => {
    if (!event.dataTransfer.types.some(type => ["application/x-noteide-file", "application/x-noteide-files", "application/x-noteide-logical-file"].includes(type))) return;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (!disabled) setDropTarget(directory);
  };
  const drop = (event: DragEvent, directory: string) => {
    event.preventDefault(); event.stopPropagation(); setDropTarget(null);
    if (disabled) return;
    void run(async () => {
      const paths = localDropPaths(event.dataTransfer);
      if (!paths.length) return;
      await flushPendingWrites();
      try { await uploadLocalFiles(serial, paths, directory); if (alive.current) setMessage(`已上传 ${paths.length} 个项目`); }
      finally { await refreshDirectory(directory); }
    });
  };
  const preview = (entry: Entry) => run(async () => {
    const content = await invoke<string>(isImage(entry.path) && !/\.svg$/i.test(entry.path) ? "mirror_read_image" : "mirror_read_file", { serial, path: entry.path });
    if (!alive.current) return;
    useWorkspaceStore.getState().openTab({ id: `android:${serial}:${entry.path}`, path: `android://${serial}${entry.path}`, title: entry.name, content, readOnly: true, isExternal: true });
    setMessage(`已在编辑区预览 ${entry.name}`);
  });
  const nodes = (directory: string): FileNode[] => (directories[directory] ?? []).map(entry => ({ ...entry, ...(entry.is_dir ? { children: nodes(entry.path) } : {}) }));
  const disabled = loading || !!busy;
  return <aside aria-label="手机文件管理" className="flex h-full w-80 max-w-[55%] shrink-0 flex-col border-l border-ide-panel-border bg-ide-bg text-xs">
    {confirmationDialog}
    {creatingFolder && <CreateNameDialog key={`${serial}:${path}:folder`} title="新建文件夹" description={`位置：${path}`} label="文件夹名称" validate={validateEntryName} onCreate={createFolderFromDialog} onClose={() => setCreatingFolder(false)} />}
    <div className="flex items-center gap-2 border-b border-ide-panel-border p-2"><span className="flex-1 font-medium">文件管理</span><button title="关闭文件管理" aria-label="关闭文件管理" onClick={onClose}><X size={14} /></button></div>
    <form className="flex gap-1 p-2" onSubmit={event => { event.preventDefault(); if (!disabled) void browse(input.trim().replace(/\/+$/, "") || "/"); }}>
      <button type="button" title="上级目录" aria-label="上级目录" disabled={disabled || path === "/"} onClick={() => void browse(path.replace(/\/[^/]+\/?$/, "") || "/")}><ArrowUp size={14} /></button>
      <input aria-label="手机目录路径" className="min-w-0 flex-1 rounded border border-ide-panel-border bg-ide-bg px-1 py-1" value={input} disabled={disabled} onChange={event => setInput(event.target.value)} />
      <button type="submit" disabled={disabled}>打开</button><button type="button" title="刷新目录" aria-label="刷新目录" disabled={disabled} onClick={() => void browse(path)}><RefreshCw size={14} className={loading ? "animate-spin" : ""} /></button>
      <button type="button" title="新建文件夹" aria-label="新建文件夹" disabled={disabled} onClick={() => { setCreatingFolder(true); setFolderName(""); setError(""); }}><FolderPlus size={14} /></button>
    </form>
    {false && creatingFolder && <form className="flex gap-1 px-2 pb-2" onSubmit={createFolderInline}>
      <input autoFocus aria-label="文件夹名称" className="min-w-0 flex-1 rounded border border-ide-panel-border bg-ide-bg px-1 py-1" value={folderName} disabled={disabled} onChange={event => setFolderName(event.target.value)} />
      <button type="submit" disabled={disabled || !folderName.trim()}>创建</button>
      <button type="button" disabled={disabled} onClick={() => setCreatingFolder(false)}>取消</button>
    </form>}
    {error && <div role="alert" className="break-words p-2 text-red-400">{error}</div>}
    <div ref={container} tabIndex={0} className="min-h-0 flex-1 overflow-hidden outline-none" onDragOver={event => dragOver(event, path)} onDrop={event => drop(event, path)} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }} onKeyDown={event => { if (disabled) return; if (event.key === "Delete") { event.preventDefault(); event.stopPropagation(); remove(); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") { event.preventDefault(); event.stopPropagation(); copy(); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") { event.preventDefault(); event.stopPropagation(); void paste(); } }}>
      {size.height > 0 && <FileTreeContext.Provider value={{ disabled, serial, dropTarget, copy, remove, paste: directory => { void paste(directory); }, dragOver, drop }}><Tree<FileNode> data={nodes(path)} idAccessor="path" width={size.width} height={size.height} rowHeight={28} indent={16} openByDefault={false} disableDrag disableDrop disableEdit onSelect={selected => setSelection(selected.map(node => node.data))} onToggle={id => { void expand(id); }} onActivate={node => { if (!node.data.is_dir && !disabled) void preview(node.data); }}>
        {AndroidFileNode}
      </Tree></FileTreeContext.Provider>}
      {!loading && directories[path]?.length === 0 && <p className="p-2 text-gray-500">此目录为空</p>}
    </div>
    <div role="status" className="break-words border-t border-ide-panel-border p-2 text-gray-400">{busy || (loading ? "正在读取目录…" : message || "双击打开；复制粘贴或拖拽文件可上传、下载")}</div>
  </aside>;
}
