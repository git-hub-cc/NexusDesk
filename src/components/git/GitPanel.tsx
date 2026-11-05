import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Copy, GitCommit, RefreshCw, Undo2, Upload } from "lucide-react";
import { gitApi, fsApi, type GitFileStatus, type GitLogEntry, type GitRevisionChange } from "@/lib/api";
import { useWorkspaceStore, flushPendingWrites } from "@/store/workspaceStore";
import { GitFileTree, type GitTreeTarget } from "./GitFileTree";
import { isImage } from "@/lib/assets";
import { confirmAction } from "@/lib/dialogs";
import { isRemotePath } from "@/lib/remote";
import { commitDraftEvent, getCommitDraft, rememberCommitDraft } from "@/lib/codexCommitMessage";
import { setSpeechTarget } from "@/lib/speechTarget";

export function GitPanel() {
    const root = useWorkspaceStore(s => s.rootPath);
    if (isRemotePath(root)) return <p className="p-3 text-sm text-gray-400">远程 Git 操作请在终端中执行。</p>;
    return root ? <RepositoryPanel key={root} root={root} /> : <p className="p-3 text-sm text-gray-400">请先打开 Git 项目文件夹。</p>;
}

function RepositoryPanel({ root }: { root: string }) {
    const panelRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [contextMenu, setContextMenu] = useState<{ targets: GitTreeTarget[]; x: number; y: number } | null>(null);
    const [commitMenu, setCommitMenu] = useState<{ commit: GitLogEntry; x: number; y: number } | null>(null);
    const [revisionFileMenu, setRevisionFileMenu] = useState<{ file?: GitRevisionChange; directory?: string; x: number; y: number } | null>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);
    const commitMenuRef = useRef<HTMLDivElement>(null);
    const revisionFileMenuRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!contextMenu) return;
        const dismiss = (event: PointerEvent) => { if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null); };
        const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setContextMenu(null); };
        const close = () => setContextMenu(null);
        document.addEventListener("pointerdown", dismiss);
        document.addEventListener("keydown", escape);
        window.addEventListener("resize", close);
        window.addEventListener("blur", close);
        contextMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
        return () => {
            document.removeEventListener("pointerdown", dismiss);
            document.removeEventListener("keydown", escape);
            window.removeEventListener("resize", close);
            window.removeEventListener("blur", close);
        };
    }, [contextMenu]);
    useEffect(() => {
        if (!commitMenu) return;
        const dismiss = (event: PointerEvent) => { if (!commitMenuRef.current?.contains(event.target as Node)) setCommitMenu(null); };
        const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setCommitMenu(null); };
        const close = () => setCommitMenu(null);
        document.addEventListener("pointerdown", dismiss);
        document.addEventListener("keydown", escape);
        window.addEventListener("resize", close);
        window.addEventListener("blur", close);
        commitMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
        return () => {
            document.removeEventListener("pointerdown", dismiss);
            document.removeEventListener("keydown", escape);
            window.removeEventListener("resize", close);
            window.removeEventListener("blur", close);
        };
    }, [commitMenu]);
    useEffect(() => {
        if (!revisionFileMenu) return;
        const dismiss = (event: PointerEvent) => { if (!revisionFileMenuRef.current?.contains(event.target as Node)) setRevisionFileMenu(null); };
        const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setRevisionFileMenu(null); };
        const close = () => setRevisionFileMenu(null);
        document.addEventListener("pointerdown", dismiss);
        document.addEventListener("keydown", escape);
        window.addEventListener("resize", close);
        window.addEventListener("blur", close);
        revisionFileMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
        return () => {
            document.removeEventListener("pointerdown", dismiss);
            document.removeEventListener("keydown", escape);
            window.removeEventListener("resize", close);
            window.removeEventListener("blur", close);
        };
    }, [revisionFileMenu]);
    const [files, setFiles] = useState<GitFileStatus[]>([]);
    const [log, setLog] = useState<GitLogEntry[]>([]);
    const [historyQuery, setHistoryQuery] = useState("");
    const normalizedHistoryQuery = historyQuery.trim().toLowerCase();
    const filteredLog = log.filter(commit => commit.message.toLowerCase().includes(normalizedHistoryQuery));
    const [hasRemote, setHasRemote] = useState(false);
    const [message, updateMessage] = useState(() => getCommitDraft(root) ?? "");
    function setMessage(value: string) {
        rememberCommitDraft(root, value);
        updateMessage(value);
    }
    useEffect(() => {
        const receive = (event: Event) => {
            const detail = (event as CustomEvent<{ root: string; message: string }>).detail;
            if (detail.root === root) changeMessage(detail.message);
        };
        window.addEventListener(commitDraftEvent, receive);
        return () => window.removeEventListener(commitDraftEvent, receive);
    }, [root]);
    const messageHistory = useRef<{ entries: string[]; index: number; draft: string } | null>(null);
    function changeMessage(value: string) {
        messageHistory.current = null;
        setMessage(value);
    }
    function navigateMessageHistory(event: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        const input = event.currentTarget;
        if (input.selectionStart !== input.selectionEnd) return;
        const older = event.key === "ArrowUp";
        if (older ? message.slice(0, input.selectionStart).includes("\n") : message.slice(input.selectionEnd).includes("\n")) return;
        let history = messageHistory.current;
        if (!history) {
            if (!older) return;
            history = { entries: [...new Set(log.map(commit => commit.message).filter(value => value.trim()))], index: -1, draft: message };
            messageHistory.current = history;
        }
        if (!history.entries.length) return;
        event.preventDefault();
        event.stopPropagation();
        history.index = Math.max(-1, Math.min(history.entries.length - 1, history.index + (older ? 1 : -1)));
        const value = history.index < 0 ? history.draft : history.entries[history.index];
        setMessage(value);
        requestAnimationFrame(() => {
            if (!input.isConnected) return;
            const position = older ? 0 : value.length;
            input.setSelectionRange(position, position);
        });
    }
    const [msgLoaded, setMsgLoaded] = useState(false);
    const [error, setError] = useState("");
    const [isRepository, setIsRepository] = useState<boolean | null>(null);
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<Set<string>>(new Set());
    const pendingRef = useRef(new Set<string>());
    const queue = useRef(Promise.resolve());
    const [limit, setLimit] = useState(100);
    const [fileWidth, setFileWidth] = useState(44);
    const [messageWidth, setMessageWidth] = useState(24);
    const [resizing, setResizing] = useState(false);
    const columnsRef = useRef<HTMLDivElement>(null);
    const [revision, setRevision] = useState<GitLogEntry | null>(null);
    const [revisionFiles, setRevisionFiles] = useState<GitRevisionChange[]>([]);
    const [loadingRevision, setLoadingRevision] = useState(false);
    const revisionRequest = useRef(0);
    const statusRequest = useRef(0);
    const mounted = useRef(true);
    const locked = useRef(false);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

    useEffect(() => {
        let alive = true;
        fsApi.isDirectory(`${root}/.git`).then(isRepo => {
            if (!isRepo) return;
            return fsApi.readFile(`${root}/.git/noteide_commit_msg.txt`).then(content => {
                if (alive) setMessage(getCommitDraft(root) ?? content);
            }).catch(() => {});
        }).catch(() => {}).finally(() => { if (alive) setMsgLoaded(true); });
        return () => { alive = false; };
    }, [root]);

    useEffect(() => {
        if (!msgLoaded) return;
        let alive = true;
        const msgPath = `${root}/.git/noteide_commit_msg.txt`;
        const timer = setTimeout(() => {
            fsApi.isDirectory(`${root}/.git`).then(isRepo => {
                if (alive && isRepo) return fsApi.writeFile(msgPath, message);
            }).catch(() => {});
        }, 500);
        return () => { alive = false; clearTimeout(timer); };
    }, [message, root, msgLoaded]);

    const refreshStatus = useCallback(async () => {
        const request = ++statusRequest.current;
        const status = await gitApi.status(root);
        if (useWorkspaceStore.getState().rootPath === root) await useWorkspaceStore.getState().refreshTreeStatuses();
        if (mounted.current && request === statusRequest.current) setFiles(previous => {
            const old = new Map(previous.map(f => [f.path, f]));
            return status.map(f => {
                const existing = old.get(f.path);
                return existing && JSON.stringify(existing) === JSON.stringify(f) ? existing : f;
            });
        });
    }, [root]);
    const refresh = useCallback(async () => {
        const exists = await gitApi.isRepository(root);
        if (!mounted.current) return;
        setIsRepository(exists);
        if (!exists) {
            setFiles([]);
            setLog([]);
            setHasRemote(false);
            setError("");
            return;
        }
        const [, history, settings] = await Promise.all([refreshStatus(), gitApi.log(root, limit), gitApi.settings(root)]);
        if (mounted.current) {
            setLog(history);
            setHasRemote(!!settings.remote.trim());
            setError("");
        }
    }, [root, limit, refreshStatus]);
    useEffect(() => {
        void refresh().catch(e => { if (mounted.current) setError(String(e)); });
        const onFocus = () => { if (!locked.current && !pendingRef.current.size) void refresh().catch(e => { if (mounted.current) setError(String(e)); }); };
        window.addEventListener("focus", onFocus);
        window.addEventListener("git-settings-changed", onFocus);
        return () => {
            window.removeEventListener("focus", onFocus);
            window.removeEventListener("git-settings-changed", onFocus);
        };
    }, [refresh]);

    useEffect(() => {
        if (!isRepository) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void listen<{ root: string; paths: string[] }>("workspace-changed", ({ payload }) => {
            if (payload.root !== root || !payload.paths.length || locked.current || pendingRef.current.size) return;
            void refreshStatus().catch(e => { if (mounted.current) setError(String(e)); });
        }).then(stop => {
            if (disposed) stop();
            else unlisten = stop;
        }).catch(e => { if (mounted.current) setError(String(e)); });
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [isRepository, refreshStatus, root]);

    async function run(action: () => Promise<void>, mutate = false) {
        if (locked.current || pendingRef.current.size) return;
        locked.current = true; setBusy(true); setError(""); setNotice("");
        try {
            if (mutate) await flushPendingWrites();
            await action();
            if (mutate && mounted.current) await refresh();
        } catch (e) { if (mounted.current) setError(String(e)); }
        finally { locked.current = false; if (mounted.current) setBusy(false); }
    }
    async function initializeRepository() {
        await run(async () => {
            await gitApi.initRepository(root);
            if (!mounted.current) return;
            setIsRepository(true);
            setNotice("Git 仓库初始化成功");
            await refresh();
        });
    }
    function stageMany(candidates: GitFileStatus[], staged: boolean) {
        if (locked.current) return;
        const targets = candidates.filter(file => !file.conflict && !pendingRef.current.has(file.path) && file.staged !== staged);
        if (!targets.length) return;
        targets.forEach(file => pendingRef.current.add(file.path)); setPending(new Set(pendingRef.current)); setError("");
        // Serialize index writes. Only this row shows pending state; history is untouched.
        queue.current = queue.current.then(async () => {
            if (!mounted.current) return;
            try { await flushPendingWrites(); for (const file of targets) await gitApi.stage(root, file.path, staged); }
            catch (e) { if (mounted.current) setError(String(e)); }
            finally {
                try { if (mounted.current) await refreshStatus(); } catch (e) { if (mounted.current) setError(String(e)); }
                targets.forEach(file => pendingRef.current.delete(file.path)); if (mounted.current) setPending(new Set(pendingRef.current));
            }
        });
    }
    async function openDiff(file: GitFileStatus, staged: boolean) {
        await flushPendingWrites();
        const content = isImage(file.path) ? "" : await gitApi.diff(root, file.path, staged);
        if (!mounted.current) return;
        useWorkspaceStore.getState().openTab({ id: `git-diff:${root}:${file.path}:${staged}`, path: isImage(file.path) || staged ? file.path : file.worktreePath, diffContext: { root, path: file.path }, diffReadOnly: file.status === "删除", title: `${file.path.split("/").pop()} (${staged ? "已暂存" : "工作区"})`, diff: content, diffStaged: staged, imageDiff: isImage(file.path) ? { repoPath: root, staged } : undefined });
    }
    async function selectRevision(commit: GitLogEntry) {
        const request = ++revisionRequest.current;
        setRevision(commit); setLoadingRevision(true); setError("");
        try {
            const entries = await gitApi.revisionChanges(root, commit.id);
            if (mounted.current && request === revisionRequest.current) setRevisionFiles(entries);
        } catch (e) { if (mounted.current && request === revisionRequest.current) { setRevisionFiles([]); setError(String(e)); } }
        finally { if (mounted.current && request === revisionRequest.current) setLoadingRevision(false); }
    }
    function returnToLocal() {
        revisionRequest.current++; setRevision(null); setLoadingRevision(false);
        useWorkspaceStore.getState().returnFromRevision(root);
    }
    async function copyCommitMessage(commit: GitLogEntry) {
        setCommitMenu(null);
        try {
            await navigator.clipboard.writeText(commit.message);
            if (mounted.current) setNotice("已复制提交说明");
        } catch (e) { if (mounted.current) setError(String(e)); }
    }
    async function undoCommit(commit: GitLogEntry) {
        setCommitMenu(null);
        if (!commit.isHead || commit.pushed) return;
        const confirmed = await confirmAction(
            `撤销提交 ${commit.id.slice(0, 8)}「${commit.message.split("\n")[0]}」？提交会从当前分支移除，文件更改会保留在暂存区。`,
            { title: "撤销本地提交", confirmLabel: "撤销提交", cancelLabel: "取消" }
        );
        if (!confirmed) return;
        await run(async () => {
            await gitApi.undoCommit(root, commit.id);
            if (!mounted.current) return;
            changeMessage(commit.message);
            if (revision) returnToLocal();
            setNotice(`已撤销提交 ${commit.id.slice(0, 8)}，更改已保留在暂存区`);
        }, true);
    }
    async function openRevisionFile(path: string) {
        if (!revision) return;
        const commit = revision;
        const request = revisionRequest.current;
        const content = isImage(path) ? "" : await gitApi.revisionDiff(root, commit.id, path);
        if (!mounted.current || request !== revisionRequest.current) return;
        useWorkspaceStore.getState().openTab({ id: `git-revision:${root}:${commit.id}:${path}`, path, diffContext: { root, path }, title: `${path.split("/").pop()} @${commit.id.slice(0, 8)}`, diff: content, revision: commit.id, imageDiff: isImage(path) ? { repoPath: root, staged: false, commitId: commit.id } : undefined, diffLabels: [commit.parents[0] ? `父提交 ${commit.parents[0].slice(0, 8)}` : "空版本 · 首次提交前", `当前提交 ${commit.id.slice(0, 8)}`] });
    }
    async function restoreRevisionFile(file: GitRevisionChange) {
        setRevisionFileMenu(null);
        if (!revision) return;
        const commit = revision;
        const confirmed = await confirmAction(
            `${file.status === "删除" ? "删除本地文件" : "用提交内容覆盖本地文件"} ${file.path}？`,
            { title: "恢复提交文件", confirmLabel: file.status === "删除" ? "删除文件" : "覆盖文件", cancelLabel: "取消" }
        );
        if (!confirmed || !mounted.current || revision?.id !== commit.id) return;
        await run(async () => {
            await gitApi.restoreRevisionFile(root, commit.id, file.path);
            const state = useWorkspaceStore.getState();
            for (const pane of ["left", "right"] as const) {
                for (const tab of pane === "left" ? state.leftTabs : state.rightTabs) {
                    const normalized = tab.path.replace(/\\/g, "/");
                    const relative = normalized.startsWith(`${root.replace(/\\/g, "/")}/`) ? normalized.slice(root.length + 1) : normalized;
                    if (!tab.revision && relative === file.path) state.closeTab(tab.id, pane);
                }
            }
            setNotice(`已从提交 ${commit.id.slice(0, 8)} 恢复 ${file.path}`);
        }, true);
    }
    async function restoreRevisionDirectory(path: string) {
        setRevisionFileMenu(null);
        if (!revision) return;
        const commit = revision;
        const directoryFiles = revisionFiles.filter(file => file.path.startsWith(`${path}/`));
        if (!directoryFiles.length) return;
        const confirmed = await confirmAction(
            `用提交 ${commit.id.slice(0, 8)} 的完整快照替换本地目录“${path}”的全部内容？目录中该提交不存在的文件也会删除。`,
            { title: "恢复快照目录", confirmLabel: "覆盖目录文件", cancelLabel: "取消" }
        );
        if (!confirmed || !mounted.current || revision?.id !== commit.id) return;
        await run(async () => {
            await gitApi.restoreRevisionDirectory(root, commit.id, path);
            const state = useWorkspaceStore.getState();
            for (const pane of ["left", "right"] as const) {
                for (const tab of pane === "left" ? state.leftTabs : state.rightTabs) {
                    const normalized = tab.path.replace(/\\/g, "/");
                    const relative = normalized.startsWith(`${root.replace(/\\/g, "/")}/`) ? normalized.slice(root.length + 1) : normalized;
                    if (!tab.revision && relative.startsWith(`${path}/`)) state.closeTab(tab.id, pane);
                }
            }
            setNotice(`已从提交 ${commit.id.slice(0, 8)} 恢复目录 ${path} 的完整快照`);
        }, true);
    }
    async function fileAction(selected: GitTreeTarget[], action: "revert" | "ignore") {
        const roots = selected.filter(target => !selected.some(parent => parent.directory && parent.path !== target.path && target.path.startsWith(`${parent.path}/`)));
        setContextMenu(null);
        await run(async () => {
            await flushPendingWrites();
            const targets = files.filter(file => roots.some(target => target.directory ? file.path.startsWith(`${target.path}/`) : file.path === target.path));
            try {
                if (action === "ignore") { for (const target of roots) await gitApi.ignore(root, target.path + (target.directory ? "/*" : "")); }
                else await gitApi.revertMany(root, targets.map(file => file.path));
            } finally {
                // Close affected editors and diffs so stale content cannot overwrite the disk result.
                const state = useWorkspaceStore.getState();
                const affectedTargets = action === "revert" ? roots : [{ path: ".gitignore", directory: false }];
                for (const pane of ["left", "right"] as const) {
                    for (const tab of pane === "left" ? state.leftTabs : state.rightTabs) {
                        const path = tab.path.replace(/\\/g, "/");
                        if (!tab.revision && affectedTargets.some(target => {
                            const relative = path.startsWith(`${root.replace(/\\/g, "/")}/`) ? path.slice(root.length + 1) : path;
                            return relative === target.path || (target.directory && relative.startsWith(`${target.path}/`));
                        })) state.closeTab(tab.id, pane);
                    }
                }
                await refresh();
                panelRef.current?.focus();
            }
            if (mounted.current && action === "ignore") setNotice(`已加入 .gitignore：${roots.map(target => target.path).join("、")}（已跟踪文件仍由 Git 跟踪）`);
        });
    }
    async function undoRevert() {
        await run(async () => {
            const paths = await gitApi.undoRevert(root);
            if (!paths.length) { setNotice("没有可撤销的文件回退"); return; }
            const state = useWorkspaceStore.getState();
            for (const pane of ["left", "right"] as const) {
                for (const tab of pane === "left" ? state.leftTabs : state.rightTabs) {
                    const path = tab.path.replace(/\\/g, "/");
                    const relative = path.startsWith(`${root.replace(/\\/g, "/")}/`) ? path.slice(root.length + 1) : path;
                    if (!tab.revision && paths.includes(relative)) state.closeTab(tab.id, pane);
                }
            }
            setNotice(`已撤销回退，恢复 ${paths.length} 个文件`);
        }, true);
    }
    const operationsPending = busy || pending.size > 0;
    const resizeColumns = (index: 0 | 1, clientX: number) => {
        const bounds = columnsRef.current?.getBoundingClientRect();
        if (!bounds || bounds.width <= 4) return;
        const usableWidth = bounds.width - 4;
        const position = Math.max(0, Math.min(100, (clientX - bounds.left) / usableWidth * 100));
        if (index === 0) {
            const nextFile = Math.max(20, Math.min(70, position));
            const nextMessage = Math.max(16, Math.min(45, fileWidth + messageWidth - nextFile));
            setFileWidth(nextFile);
            setMessageWidth(nextMessage);
        } else {
            const nextMessage = Math.max(16, Math.min(45, position - fileWidth));
            setMessageWidth(nextMessage);
        }
    };
    const renderSeparator = (index: 0 | 1, label: string) => <div
        role="separator" aria-label={label} aria-orientation="vertical" tabIndex={0}
        className="ide-resize-handle ide-resize-handle-x"
        onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing(true);
        }}
        onPointerMove={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeColumns(index, event.clientX);
        }}
        onPointerUp={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            setResizing(false);
        }}
        onPointerCancel={() => setResizing(false)}
        onLostPointerCapture={() => setResizing(false)}
    />;
    return <div ref={panelRef} tabIndex={-1} className="ide-content-surface flex flex-col h-full text-xs min-h-0" onKeyDown={event => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
        if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
        event.preventDefault(); event.stopPropagation();
        if (!revision && isRepository) void undoRevert();
    }}>
        {commitMenu && <div ref={commitMenuRef} role="menu" aria-label="提交操作" style={{ left: commitMenu.x, top: commitMenu.y }} onContextMenu={event => event.preventDefault()}
            className="fixed z-50 w-60 rounded border border-ide-panel-border bg-ide-panel-bg p-1 shadow-xl">
            <button type="button" role="menuitem"
                className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left hover:bg-ide-tree-hover focus-visible:bg-ide-tree-hover"
                onClick={() => void copyCommitMessage(commitMenu.commit)}>
                <Copy size={14} />复制提交说明
            </button>
            <button type="button" role="menuitem" disabled={operationsPending}
                className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left hover:bg-ide-tree-hover disabled:opacity-40"
                onClick={() => { const commit = commitMenu.commit; setCommitMenu(null); void run(() => gitApi.openSnapshot(root, commit.id)); }}>
                <GitCommit size={14} />在隔离窗口查看完整项目
            </button>
            {commitMenu.commit.isHead && !commitMenu.commit.pushed && <button type="button" role="menuitem" disabled={operationsPending}
                className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left hover:bg-ide-tree-hover focus-visible:bg-ide-tree-hover disabled:opacity-40"
                onClick={() => void undoCommit(commitMenu.commit)}>
                <Undo2 size={14} />撤销此提交
            </button>}
        </div>}
        {revisionFileMenu && revision && <div ref={revisionFileMenuRef} role="menu" aria-label="快照文件操作" style={{ left: revisionFileMenu.x, top: revisionFileMenu.y }} onContextMenu={event => event.preventDefault()}
            className="fixed z-50 w-60 rounded border border-ide-panel-border bg-ide-panel-bg p-1 shadow-xl">
            <button type="button" role="menuitem" disabled={operationsPending}
                className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left hover:bg-ide-tree-hover focus-visible:bg-ide-tree-hover disabled:opacity-40"
                onClick={() => revisionFileMenu.directory ? void restoreRevisionDirectory(revisionFileMenu.directory) : revisionFileMenu.file && void restoreRevisionFile(revisionFileMenu.file)}>
                <Undo2 size={14} />{revisionFileMenu.directory ? "用此提交覆盖目录下所有文件" : revisionFileMenu.file?.status === "删除" ? "用此提交删除本地文件" : "用此提交覆盖本地文件"}
            </button>
        </div>}
        {contextMenu && <div ref={contextMenuRef} role="group" aria-label="文件操作" style={{ left: contextMenu.x, top: contextMenu.y }} onContextMenu={event => event.preventDefault()}
                             className="fixed z-50 w-52 rounded border border-ide-panel-border bg-ide-panel-bg p-1 shadow-xl">
            <button type="button" disabled={operationsPending} className="block w-full rounded-sm px-3 py-2 text-left hover:bg-ide-tree-hover focus-visible:bg-ide-tree-hover disabled:opacity-40" onClick={() => void fileAction(contextMenu.targets, "revert")}>{contextMenu.targets.length > 1 ? `回退所选 ${contextMenu.targets.length} 项` : contextMenu.targets[0].directory ? "回退目录下所有文件" : "回退文件"}</button>
            <button type="button" disabled={operationsPending || contextMenu.targets.some(target => target.path === ".gitignore")} className="block w-full rounded-sm px-3 py-2 text-left hover:bg-ide-tree-hover focus-visible:bg-ide-tree-hover disabled:opacity-40" onClick={() => void fileAction(contextMenu.targets, "ignore")}>加入 .gitignore</button>
        </div>}
        <div className="flex items-center gap-3 px-2 py-1 border-b border-ide-panel-border">
            <button className={revision ? "text-gray-400 hover:text-white" : "text-blue-400"} onClick={returnToLocal}>本地更改 ({files.length})</button>
            <button title="刷新 Git 状态" aria-label="刷新 Git 状态" disabled={operationsPending} onClick={() => void run(refresh)}><RefreshCw size={14} /></button>
            {revision ? <span className="text-blue-400 truncate">历史快照 {revision.id.slice(0, 8)}</span> : <span className="text-gray-400">勾选暂存 · 点击文件查看差异</span>}
        </div>
        {error && <p role="alert" className="text-red-400 px-2 whitespace-pre-wrap">{error}</p>}
        {notice && <p role="status" className="text-green-400 px-2">{notice}</p>}
        <div ref={columnsRef} className="flex flex-1 min-h-0 overflow-auto" style={resizing ? { cursor: "ew-resize", userSelect: "none" } : undefined}>
            <div className="min-w-0 shrink-0 overflow-auto p-2" style={{ width: `${fileWidth}%` }}>
                {revision ? loadingRevision ? <p className="text-gray-400">正在读取提交文件…</p> : <>
                    <p className="text-gray-500 mb-1">提交更改 ({revisionFiles.length}) · {revision.parents.length > 1 ? "相对第一父提交" : "相对父提交"} · 点击查看差异</p>
                    {!revisionFiles.length && <p className="text-gray-400">此提交没有文件差异</p>}
                    <GitFileTree key={revision.id} files={revisionFiles} onDirectoryContextMenu={(event, path) => {
                        if (!operationsPending && revisionFiles.some(file => file.path.startsWith(`${path}/`))) setRevisionFileMenu({ directory: path, x: Math.max(0, Math.min(event.clientX, window.innerWidth - 280)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 48)) });
                    }} renderFile={(file, name) => <button className={`flex items-center gap-2 text-left w-full py-1 hover:bg-ide-tree-hover ${file.status === "新增" ? "text-green-400" : file.status === "删除" ? "text-red-400" : "text-blue-400"}`} title={file.path} onClick={() => void run(() => openRevisionFile(file.path))} onContextMenu={event => {
                        event.preventDefault(); event.stopPropagation();
                        if (!operationsPending) setRevisionFileMenu({ file, x: Math.max(0, Math.min(event.clientX, window.innerWidth - 248)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 48)) });
                    }}><span className="truncate">{name}</span><span className="shrink-0">{file.status}</span></button>} />
                </> : <>
                    {!files.length && (isRepository === false ? <div className="flex flex-col items-start gap-2 text-sm text-gray-400">
                        <span>当前项目尚未初始化 Git 仓库。</span>
                        <button type="button" disabled={operationsPending} onClick={() => void initializeRepository()} className="rounded bg-ide-accent px-3 py-1.5 text-white disabled:opacity-50">{busy ? "正在初始化..." : "初始化 Git"}</button>
                    </div> : isRepository === null ? <p className="text-gray-400">正在检查 Git 状态...</p> : !error && <p className="text-gray-400">工作区干净</p>)}
                    <GitFileTree files={files} onContextMenu={(event, targets) => {
                        event.preventDefault(); event.stopPropagation();
                        if (!operationsPending) setContextMenu({ targets, x: Math.max(0, Math.min(event.clientX, window.innerWidth - 208)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 90)) });
                    }} selection={{ checked: file => file.staged, eligible: file => !file.conflict, pending: file => pending.has(file.path), disabled: busy, onChange: stageMany }} renderFile={(file, name) => <div className={`flex items-center gap-2 py-1 rounded cursor-pointer hover:bg-ide-tree-hover ${file.conflict ? "text-orange-400" : file.status === "新增" ? "text-green-400" : file.status === "删除" ? "text-red-400" : "text-blue-400"}`} onClick={() => void run(() => openDiff(file, !file.unstaged))}>
                        <input type="checkbox" className="shrink-0 accent-blue-500 cursor-pointer disabled:cursor-wait" onClick={event => event.stopPropagation()} aria-label={`暂存 ${file.path}`} checked={file.staged} disabled={busy || pending.has(file.path) || file.conflict} onChange={e => stageMany([file], e.currentTarget.checked)} />
                        <span className="min-w-0 flex-1 truncate" title={file.path}>{name}</span>
                        <span className="shrink-0">{file.status}</span>
                        {pending.has(file.path) ? <span className="text-gray-400 shrink-0">暂存处理中…</span> : file.staged && <button className="shrink-0 text-green-400" onClick={event => { event.stopPropagation(); void run(() => openDiff(file, true)); }}>已暂存</button>}
                        {file.staged && file.unstaged && <span title="暂存后又有修改" className="text-yellow-400">+修改</span>}
                    </div>} />
                </>}
            </div>
            {renderSeparator(0, "调整文件预览与提交说明宽度")}
            <div className="box-border min-w-[13rem] shrink-0 p-2 flex flex-col gap-2" style={{ width: `${messageWidth}%` }}>
                <textarea ref={textareaRef} aria-label="提交说明" value={revision?.message ?? message} onChange={e => changeMessage(e.target.value)} onKeyDown={navigateMessageHistory} onPointerDown={() => setSpeechTarget({ kind: "git" })} onFocus={() => setSpeechTarget({ kind: "git" })} title="↑/↓ 切换历史提交说明（首行/末行）" disabled={busy || !!revision} placeholder={revision ? "历史预览中，返回本地后提交" : "提交说明…"} className="flex-1 min-h-12 resize-none bg-ide-bg border border-ide-panel-border p-2 focus:outline-none" />
                <div className="flex justify-start gap-2">
                    <button className="flex w-24 shrink-0 items-center justify-center gap-1 bg-ide-accent text-white py-1 enabled:hover:brightness-110 disabled:bg-gray-700 disabled:text-gray-400 disabled:opacity-100" disabled={operationsPending || !!revision || !message.trim() || !files.some(f => f.staged) || files.some(f => f.conflict)} onClick={() => void run(async () => {
                        // run(..., true) has flushed editor writes; update only selected index entries.
                        for (const file of files.filter(file => file.staged && !file.conflict)) {
                            await gitApi.stage(root, file.path, true);
                        }
                        const id = await gitApi.commit(root, message);
                        if (mounted.current) { changeMessage(""); setNotice(`提交成功 ${id.slice(0, 8)}`); }
                    }, true)}><GitCommit size={14} aria-hidden="true" />{busy ? "处理中…" : "提交"}</button>
                    <button className="flex w-24 shrink-0 items-center justify-center gap-1 border border-emerald-600 bg-emerald-700 text-white enabled:bg-emerald-600 enabled:hover:bg-emerald-500 disabled:border-emerald-800 disabled:bg-emerald-900 disabled:text-gray-300" disabled={!hasRemote || operationsPending || !!revision || !log.some(commit => !commit.pushed)} title={hasRemote ? "推送当前分支到远程" : "请先在版本控制设置中配置远程仓库"} onClick={() => void run(async () => {
                        await gitApi.push(root);
                        if (mounted.current) setNotice("推送成功");
                    }, true)}><Upload size={14} aria-hidden="true" />推送</button>
                </div>
            </div>
            {renderSeparator(1, "调整提交说明与提交历史宽度")}
            <div className="flex-1 min-w-[16rem] shrink-0 min-h-0 flex flex-col p-2">
                <p className="mb-2 shrink-0">提交历史（点击浏览文件）</p>
                <input type="search" aria-label="搜索提交说明" placeholder="搜索提交说明…" title="按提交说明筛选已加载的历史，支持加载更多" value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} className="mb-2 w-full shrink-0 bg-ide-bg border border-ide-panel-border p-2 focus:outline-none focus:border-ide-accent" />
                <div className="min-h-0 flex-1 overflow-auto">
                {!log.length && <p className="text-gray-400">暂无提交</p>}
                {!!log.length && !filteredLog.length && <p role="status" className="text-gray-400">已加载的历史中没有匹配的提交</p>}
                {filteredLog.map(c => <button key={c.id} className={`block w-full text-left border-l pl-3 pb-3 relative hover:bg-ide-tree-hover ${revision?.id === c.id ? "border-blue-400 bg-ide-selection" : c.pushed ? "border-emerald-500" : "border-amber-500"}`} onClick={() => void selectRevision(c)} onContextMenu={event => {
                    event.preventDefault(); event.stopPropagation();
                    setCommitMenu({ commit: c, x: Math.max(0, Math.min(event.clientX, window.innerWidth - 248)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - (c.isHead && !c.pushed ? 132 : 92))) });
                }} title={`${c.message}\n${c.pushed ? "已推送到远程" : "尚未推送到远程"}`} aria-pressed={revision?.id === c.id}>
                    <span className={`absolute -left-1 ${c.pushed ? "text-emerald-400" : "text-amber-400"}`} aria-label={c.pushed ? "已推送" : "未推送"}>●</span>
                    <div className="git-commit-message" title={c.message}><code className={c.pushed ? "text-emerald-400" : "text-amber-400"}>{c.id.slice(0, 8)}</code> {c.message.split("\n")[0]} <span className="text-green-400">{c.refs.join(", ")}</span></div>
                    <div className="text-gray-400">{c.author} · {new Date(c.time * 1000).toLocaleString()}</div>
                    <div className="text-gray-500">{c.parents.length ? `↳ ${c.parents.map(p => p.slice(0, 8)).join(" + ")}` : "根提交"}{c.parents.length > 1 ? " (合并)" : ""}</div>
                </button>)}
                {log.length === limit && limit < 2000 && <button disabled={operationsPending} onClick={() => setLimit(n => n + 100)}>加载更多</button>}
                </div>
            </div>
        </div>
    </div>;
}
