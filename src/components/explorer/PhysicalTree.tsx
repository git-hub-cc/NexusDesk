import { isSnapshot } from "@/lib/snapshot";
import { fileOperationHistory } from "@/lib/fileOperationHistory";
import { LocalHistoryDialog } from "@/components/editor/LocalHistoryDialog";
import { GitHistoryDialog } from "@/components/editor/GitHistoryDialog";
import { useDeleteConfirmation } from "./useDeleteConfirmation";
import { CreateNameDialog, validateEntryName } from "./CreateNameDialog";
import * as ContextMenu from "@/lib/nativeMenu";
import * as Dialog from "@radix-ui/react-dialog";
import React, { useState, useEffect, useRef } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Tree, type NodeRendererProps } from "react-arborist";
import { ChevronRight, ChevronDown, AlertTriangle, X, Square } from "lucide-react";
import { useWorkspaceStore, flushPendingWrites } from "@/store/workspaceStore";
import { useTerminalStore } from "@/store/terminalStore";
import { useLayoutStore } from "@/store/layoutStore";
import { fsApi, videoApi } from "@/lib/api";
import { documentExtension, isConvertibleDocument } from "@/lib/documentConverter";
import { useElementSize } from "@/hooks/useElementSize";
import { openContextMenuFromKeyboard } from "@/lib/contextMenu";

import { FileIcon } from "./FileIcon";
import { selectTreeNode, activateTreeFile } from "./treeInteraction";
import { useTreeSpeedSearch } from "./useTreeSpeedSearch";
import { useTreeOpenState } from "./useTreeOpenState";
import { treeStatusFor, statusLabels } from "@/lib/fileTreeAppearance";
import { isBinaryAsset, isImage, isVideo } from "@/lib/assets";
import { isRemotePath, remotePath, remoteUri } from "@/lib/remote";
import { ANDROID_FILE_TYPE, downloadAndroidFiles, parseAndroidFiles, readAndroidClipboard, type AndroidFiles } from "@/lib/androidTransfer";

type PhysicalNodeRenderer = (props: NodeRendererProps<any>) => React.ReactElement;
const PhysicalNodeContext = React.createContext<PhysicalNodeRenderer | null>(null);

// Keep the component type stable so selection updates do not unmount an open menu.
function PhysicalTreeNode(props: NodeRendererProps<any>) {
    const renderNode = React.useContext(PhysicalNodeContext);
    return renderNode ? renderNode(props) : null;
}

export const PhysicalTree: React.FC = React.memo(() => {
    const rootPath = useWorkspaceStore(state => state.rootPath);
    const setSearchScopePath = useWorkspaceStore(state => state.setSearchScopePath);
    const remote = isRemotePath(rootPath);
  const { confirmDelete, showDeletionBlocked, confirmationDialog } = useDeleteConfirmation(rootPath);
  const treeStatuses = useWorkspaceStore(state => state.treeStatuses);
  const fileTreeData = useWorkspaceStore(state => state.fileTreeData);
  const openTab = useWorkspaceStore(state => state.openTab);
  const movePhysicalEntry = useWorkspaceStore(state => state.movePhysicalEntry);
  const copyFileToPhysical = useWorkspaceStore(state => state.copyFileToPhysical);
  const createPhysicalFile = useWorkspaceStore(state => state.createPhysicalFile);
  const createPhysicalFolder = useWorkspaceStore(state => state.createPhysicalFolder);
  const loadDirectory = useWorkspaceStore(state => state.loadDirectory);
  const locateSignal = useWorkspaceStore(state => state.locateSignal);
  const activeLeftTabId = useWorkspaceStore(state => state.activeLeftTabId);
  const activeRightTabId = useWorkspaceStore(state => state.activeRightTabId);
  const focusedPane = useWorkspaceStore(state => state.focusedPane);
  const leftTabs = useWorkspaceStore(state => state.leftTabs);
  const rightTabs = useWorkspaceStore(state => state.rightTabs);
    const [containerRef, { width, height }] = useElementSize<HTMLDivElement>();
    const [isCreating, setIsCreating] = useState<"file" | "folder" | null>(null);
    const [targetDir, setTargetDir] = useState<string | null>(null);
    const [selectedDir, setSelectedDir] = useState<string | null>(null);
    const [selection, setSelection] = useState<{ path: string; file: boolean }[]>([]);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [pastedSelection, setPastedSelection] = useState<{ project: string; directory: string; paths: string[] } | null>(null);
    const [renamePath, setRenamePath] = useState<string | null>(null);
    const busy = useRef(false);
    const [converting, setConverting] = useState(false);
    const [convertingPath, setConvertingPath] = useState<string | null>(null);
    const [historyPath, setHistoryPath] = useState<string | null>(null);
    const [gitHistoryPath, setGitHistoryPath] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [dragOverPath, setDragOverPath] = useState<string | null>(null);
    const [codexInstalled, setCodexInstalled] = useState(false);
    const creatingFromMenu = useRef(false);
    const treeRef = useRef<any>(null);
    const speedSearch = useTreeSpeedSearch(treeRef, rootPath);
    const treeOpenState = useTreeOpenState(treeRef, rootPath, "physical", fileTreeData);
    const draggedPhysicalRef = useRef<string | null>(null);
    const parent = (path: string) => path.replace(/[/\\][^/\\]+$/, "").replace(/^([A-Za-z]:)$/, "$1/");

    useEffect(() => {
        if (!pastedSelection || pastedSelection.project !== rootPath) return;
        const normalize = (path: string) => path.replace(/\\/g, "/").toLowerCase();
        let attempts = 0;
        const timer = window.setInterval(() => {
            const tree = treeRef.current;
            tree?.get(pastedSelection.directory)?.open();
            const paths = new Set(pastedSelection.paths.map(normalize));
            const nodes = (tree?.visibleNodes ?? []).filter((node: any) => paths.has(normalize(node.id)));
            if (nodes.length === paths.size || ++attempts >= 20) {
                window.clearInterval(timer);
                if (nodes.length) {
                    const first = nodes[0].id;
                    tree.setSelection({ ids: nodes.map((node: any) => node.id), anchor: first, mostRecent: first });
                    tree.focus(first, { scroll: false });
                    void tree.scrollTo(first);
                    setSelectedPath(first);
                    setSelectedDir(nodes[0].isLeaf ? parent(first) : first);
                }
                setPastedSelection(null);
            }
        }, 50);
        return () => window.clearInterval(timer);
    }, [pastedSelection, rootPath]);

    // Command discovery can launch a shell; never put it on the menu-open path.
    useEffect(() => {
        let active = true;
        setCodexInstalled(false);
        if (rootPath && !remote) {
            void invoke("check_terminal_command", { command: "codex", cwd: rootPath }).then(
                () => { if (active) setCodexInstalled(true); },
                () => { if (active) setCodexInstalled(false); },
            );
        }
        return () => { active = false; };
    }, [rootPath, remote]);

    // 冲突处理状态
    const [conflictState, setConflictState] = useState<{
        type: "DIR" | "FILE";
        path: string;
        action: "move" | "copy";
        sourcePath: string;
        targetDir: string;
        opts: any;
        resolve: (opts: any) => void;
        reject: () => void;
    } | null>(null);

    useEffect(() => {
        fileOperationHistory.selectProject(rootPath);
        setSelection([]); setRenamePath(null); setHistoryPath(null);
        setSearchScopePath(null);
        setSelectedPath(null); setSelectedDir(null); setTargetDir(null); setIsCreating(null); setError("");
        setConflictState(null);
    }, [rootPath, setSearchScopePath]);

    useEffect(() => {
        if (locateSignal === 0 || !rootPath) return;
        const activeTabId = focusedPane === "left" ? activeLeftTabId : activeRightTabId;
        const tabs = focusedPane === "left" ? leftTabs : rightTabs;
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (!activeTab || !activeTab.path) return;

        const targetPath = activeTab.path;
        const targetDir = parent(targetPath);

        const expandParents = async () => {
            const ancestors: string[] = [];
            let curr = targetDir;
            const normalizedRoot = rootPath.replace(/\\/g, "/").toLowerCase();
            
            while (curr) {
                const normalizedCurr = curr.replace(/\\/g, "/").toLowerCase();
                if (!normalizedCurr.startsWith(normalizedRoot)) break;
                ancestors.unshift(curr);
                if (normalizedCurr === normalizedRoot) break;
                const next = parent(curr);
                if (next === curr) break;
                curr = next;
            }

            for (const dir of ancestors) {
                await loadDirectory(dir);
                treeRef.current?.open(dir);
            }

            const trySelect = (retries = 10) => {
                if (retries <= 0) return;
                setTimeout(() => {
                    const node = treeRef.current?.get(targetPath);
                    if (node) {
                        treeRef.current?.select(targetPath);
                        treeRef.current?.scrollTo(targetPath);
                        setSelectedPath(targetPath);
                        setSelectedDir(targetDir);
                    } else {
                        trySelect(retries - 1);
                    }
                }, 50);
            };
            trySelect();
        };

        void expandParents();
    }, [locateSignal]);

    const beginCreate = (kind: "file" | "folder", directory = selectedDir ?? rootPath) => {
        creatingFromMenu.current = true;
        setTargetDir(directory); setError(""); setIsCreating(kind);
    };
    const compare = async (path: string, source: string) => {
        setError("");
        if (!source || source === path) return;
        try {
            const read = async (file: string) => {
                const state = useWorkspaceStore.getState();
                const tab = [...state.leftTabs, ...state.rightTabs].find(tab => tab.path === file && tab.diff === undefined && !tab.revision);
                return tab?.content ?? await fsApi.readFile(file);
            };
            const [left, right] = await Promise.all([read(source), read(path)]);
            const diff = await fsApi.compareText(left, right);
            openTab({ id: `compare:${source}:${path}`, path, title: `${source.split(/[/\\]/).pop()} ↔ ${path.split(/[/\\]/).pop()}`, diff, diffLabels: [source, path] });
        } catch (error) { setError(`对比失败：${String(error)}`); }
    };

    const runOperation = async (action: () => Promise<void>) => {
        if (busy.current) return;
        busy.current = true; setError("");
        fileOperationHistory.beginGroup();
        try { await action(); } catch (error: any) { 
            const message = error instanceof Error ? error.message : String(error);
            if (message.startsWith("无法删除目录：")) showDeletionBlocked(message);
            else if (error?.message !== "CANCELLED") setError(String(error));
        }
        finally { fileOperationHistory.endGroup(); busy.current = false; }
    };

    const handleConvertToMd = (sourcePath: string) => runOperation(async () => {
        const project = rootPath;
        setConverting(true);
        try {
            const extension = documentExtension(sourcePath);
            const { convertDocumentToMarkdown } = await import("@/lib/documentConverter");
            const bytes = await fsApi.readBinaryFile(sourcePath);
            const name = sourcePath.split(/[/\\]/).pop()!.replace(/\.[^.]+$/, ".md");
            const directory = parent(sourcePath);
            const saveAsset = async (assetBytes: Uint8Array, assetName: string) => {
                const asset = await fsApi.importAsset(`${directory}/${name}`, { name: assetName, bytes: Array.from(assetBytes) });
                return `.asset/${encodeURIComponent(asset.split(/[/\\]/).pop()!)}`;
            };
            const content = await convertDocumentToMarkdown(new Uint8Array(bytes).buffer, extension, {
                saveImage: saveAsset,
                saveAsset,
            });
            // importFile creates exclusively and adds a suffix if the name already exists.
            const path = await fsApi.importFile(directory, name, Array.from(new TextEncoder().encode(content)));
            if (useWorkspaceStore.getState().rootPath !== project) return;
            await loadDirectory(directory, false, true);
            if (useWorkspaceStore.getState().rootPath !== project) return;
            treeRef.current?.get(directory)?.open();
            openTab({ id: path, title: path.split(/[/\\]/).pop()!, path, content, isDirty: false });
        } finally {
            setConverting(false);
        }
    });

    const handleConvertMkvToMp4 = (sourcePath: string) => runOperation(async () => {
        setConverting(true);
        setConvertingPath(sourcePath);
        try {
            await videoApi.convertMkvToMp4(sourcePath);
            await loadDirectory(parent(sourcePath), false, true);
            setError("");
        } finally {
            setConverting(false);
            setConvertingPath(null);
        }
    });

    const cancelConvertMkvToMp4 = async () => {
        if (!convertingPath) return;
        try { await videoApi.cancelMkvToMp4(convertingPath); }
        catch (error) { setError(String(error)); }
    };

    const handleTransferWithConflict = async (action: "move" | "copy", sourcePath: string, targetDir: string, initialOpts: any = {}) => {
        let currentOpts = { ...initialOpts };
        while (true) {
            try {
                if (action === "move") {
                    await movePhysicalEntry(sourcePath, targetDir, undefined, currentOpts);
                } else {
                    await copyFileToPhysical(sourcePath, targetDir, currentOpts);
                }
                break;
            } catch (error: any) {
                const msg = String(error);
                if (msg.startsWith("CONFLICT:DIR:")) {
                    const conflictPath = msg.replace("CONFLICT:DIR:", "");
                    currentOpts = await new Promise<any>((resolve, reject) => {
                        setConflictState({ 
                            type: "DIR", path: conflictPath, action, sourcePath, targetDir, opts: currentOpts, 
                            resolve: (opts) => { setConflictState(null); resolve(opts); }, 
                            reject: () => { setConflictState(null); reject(new Error("CANCELLED")); } 
                        });
                    });
                } else if (msg.startsWith("CONFLICT:FILE:")) {
                    const conflictPath = msg.replace("CONFLICT:FILE:", "");
                    currentOpts = await new Promise<any>((resolve, reject) => {
                        setConflictState({ 
                            type: "FILE", path: conflictPath, action, sourcePath, targetDir, opts: currentOpts, 
                            resolve: (opts) => { setConflictState(null); resolve(opts); }, 
                            reject: () => { setConflictState(null); reject(new Error("CANCELLED")); } 
                        });
                    });
                } else {
                    throw error;
                }
            }
        }
    };

    const canOperatePath = (path: string) => path !== rootPath;
    const operationPaths = (fallback: string) => {
        const paths: string[] = (treeRef.current?.selectedNodes ?? []).map((node: any) => node.data.id);
        const candidates = (paths.includes(fallback) ? paths : [fallback]).filter(canOperatePath);
        const normalize = (path: string) => path.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
        // A selected parent already includes its selected descendants.
        return candidates.filter(path => !candidates.some(other => other !== path && normalize(path).startsWith(normalize(other) + "/")));
    };
    const paste = (directory: string, files: File[] = [], text?: string) => runOperation(async () => {
        const project = rootPath;
        const pastedPaths: string[] = [];
        const selectPasted = () => {
            if (pastedPaths.length && useWorkspaceStore.getState().rootPath === project) {
                setPastedSelection({ project: project!, directory, paths: pastedPaths });
            }
        };
        if (remote) throw new Error("远程文件传输请通过终端操作");
        const system = await fsApi.readFileClipboard();
        const android = !system.paths.length ? await readAndroidClipboard(text) : null;
        if (android) {
            try { await downloadAndroidFiles(android, directory, path => pastedPaths.push(path)); }
            finally { await loadDirectory(directory, false, true); treeRef.current?.get(directory)?.open(); selectPasted(); }
            return;
        }
        if (!system.paths.length) {
            // Screenshots and copied browser images contain binary data, not CF_HDROP paths.
            if (!files.length && text === undefined && navigator.clipboard?.read) {
                for (const item of await navigator.clipboard.read()) {
                    if (item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
                    const type = item.types.find(type => type.startsWith("image/"));
                    if (type) {
                        const extension = type === "image/jpeg" ? "jpg" : type === "image/svg+xml" ? "svg" : type.split("/")[1];
                        files.push(new File([await item.getType(type)], `image-${Date.now()}.${extension}`, { type }));
                    }
                }
            }
            if (!files.length) {
                const query = (text ?? await navigator.clipboard.readText()).trim();
                if (query) { speedSearch.search(query); return; }
                throw new Error("剪贴板中没有可搜索的文本或可粘贴的文件、目录、图片。");
            }
            try {
                for (const file of files) {
                    pastedPaths.push(await fsApi.importFile(directory, file.name || `image-${Date.now()}.png`, Array.from(new Uint8Array(await file.arrayBuffer()))));
                }
            } finally {
                await loadDirectory(directory, false, true);
                treeRef.current?.get(directory)?.open();
                selectPasted();
            }
            return;
        }
        const remaining = [...system.paths];
        try {
            for (const path of system.paths) {
                if (system.cut && !remote) await handleTransferWithConflict("move", path, directory);
                else await handleTransferWithConflict("copy", path, directory);
                pastedPaths.push(`${directory.replace(/[/\\]$/, "")}/${path.split(/[/\\]/).pop()}`);
                remaining.shift();
            }
        } finally {
            if (system.cut) await fsApi.updateFileClipboard(remaining, true, system.sequence);
            treeRef.current?.get(directory)?.open();
            selectPasted();
        }
    });
    const copy = (path: string, cut: boolean) => runOperation(async () => {
        if (remote) { await navigator.clipboard.writeText(remotePath(path).path); return; }
        const paths = operationPaths(path);
        if (!paths.length) return;
        if (!isSnapshot) await flushPendingWrites();
        await fsApi.writeFileClipboard(paths, cut);
    });
    const importFromDialog = (directory: string) => runOperation(async () => {
        const paths = await open({ multiple: true, directory: false, title: "复制文件到当前目录" });
        for (const path of typeof paths === "string" ? [paths] : paths ?? []) await handleTransferWithConflict("copy", path, directory);
        treeRef.current?.get(directory)?.open();
    });
    const beginRename = (path: string) => {
        if (!canOperatePath(path)) return;
        creatingFromMenu.current = true;
        setRenamePath(path);
    };
    const remove = (path: string) => runOperation(async () => {
        const paths = operationPaths(path);
        if (!paths.length) return;
        if (!await confirmDelete({ title: "删除文件", description: `即将删除选中的 ${paths.length} 个项目及其全部内容。`, paths, permanent: remote, confirmLabel: "删除" })) return;
        try {
            for (const target of paths) await useWorkspaceStore.getState().deletePhysicalEntry(target);
        } finally {
            treeRef.current?.deselectAll();
            setSelectedPath(null); setSelectedDir(parent(path));
        }
    });

    const handleNodeClick = async (node: any) => {
        setSelectedPath(node.data.id);
        setSelectedDir(node.isLeaf ? parent(node.data.id) : node.data.id);
        if (!node.isLeaf) {
      node.toggle();
      return;
    }

        if (node.isLeaf) {
            try {
                if (remote && (isImage(node.data.id) || isVideo(node.data.id))) throw new Error("暂不支持远程媒体预览");
                if ((isImage(node.data.id) && !/\.svg$/i.test(node.data.id)) || isVideo(node.data.id)) {
                    openTab({
                        id: node.data.id,
                        title: node.data.name,
                        path: node.data.id,
                        content: "",
                        isDirty: false,
                    });
                    return;
                }
                if (isBinaryAsset(node.data.id)) throw new Error("二进制文件暂不支持文本预览");
                const content = await fsApi.readFile(node.data.id);
                openTab({
                    id: node.data.id,
                    title: node.data.name,
                    path: node.data.id,
                    content: content,
                    isDirty: false,
                });
            } catch (error) {
                setError(`无法预览此文件，可通过“打开文件”使用系统程序打开：${String(error)}`);
            }
        }
    };

    const receiveAndroidFiles = (data: AndroidFiles, directory: string) => runOperation(async () => {
        const project = rootPath;
        const paths: string[] = [];
        try { await downloadAndroidFiles(data, directory, path => paths.push(path)); }
        finally {
            await loadDirectory(directory, false, true);
            if (useWorkspaceStore.getState().rootPath === project) {
                treeRef.current?.get(directory)?.open();
                if (paths.length) setPastedSelection({ project: project!, directory, paths });
            }
        }
    });

    const handleDragStart = (e: React.DragEvent, node: any) => {
        e.stopPropagation();
        const isSelected = selection.some(s => s.path === node.data.id);
        const paths = isSelected ? selection.map(s => s.path) : [node.data.id];
        
        e.dataTransfer.setData("application/x-nexusdesk-file", node.data.id);
        e.dataTransfer.setData("application/x-nexusdesk-files", JSON.stringify(paths));
        e.dataTransfer.effectAllowed = "all";
        draggedPhysicalRef.current = node.data.id;
    };

    const handleDragOver = (e: React.DragEvent, node?: any) => {
        if (e.dataTransfer.types.includes(ANDROID_FILE_TYPE)) {
            e.preventDefault(); e.stopPropagation();
            e.dataTransfer.dropEffect = remote || isSnapshot ? "none" : "copy";
            if (!remote && !isSnapshot) setDragOverPath(node ? (node.isLeaf ? parent(node.data.id) : node.data.id) : rootPath);
            return;
        }
        if (e.dataTransfer.types.some(type => ["Files", "application/x-nexusdesk-file", "application/x-nexusdesk-files", "application/x-nexusdesk-logical-file"].includes(type))) {
            e.preventDefault();
            e.stopPropagation();

            const target = node ? (node.isLeaf ? parent(node.data.id) : node.data.id) : rootPath;
            const dragged = draggedPhysicalRef.current;
            let invalidTarget = false;

            if (dragged && target && (e.dataTransfer.types.includes("application/x-nexusdesk-file") || e.dataTransfer.types.includes("application/x-nexusdesk-files"))) {
                const d = dragged.replace(/\\/g, "/");
                const t = target.replace(/\\/g, "/");
                const p = parent(d).replace(/\\/g, "/");
                if (t === d || t.startsWith(d + "/") || t === p) {
                    invalidTarget = true;
                    setDragOverPath(null);
                    e.dataTransfer.dropEffect = "none";
                }
            }
            if (!invalidTarget) setDragOverPath(target);

            e.dataTransfer.dropEffect = e.dataTransfer.types.includes("application/x-nexusdesk-logical-file") ? "copy" : "move";
        }
    };

    const handleDrop = (e: React.DragEvent, node?: any) => {
        setDragOverPath(null);
        draggedPhysicalRef.current = null;
        const target = node ? (node.isLeaf ? parent(node.data.id) : node.data.id) : rootPath;
        if (e.dataTransfer.types.includes(ANDROID_FILE_TYPE)) {
            e.preventDefault(); e.stopPropagation();
            if (!target || remote || isSnapshot) return;
            const android = parseAndroidFiles(e.dataTransfer.getData(ANDROID_FILE_TYPE));
            if (!android) { setError("无效的安卓文件拖拽数据"); return; }
            void receiveAndroidFiles(android, target);
            return;
        }
        const logical = e.dataTransfer.getData("application/x-nexusdesk-logical-file");
        const physicalFilesStr = e.dataTransfer.getData("application/x-nexusdesk-files");
        const physical = e.dataTransfer.getData("application/x-nexusdesk-file");
        const files = Array.from(e.dataTransfer.files);
        
        if (target && !logical && !physical && !physicalFilesStr && files.length) {
            e.preventDefault(); e.stopPropagation();
            void runOperation(async () => {
                try {
                    for (const file of files) await fsApi.importFile(target, file.name, Array.from(new Uint8Array(await file.arrayBuffer())));
                } finally { await loadDirectory(target, false, true); treeRef.current?.get(target)?.open(); }
            });
            return;
        }
        if (!target || (!logical && !physical && !physicalFilesStr)) return;
        e.preventDefault();
        e.stopPropagation();
        
        if (logical) {
            void runOperation(() => handleTransferWithConflict("copy", logical, target));
        } else {
            let physicalPaths: string[] = [];
            if (physicalFilesStr) {
                try { physicalPaths = JSON.parse(physicalFilesStr); } catch {}
            } else if (physical) {
                physicalPaths = [physical];
            }
            
            if (physicalPaths.length > 0) {
                void runOperation(async () => {
                    for (const p of physicalPaths) {
                        const d = p.replace(/\\/g, "/");
                        const t = target.replace(/\\/g, "/");
                        const parentDir = parent(d).replace(/\\/g, "/");
                        if (t === d || t.startsWith(d + "/") || t === parentDir) continue;
                        await handleTransferWithConflict("move", p, target);
                    }
                });
            }
        }
    };

    const handleCreate = async (name: string) => {
        if (!targetDir || !isCreating) return;
        const project = rootPath;
        const path = `${targetDir.replace(/[/\\]$/, "")}/${name}`;
        if (isCreating === "file") {
            await createPhysicalFile(path);
            if (useWorkspaceStore.getState().rootPath !== project) return;
            openTab({ id: path, title: name, path, content: "", isDirty: false });
        } else await createPhysicalFolder(path);
        if (useWorkspaceStore.getState().rootPath === project) treeRef.current?.get(targetDir)?.open();
    };

    if (!rootPath) {
        return <div className="explorer-tree h-full p-4 text-xs text-gray-500 text-center">未打开项目。<br/>请点击“打开项目...”选择目录。</div>;
    }

    const status = (path: string) => treeStatusFor(path, treeStatuses);
    const multiple = selection.length > 1;
    const comparable = selection.length === 2 && selection.every(entry => entry.file);
    const compareSelection = () => {
        if (comparable) void compare(selection[1].path, selection[0].path);
    };

    const withContextMenu = (path: string, directory: boolean, children: React.ReactElement) => (
        <ContextMenu.Root key={path}>
            <ContextMenu.Trigger asChild onContextMenu={event => {
                event.stopPropagation();
                if (path === rootPath) {
                    treeRef.current?.deselectAll();
                    setSelectedPath(null);
                    setSelectedDir(null);
                }
                setSelectedPath(path);
                setSelectedDir(directory ? path : parent(path));
            }}>
                {children}
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
            <ContextMenu.Content collisionPadding={8} aria-label="项目文件操作" className="ide-menu w-60 text-xs" onCloseAutoFocus={event => {
                    if (creatingFromMenu.current) { event.preventDefault(); creatingFromMenu.current = false; }
                }}>
                {isSnapshot ? <>
                    <ContextMenu.Item className="ide-menu-item" onSelect={() => void copy(path, false)}>复制 <span className="ml-auto text-gray-500">Ctrl+C</span></ContextMenu.Item>
                    <ContextMenu.Item className="ide-menu-item" onSelect={() => {
                        void (directory ? openPath(path) : revealItemInDir(path)).catch(error => setError(String(error)));
                    }}>打开所在位置</ContextMenu.Item>
                </> : <>
                <ContextMenu.Item className="ide-menu-item" onSelect={() => beginCreate("file", directory ? path : parent(path))}>新建文件...</ContextMenu.Item>
                <ContextMenu.Item className="ide-menu-item" onSelect={() => beginCreate("folder", directory ? path : parent(path))}>新建文件夹...</ContextMenu.Item>
                <ContextMenu.Item className="ide-menu-item" onSelect={() => void importFromDialog(directory ? path : parent(path))}>导入文件...</ContextMenu.Item>
                {!directory && <ContextMenu.Item disabled={remote} className="ide-menu-item" onSelect={() => { void openPath(path).catch(error => setError(String(error))); }}>打开文件（系统程序）</ContextMenu.Item>}
                {!directory && isConvertibleDocument(path) && <ContextMenu.Item disabled={remote || multiple || converting} className="ide-menu-item text-ide-accent" onSelect={() => void handleConvertToMd(path)}>提取为 Markdown...</ContextMenu.Item>}
                {!directory && /\.mkv$/i.test(path) && <ContextMenu.Item disabled={remote || multiple || converting} className="ide-menu-item text-ide-accent" onSelect={() => void handleConvertMkvToMp4(path)}>转换为 MP4...</ContextMenu.Item>}
                <ContextMenu.Item disabled={remote} className="ide-menu-item" onSelect={() => {
                    const action = directory ? openPath(path) : revealItemInDir(path);
                    void action.catch(error => setError(`打开目录失败：${String(error)}`));
                }}>打开所在目录</ContextMenu.Item>
                <ContextMenu.Item className="ide-menu-item" onSelect={() => {
                    const dir = directory ? path : parent(path);
                    const { profiles, defaultProfileId, createSession } = useTerminalStore.getState();
                    const profile = profiles.find(p => p.id === defaultProfileId) || profiles[0];
                    if (profile) {
                        createSession(profile, dir);
                        useLayoutStore.getState().openBottomPanel("terminal");
                    }
                }}>打开所在目录（在终端）</ContextMenu.Item>
                {!remote && codexInstalled && <ContextMenu.Item className="ide-menu-item" onSelect={() => {
                    const dir = directory ? path : parent(path);
                    void useTerminalStore.getState().createSession({ id: "codex", name: "Codex", command: "codex" }, dir).then(started => {
                        if (started) useLayoutStore.getState().openBottomPanel("terminal");
                        else setError(useTerminalStore.getState().launchError);
                    });
                }}>打开所在目录（在Codex）</ContextMenu.Item>}
                <ContextMenu.Item className="ide-menu-item" onSelect={() => void loadDirectory(directory ? path : parent(path), false, true)}>刷新目录</ContextMenu.Item>
                {remote && path === rootPath && <ContextMenu.Item className="ide-menu-item" onSelect={() => void useWorkspaceStore.getState().setProject(remoteUri(remotePath(path).id, "/"))}>浏览服务器根目录</ContextMenu.Item>}
                <ContextMenu.Separator className="h-px my-1 bg-ide-panel-border" />
                <ContextMenu.Item disabled={multiple || !canOperatePath(path)} className="ide-menu-item" onSelect={() => beginRename(path)}>重命名... <span className="ml-auto text-gray-500">F2</span></ContextMenu.Item>
                <ContextMenu.Item disabled={!canOperatePath(path)} className="ide-menu-item" onSelect={() => void copy(path, false)}>{remote ? "复制远程路径" : "复制"} <span className="ml-auto text-gray-500">Ctrl+C</span></ContextMenu.Item>
                <ContextMenu.Item disabled={remote || !canOperatePath(path)} className="ide-menu-item" onSelect={() => void copy(path, true)}>剪切 <span className="ml-auto text-gray-500">Ctrl+X</span></ContextMenu.Item>
                <ContextMenu.Item className="ide-menu-item" onSelect={() => void paste(directory ? path : parent(path))}>粘贴 <span className="ml-auto text-gray-500">Ctrl+V</span></ContextMenu.Item>
                <ContextMenu.Item disabled={!canOperatePath(path)} className="ide-menu-item" onSelect={() => { creatingFromMenu.current = true; void remove(path); }}>删除... <span className="ml-auto text-gray-500">Delete</span></ContextMenu.Item>
                {multiple && <ContextMenu.Item disabled={!comparable} className="ide-menu-item" onSelect={compareSelection}>比较文件 <span className="ml-auto text-gray-500">Ctrl+D</span></ContextMenu.Item>}
                {!directory && <>
                    <ContextMenu.Item className="ide-menu-item" disabled={remote || multiple} onSelect={() => setHistoryPath(path)}>本地历史...</ContextMenu.Item>
                    <ContextMenu.Item className="ide-menu-item" disabled={remote || multiple} onSelect={() => setGitHistoryPath(path)}>Git 历史...</ContextMenu.Item>
                </>}
                </>}
            </ContextMenu.Content>
            </ContextMenu.Portal>
        </ContextMenu.Root>
    );

    return <>{confirmationDialog}{gitHistoryPath && <GitHistoryDialog key={gitHistoryPath} path={gitHistoryPath} onClose={() => setGitHistoryPath(null)} />}{historyPath && <LocalHistoryDialog key={historyPath} path={historyPath} onClose={() => setHistoryPath(null)} />}{withContextMenu(rootPath, true,
        <div tabIndex={0} className="explorer-tree flex flex-col h-full" onClick={event => {
            // Clicking the tree's root/background clears a child selection and
            // makes the project root the explicit destination for paste.
            if ((event.target as HTMLElement).closest('[role="treeitem"]')) return;
            treeRef.current?.deselectAll();
            setSelectedPath(rootPath);
            setSelectedDir(rootPath);
        }} onDragOver={e => handleDragOver(e)} onDrop={e => handleDrop(e)}
            onPaste={event => {
                if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
                event.preventDefault(); event.stopPropagation();
                if (isSnapshot) return;
                const focused = treeRef.current?.focusedNode;
                const directory = selectedDir ?? (focused ? (focused.isLeaf ? parent(focused.data.id) : focused.data.id) : rootPath);
                void paste(directory, Array.from(event.clipboardData.files), event.clipboardData.getData("text/plain"));
            }}
            onKeyDown={event => {
                if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
                const focused = treeRef.current?.focusedNode;
                const path = focused?.data.id ?? selectedPath ?? rootPath;
                const key = event.key.toLowerCase();
                if (isSnapshot && (event.key === "F2" || event.key === "Delete" || ((event.ctrlKey || event.metaKey) && ["x", "v", "z", "d"].includes(key)))) {
                    event.preventDefault(); event.stopPropagation(); return;
                }
                if ((event.ctrlKey || event.metaKey) && !event.altKey && key === "z") {
                    event.preventDefault(); event.stopPropagation();
                    void runOperation(() => fileOperationHistory.replay(event.shiftKey));
                    return;
                }
                if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === "d") {
                    event.preventDefault(); event.stopPropagation(); compareSelection(); return;
                }
                if (multiple && event.key === "F2") {
                    event.preventDefault(); event.stopPropagation(); return;
                }
                if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && ["c", "x", "v"].includes(key)) {
                    // Let the native paste event expose clipboard image bytes.
                    if (key === "v") { event.stopPropagation(); return; }
                    event.preventDefault(); event.stopPropagation();
                    void copy(path, key === "x");
                    return;
                }
                if (event.key === "F2") {
                    event.preventDefault(); event.stopPropagation(); beginRename(path); return;
                }
                if (event.key === "Delete" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
                    event.preventDefault(); event.stopPropagation(); void remove(path); return;
                }
                const row = (event.target as HTMLElement).closest('[role="treeitem"]');
                const target = row?.querySelector<HTMLElement>('[data-tree-path]') ?? event.currentTarget;
                openContextMenuFromKeyboard(event, target);
            }}>
            {renamePath && <CreateNameDialog
                key={`rename:${renamePath}`}
                title="重命名" description={`位置：${renamePath}`} label="新名称"
                initialName={renamePath.split(/[/\\]/).pop()}
                selectBasename={treeRef.current?.get(renamePath)?.isLeaf === true}
                validate={validateEntryName}
                onCreate={async name => {
                    await movePhysicalEntry(renamePath, parent(renamePath), name);
                    setSelectedPath(null);
                    setSelectedDir(parent(renamePath));
                }}
                onClose={() => setRenamePath(null)}
            />}
            {isCreating && targetDir && (
                <CreateNameDialog
                    key={`${rootPath}:${targetDir}:${isCreating}`}
                    title={isCreating === "file" ? "新建文件" : "新建文件夹"}
                    description={`位置：${targetDir}`}
                    label={isCreating === "file" ? "文件名称" : "文件夹名称"}
                    validate={validateEntryName}
                    onCreate={handleCreate}
                    onClose={() => setIsCreating(null)}
                />
            )}

            {conflictState && (
                <Dialog.Root open onOpenChange={open => { if (!open) conflictState.reject(); }}>
                    <Dialog.Portal>
                        <Dialog.Overlay className="search-overlay" />
                        <Dialog.Content className="create-name-dialog delete-confirm-dialog" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                            <header className="flex items-center gap-3 px-5 pt-5">
                                <span className="delete-confirm-icon"><AlertTriangle size={20} className="text-amber-400" /></span>
                                <Dialog.Title className="flex-1 font-medium text-base">
                                    {conflictState.type === "DIR" ? "目录已存在" : "文件已存在"}
                                </Dialog.Title>
                                <Dialog.Close className="rounded p-1 text-gray-400 hover:bg-white/10"><X size={16} /></Dialog.Close>
                            </header>
                            <div className="px-5 py-4">
                                <Dialog.Description className="text-xs leading-6 text-gray-400">
                                    目标位置已存在同名{conflictState.type === "DIR" ? "目录" : "文件"}：
                                </Dialog.Description>
                                <p className="mt-2 break-all text-sm font-mono bg-ide-panel-bg p-2 rounded border border-ide-panel-border">
                                    {conflictState.path}
                                </p>
                                <p className="mt-3 text-xs text-gray-400">
                                    {conflictState.type === "DIR" 
                                        ? "是否合并这两个目录的内容？" 
                                        : "是否覆盖此文件？"}
                                </p>
                            </div>
                            <footer className="flex justify-end gap-2 border-t border-ide-panel-border px-5 py-3">
                                <Dialog.Close className="rounded border border-ide-panel-border px-4 py-1.5 hover:bg-white/10 text-sm">取消</Dialog.Close>
                                {conflictState.type === "DIR" ? (
                                    <button className="rounded bg-ide-accent px-4 py-1.5 text-white text-sm" onClick={() => conflictState.resolve({ ...conflictState.opts, mergeFolders: true })}>合并目录</button>
                                ) : (
                                    <>
                                        <button className="rounded border border-ide-panel-border px-4 py-1.5 hover:bg-white/10 text-sm" onClick={() => conflictState.resolve({ ...conflictState.opts, skipPaths: [...(conflictState.opts.skipPaths || []), conflictState.path] })}>跳过</button>
                                        <button className="rounded border border-ide-panel-border px-4 py-1.5 hover:bg-white/10 text-sm" onClick={() => conflictState.resolve({ ...conflictState.opts, skipAll: true })}>全部跳过</button>
                                        <button className="rounded bg-ide-accent px-4 py-1.5 text-white text-sm" onClick={() => conflictState.resolve({ ...conflictState.opts, overwritePaths: [...(conflictState.opts.overwritePaths || []), conflictState.path] })}>覆盖</button>
                                        <button className="rounded bg-ide-accent px-4 py-1.5 text-white text-sm" onClick={() => conflictState.resolve({ ...conflictState.opts, overwriteAll: true })}>全部覆盖</button>
                                    </>
                                )}
                            </footer>
                        </Dialog.Content>
                    </Dialog.Portal>
                </Dialog.Root>
            )}

            {convertingPath && <div className="flex items-center gap-2 p-2 text-xs text-gray-400" role="status"><span className="flex-1 truncate">正在转换：{convertingPath.split(/[\\/]/).pop()}</span><button type="button" className="rounded p-1 text-gray-300 hover:bg-white/10" title="取消转码" aria-label="取消转码" onClick={() => void cancelConvertMkvToMp4()}><Square size={13} fill="currentColor" /></button></div>}
            {error && <div role="alert" className="p-2 text-xs text-red-400 break-words">{error}</div>}
            <div ref={containerRef} onKeyDownCapture={speedSearch.onKeyDownCapture} className="relative flex-1 w-full p-1 overflow-hidden">
                {speedSearch.searchBox}
                {fileTreeData && fileTreeData.length > 0 ? (
                    height > 0 && (
                        <PhysicalNodeContext.Provider value={({ node, style }) => withContextMenu(node.data.id, !node.isLeaf,
                                <div
                                    style={style}
                                    className={`flex items-center gap-1 px-1 text-sm cursor-default rounded-sm ${
                                        dragOverPath === (node.isLeaf ? parent(node.data.id) : node.data.id) ? "bg-sky-500/30 ring-1 ring-inset ring-sky-400/70" : node.isSelected ? "bg-ide-selection text-white" : "hover:bg-ide-tree-hover"
                                    }`}
                                    tabIndex={-1}
                                    data-tree-path={node.data.id}
                                    data-link-file={node.isLeaf ? node.data.id : undefined}
                                    onKeyDown={openContextMenuFromKeyboard}
                                    onContextMenu={() => { if (!node.isSelected) node.select(); }}
                                    onClick={event => {
                                        selectTreeNode(event, node);
                                        setSelectedPath(node.data.id);
                                        setSelectedDir(node.isLeaf ? parent(node.data.id) : node.data.id);
                                    }}
                                    onDoubleClick={event => activateTreeFile(event, node)}
                                    draggable
                                    onDragStart={(e) => handleDragStart(e, node)}
                                    onDragOver={(e) => handleDragOver(e, node)}
                                    onDrop={(e) => handleDrop(e, node)}
                                    onDragLeave={e => { if (e.currentTarget === e.target) setDragOverPath(null); }}
                                    onDragEnd={() => { draggedPhysicalRef.current = null; setDragOverPath(null); }}
                                >
                  <span className="w-4 flex justify-center">
                    {!node.isLeaf && (
                        node.isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                    )}
                  </span>

                                    <FileIcon name={node.data.name} directory={!node.isLeaf} open={node.isOpen} />

                                    <span className="truncate tree-entry-name" data-status={status(node.data.id)} title={status(node.data.id) ? statusLabels[status(node.data.id)!] : undefined}>{speedSearch.highlight(node.data.name)}</span>
                                </div>
                            )}>
                        <Tree
                            {...speedSearch.treeSearchProps}
                            onActivate={node => void handleNodeClick(node)}
                            ref={treeRef}
                            key={rootPath}
                            data={fileTreeData}
                            {...treeOpenState}
                            disableDrag
                            disableMultiSelection={false}
                            onSelect={nodes => {
                                setSelection(nodes.map(node => ({ path: node.data.id, file: node.isLeaf })));
                                setSearchScopePath(nodes.length === 1 && !nodes[0].isLeaf ? nodes[0].data.id : null);
                            }}
                            openByDefault={false}
                            width={width}
                            height={height}
                            indent={16}
                            rowHeight={24}
                            padding={4}
                        >
                            {PhysicalTreeNode}
                        </Tree>
                        </PhysicalNodeContext.Provider>
                    )
                ) : (
                    <div className="p-4 text-xs text-gray-500 text-center">目录为空</div>
                )}
            </div>
        </div>
    )}</>;
});
