import { isWithinPath, normalizePath, pathKey, pathName, pathTitles, samePath } from "@/utils/paths";
import { isSnapshot } from "@/utils/snapshot";
import { fileOperationHistory } from "@/utils/fileOperationHistory";
import { showError } from "@/utils/dialogs";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { globalJsonStorage, settingsStorage } from "@/utils/globalSettings";
import debounce from "lodash/debounce";
import { buildTreeStatuses } from "@/utils/fileTreeAppearance";
import { gitApi, type TreeFileStatus } from "@/utils/api";
import { fsApi } from "@/utils/api";
import type { ReverseTreeNode } from "@/utils/treeGraph";
import { invokePathCommand as invoke, isRemotePath, remotePath } from "@/utils/remote";
import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import { useTerminalStore } from "./terminalStore";
import { restoreProjectLayout, useLayoutStore } from "./layoutStore";

export interface Tab {
  id: string;
  title: string;
  path: string;
  content?: string;
  diff?: string;
  diffStaged?: boolean;
  diffReadOnly?: boolean;
  diffLabels?: [string, string];
  diffContext?: { root: string; path: string };
  diffEntry?: { edge: "first" | "last"; token: number };
  imageDiff?: { repoPath: string; staged: boolean; commitId?: string };
  revision?: string;
  isDirty?: boolean;
  saveError?: string;
  diskVersion?: string;
  reloadToken?: number;
  markdownMode?: "source" | "preview" | "split"; // 适用于 Markdown, Tree, HTTP 文件的视图模式
  htmlRoot?: string;
  browser?: { root: string; url: string; homeHistory?: { url: string; title: string } };
  suppressInitialDownloads?: boolean;
  isPinned?: boolean;
  isExternal?: boolean;
  readOnly?: boolean;
  reverseTree?: ReverseTreeNode;
}

export const MUSIC_HOME = "nexusdesk:music";
export const VIDEO_HOME = "nexusdesk:video";
export const CHAT_HOME = "nexusdesk:chat";
export const MIRROR_HOME = "nexusdesk:mirror";

function persistedPinnedTabs(tabs: Tab[]): Tab[] {
  return tabs.filter(tab => tab.isPinned).map(tab => {
    const { content, isDirty, saveError, diskVersion, reloadToken, suppressInitialDownloads, ...metadata } = tab;
    // Virtual views need their snapshot; ordinary files are read again at startup.
    return tab.reverseTree || tab.revision || tab.diff !== undefined ? { ...metadata, content } : metadata;
  });
}

function pinnedTabsByProject(state: WorkspaceState) {
  if (!state.rootPath || !state.pinnedTabsRestored) return state.projectPinnedTabs;
  return { ...state.projectPinnedTabs, [normalizePath(state.rootPath)]: {
    left: persistedPinnedTabs(state.leftTabs), right: persistedPinnedTabs(state.rightTabs),
  } };
}

type ProjectSession = {
  left: Tab[]; right: Tab[]; activeLeft: string | null; activeRight: string | null;
  focusedPane: PaneType; sidebarMode: SidebarMode;
};
function sessionsByProject(state: WorkspaceState) {
  if (!state.rootPath || !state.pinnedTabsRestored) return state.projectSessions;
  const metadata = (tabs: Tab[]) => tabs.map(tab => {
    const { content, isDirty, saveError, diskVersion, reloadToken, suppressInitialDownloads, ...rest } = tab;
    return tab.reverseTree || tab.revision || tab.diff !== undefined ? { ...rest, content } : rest;
  });
  return { ...state.projectSessions, [savedPathKey(state.rootPath)]: {
    left: metadata(state.leftTabs), right: metadata(state.rightTabs),
    activeLeft: state.activeLeftTabId, activeRight: state.activeRightTabId,
    focusedPane: state.focusedPane, sidebarMode: state.sidebarMode,
  } };
}

type PaneType = "left" | "right";
type SidebarMode = "physical" | "logical" | "graph";

// Keep immutable editor documents outside Zustand until typing pauses.
const editorChanges = new Map<string, { id: string; pane: PaneType; doc: { toString(): string } }>();
const syncEditorChanges = debounce(() => flushEditorContent(), 200, { maxWait: 1000 });

export function hasPendingEditorContent(id: string, pane: PaneType) {
  return editorChanges.has(`${pane}:${id}`);
}

export function queueEditorContent(id: string, doc: { toString(): string }, pane: PaneType) {
  if (isSnapshot) return;
  const state = useWorkspaceStore.getState();
  const tab = (pane === "left" ? state.leftTabs : state.rightTabs).find(tab => tab.id === id);
  if (!tab || tab.revision || tab.browser) return;
  editorChanges.set(`${pane}:${id}`, { id, pane, doc });
  syncEditorChanges();
}

export function flushEditorContent() {
  syncEditorChanges.cancel();
  const changes = [...editorChanges.values()];
  editorChanges.clear();
  for (const { id, pane, doc } of changes) {
    useWorkspaceStore.getState().updateTabContent(id, doc.toString(), pane);
  }
}

// Serialize writes for each file so an older edit cannot overwrite a newer one.
const pendingWrites = new Map<string, Promise<void>>();

const savedPathKey = pathKey;

type SaveEntry = { path: string; title: string; pane: PaneType; content: string; saved: string | undefined; version?: string; error?: string; schedule: ReturnType<typeof debounce> };
const saves = new Map<string, SaveEntry>();

function isEditableFile(tab: Tab) {
  return !tab.revision && !tab.diffReadOnly && !tab.diffStaged && !tab.readOnly && !tab.browser && !tab.reverseTree;
}

function ensureSaveEditor(entry: SaveEntry, focus = false) {
  const state = useWorkspaceStore.getState();
  const left = state.leftTabs.find(tab => samePath(tab.path, entry.path) && isEditableFile(tab));
  const tab = left ?? state.rightTabs.find(tab => samePath(tab.path, entry.path) && isEditableFile(tab));
  if (tab) {
    if (focus) state.setActiveTab(tab.id, left ? "left" : "right");
    return;
  }
  // 从内存恢复，文件已删除或无法读取时也不能丢失编辑入口。
  state.openTab({ id: normalizePath(entry.path), path: entry.path, title: entry.title,
    content: entry.content, diskVersion: entry.version, isDirty: true, saveError: entry.error }, { pane: entry.pane });
}

export class FileSaveError extends Error {
  constructor(public readonly issues: { path: string; kind: "conflict" | "write" | "unsaved"; message: string }[]) {
    super(`以下文件尚未保存，请处理后重试：\n${issues.map(issue => `${issue.path}：${issue.message}`).join("\n")}`);
    this.name = "FileSaveError";
  }
}

const CONFLICT_ERROR = "FILE_CONFLICT: 文件已被其他程序修改，自动保存已暂停。请查看差异、载入磁盘版本或确认覆盖保存。";

export function isFileConflict(error?: string) {
  return !!error?.includes("FILE_CONFLICT:");
}

function markFile(path: string, content: string, isDirty: boolean, saveError?: string) {
  const update = (tabs: Tab[]) => tabs.map(tab => samePath(tab.path, path) && !tab.revision && !tab.diffReadOnly && !tab.diffStaged && tab.content === content
    ? { ...tab, isDirty, saveError } : tab);
  useWorkspaceStore.setState(state => ({ leftTabs: update(state.leftTabs), rightTabs: update(state.rightTabs) }));
}

function saveFile(path: string) {
  const key = pathKey(path);
  const entry = saves.get(key);
  if (!entry || pendingWrites.has(key) || isFileConflict(entry.error)) return;
  const write = Promise.resolve().then(async () => {
    do {
      const content = entry.content;
      if (entry.saved === content && !entry.error) {
        markFile(path, content, false);
        return;
      }
      try {
        let logicalChanged: boolean;
        if (isRemotePath(path)) {
          logicalChanged = await fsApi.writeFile(path, content);
        } else {
          entry.version ??= await fsApi.textVersion(entry.saved ?? "");
          const result = await fsApi.writeFileSnapshot(path, content, entry.version);
          entry.version = result.version;
          logicalChanged = result.logicalChanged;
        }
        entry.saved = content;
        entry.error = undefined;
        const updateVersion = (tabs: Tab[]) => tabs.map(tab => samePath(tab.path, path) && !tab.revision && !tab.diffReadOnly && !tab.diffStaged
          ? { ...tab, diskVersion: entry.version } : tab);
        useWorkspaceStore.setState(state => ({ leftTabs: updateVersion(state.leftTabs), rightTabs: updateVersion(state.rightTabs) }));
        markFile(path, content, false);
        if (logicalChanged) await useWorkspaceStore.getState().fetchLogicalTree();
        else useWorkspaceStore.setState(state => ({ indexRevision: state.indexRevision + 1 }));
      } catch (error) {
        entry.error = isFileConflict(String(error)) ? CONFLICT_ERROR : String(error);
        entry.schedule.cancel();
        markFile(path, entry.content, true, entry.error);
        ensureSaveEditor(entry);
        console.error("Failed to save file:", path, error);
        return;
      }
    } while (entry.content !== entry.saved && !entry.error);
  }).finally(() => {
    if (pendingWrites.get(key) === write) pendingWrites.delete(key);
  });
  pendingWrites.set(key, write);
}

export async function resolveFileConflict(path: string, action: "reload" | "overwrite" | "compare") {
  flushEditorContent();
  await pendingWrites.get(pathKey(path));
  const entry = saves.get(pathKey(path));
  if (!entry || !isFileConflict(entry.error)) return;
  ensureSaveEditor(entry, true);
  const snapshot = await fsApi.readFileSnapshot(entry.path, true);
  flushEditorContent();
  if (saves.get(pathKey(path)) !== entry || !isFileConflict(entry.error)) return;
  if (action === "compare") {
    const content = entry.content;
    const diff = await fsApi.compareText(snapshot.content, content);
    useWorkspaceStore.getState().openTab({
      id: `conflict:${entry.path}:${Date.now()}`, path: entry.path, title: `${entry.title} · 保存冲突`,
      content, diff, diffReadOnly: true, diffLabels: ["磁盘版本", "编辑版本"],
    });
    return;
  }
  entry.schedule.cancel();
  entry.version = snapshot.version;
  entry.saved = snapshot.content;
  entry.error = undefined;
  if (action === "reload") entry.content = snapshot.content;
  const update = (tabs: Tab[]) => tabs.map(item => samePath(item.path, entry.path) && isEditableFile(item)
    ? { ...item, content: entry.content, diskVersion: snapshot.version, reloadToken: action === "reload" ? (item.reloadToken ?? 0) + 1 : item.reloadToken,
      isDirty: action === "overwrite", saveError: undefined } : item);
  useWorkspaceStore.setState(current => ({ leftTabs: update(current.leftTabs), rightTabs: update(current.rightTabs) }));
  if (action === "overwrite") {
    saveFile(entry.path);
    await pendingWrites.get(pathKey(entry.path));
    if (entry.error) throw new Error(entry.error);
  }
}

function markExternalConflict(path: string) {
  const entry = saves.get(pathKey(path));
  if (entry) {
    entry.error = CONFLICT_ERROR;
    entry.schedule.cancel();
    markFile(path, entry.content, true, entry.error);
  }
}

export function retryFileSave(path: string) {
  saves.get(pathKey(path))?.schedule.cancel();
  saveFile(path);
}

export async function flushPendingWrites() {
  flushEditorContent();
  for (const entry of saves.values()) entry.schedule.flush();
  while (pendingWrites.size) await Promise.all([...pendingWrites.values()]);
  const failed = [...saves.values()].filter(entry => entry.error || entry.content !== entry.saved);
  if (failed.length) {
    for (const entry of failed) ensureSaveEditor(entry);
    ensureSaveEditor(failed[0], true);
    throw new FileSaveError(failed.map(entry => ({ path: entry.path,
      kind: isFileConflict(entry.error) ? "conflict" : entry.error ? "write" : "unsaved",
      message: entry.error ?? "仍有未保存的编辑" })));
  }
}

export async function restoreLocalVersion(path: string, content: string) {
  await flushPendingWrites();
  let version: string | undefined;
  if (isRemotePath(path)) await fsApi.writeFile(path, content);
  else {
    const snapshot = await fsApi.readFileSnapshot(path, true);
    version = (await fsApi.writeFileSnapshot(path, content, snapshot.version!)).version;
  }
  const entry = saves.get(pathKey(path));
  if (entry) { entry.schedule.cancel(); entry.content = content; entry.saved = content; entry.version = version; entry.error = undefined; }
  const update = (tabs: Tab[]) => tabs.map(tab => samePath(tab.path, path) && !tab.revision && tab.diff === undefined
    ? { ...tab, content, diskVersion: version, isDirty: false, saveError: undefined } : tab);
  useWorkspaceStore.setState(state => ({ leftTabs: update(state.leftTabs), rightTabs: update(state.rightTabs) }));
  await useWorkspaceStore.getState().fetchLogicalTree();
}

function resolveTabTitles(leftTabs: Tab[], rightTabs: Tab[], rootPath: string | null): { leftTabs: Tab[], rightTabs: Tab[] } {
  const allTabs = [...leftTabs, ...rightTabs];
  const normalTabs = allTabs.filter(t => t.diff === undefined && !t.revision && !t.reverseTree && !t.browser);
  const titleMap = pathTitles(normalTabs.map(tab => tab.path));

  const updateTabs = (tabs: Tab[]) => tabs.map(tab => {
    const newTitle = tab.diff !== undefined || tab.revision || tab.reverseTree || tab.browser ? tab.title : titleMap.get(pathKey(tab.path)) || pathName(tab.path);
    // Git comparisons and temporary generated views do not represent external files.
    const isExternal = tab.diff === undefined && !tab.revision && !tab.reverseTree && !tab.browser && rootPath ? !isPathInProject(tab.path, rootPath) : false;
    if (tab.title === newTitle && tab.isExternal === isExternal) return tab;
    return { ...tab, title: newTitle, isExternal };
  });

  return {
    leftTabs: updateTabs(leftTabs),
    rightTabs: updateTabs(rightTabs)
  };
}

function sortTabs(tabs: Tab[]) {
  const pinned = tabs.filter(t => t.isPinned);
  const unpinned = tabs.filter(t => !t.isPinned);
  return [...pinned, ...unpinned];
}

const isPathInProject = isWithinPath;
const parentPath = (path: string) => {
  if (path.startsWith("sftp://")) {
    const { id, path: remote } = remotePath(path);
    return `sftp://${id}${remote.slice(0, remote.lastIndexOf("/")) || "/"}`;
  }
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(0, index === 2 && path[1] === ":" ? 3 : Math.max(index, 1));
};
let projectVersion = 0;
let treeStatusRequest = 0;
let logicalTreeRequest = 0;
const logicalTreeRefreshes = new Map<number, { pending: boolean; request: Promise<void> }>();
const directoryRequests = new Map<string, Promise<void>>();
const loadedDirectories = new Set<string>();

const preserveLoadedChildren = (previous: any[], incoming: any[]): any[] => {
  const existing = new Map(previous.map(node => [pathKey(node.id), node]));
  return incoming.map(node => {
    const old = existing.get(pathKey(node.id));
    return old?.children?.length && node.children?.length === 0
      ? { ...node, children: old.children } : node;
  });
};

// Preserve unchanged branches so a refresh only replaces the affected directory.
const replaceChildren = (nodes: any[], path: string, children: any[]): any[] => {
  let changed = false;
  const next = nodes.map(node => {
    if (samePath(node.id, path)) {
      changed = true;
      return { ...node, children: preserveLoadedChildren(node.children ?? [], children) };
    }
    if (!node.children?.length) return node;
    const updated = replaceChildren(node.children, path, children);
    if (updated === node.children) return node;
    changed = true;
    return { ...node, children: updated };
  });
  return changed ? next : nodes;
};

interface WorkspaceState {
  remoteLabel: string | null;
  disconnectRemote: () => Promise<void>;
  rootPath: string | null;
  partitionSearchPaths: string[] | null;
  setPartitionSearchPaths: (paths: string[] | null) => void;
  searchScopePath: string | null;
  setSearchScopePath: (path: string | null) => void;
  fileTreeData: any[];
  treeStatuses: Record<string, TreeFileStatus>;
  refreshTreeStatuses: () => Promise<void>;
  logicalTreeData: any[];
  indexRevision: number;
  sidebarMode: SidebarMode;
  recentProjects: string[];
  projectPinnedTabs: Record<string, { left: Tab[]; right: Tab[] }>;
  projectSessions: Record<string, ProjectSession>;
  projectTreeOpenState: Record<string, Partial<Record<"physical" | "logical", Record<string, boolean>>>>;
  setTreeNodeOpen: (project: string, mode: "physical" | "logical", id: string, open: boolean) => void;
  pinnedTabsRestored: boolean;
  restorePinnedTabs: () => Promise<void>;

  leftTabs: Tab[];
  rightTabs: Tab[];
  activeLeftTabId: string | null;
  activeRightTabId: string | null;

  focusedPane: PaneType;
  isSplitMode: boolean;

  locateSignal: number;
  locatePath: string | null;
  editorJump: { path: string; line: number; pane: PaneType; from?: number; to?: number } | null;
  graphLocation: { path: string; line: number; pane: PaneType } | null;
  locateGraph: (path: string, line: number, pane: PaneType) => void;
  triggerLocate: (path?: string) => void;

  navHistory: Array<{ path: string; pos: number }>;
  navIndex: number;
  pushNavLocation: (path: string, pos: number) => void;
  navigateHistory: (direction: "back" | "forward") => Promise<void>;

  loadDirectory: (path: string, logical?: boolean, refresh?: boolean) => Promise<void>;
  setProject: (path: string) => Promise<boolean>;
  closeProject: () => Promise<void>;
  setSidebarMode: (mode: SidebarMode) => void;
  fetchLogicalTree: () => Promise<void>;
  createLogicalFolder: (name: string) => Promise<void>;
  moveLogicalNode: (paths: string[], newType: string) => Promise<void>;
  deletePhysicalEntry: (path: string) => Promise<void>;
  movePhysicalEntry: (sourcePath: string, targetDir: string, name?: string, opts?: any) => Promise<void>;
  copyFileToPhysical: (sourcePath: string, targetDir: string, opts?: any) => Promise<void>;
  createPhysicalFile: (path: string) => Promise<void>;
  createPhysicalFolder: (path: string) => Promise<void>;

  openTab: (tab: Tab, options?: { background?: boolean; pane?: PaneType }) => void;
  returnFromRevision: (root: string) => void;
  closeTab: (id: string, pane: PaneType) => void;
  closeOtherTabs: (id: string, pane: PaneType) => void;
  closeLeftTabs: (id: string, pane: PaneType) => void;
  closeRightTabs: (id: string, pane: PaneType) => void;
  setActiveTab: (id: string, pane: PaneType) => void;
  updateTabContent: (id: string, content: string, pane: PaneType) => void;
  setMarkdownMode: (id: string, pane: PaneType, mode: NonNullable<Tab["markdownMode"]>) => void;
  toggleTabPin: (id: string, pane: PaneType) => void;

  splitRight: (id: string, sourcePane: PaneType) => void;
  closeSplit: () => void;
  setFocusedPane: (pane: PaneType) => void;

  reorderTabs: (pane: PaneType, oldIndex: number, newIndex: number) => void;
  moveTabAcrossPanes: (tabId: string, sourcePane: PaneType, targetPane: PaneType, newIndex: number) => void;
}

const resolveSplitMode = (
  isSplitMode: boolean,
  leftTabs: Tab[],
  rightTabs: Tab[],
  activeLeftTabId: string | null,
  activeRightTabId: string | null,
  focusedPane: PaneType,
  rootPath: string | null
) => {
  let finalLeft = leftTabs;
  let finalRight = rightTabs;
  let finalActiveLeft = activeLeftTabId;
  let finalActiveRight = activeRightTabId;
  let finalSplit = isSplitMode;
  let finalFocused = focusedPane;

  if (isSplitMode) {
    if (leftTabs.length === 0 && rightTabs.length > 0) {
      finalLeft = rightTabs;
      finalRight = [];
      finalActiveLeft = activeRightTabId;
      finalActiveRight = null;
      finalSplit = false;
      finalFocused = "left";
    } else if (rightTabs.length === 0) {
      finalRight = [];
      finalActiveRight = null;
      finalSplit = false;
      finalFocused = "left";
    }
  }

  const resolved = resolveTabTitles(finalLeft, finalRight, rootPath);

  return {
    leftTabs: resolved.leftTabs,
    rightTabs: resolved.rightTabs,
    activeLeftTabId: finalActiveLeft,
    activeRightTabId: finalActiveRight,
    isSplitMode: finalSplit,
    focusedPane: finalFocused,
  };
};

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => {
      let historyRequest = 0;
      const setTabs = (update: (state: WorkspaceState) => Partial<WorkspaceState>) => {
        flushEditorContent();
        set(update);
      };
      const closeTabs = (update: (state: WorkspaceState) => Partial<WorkspaceState>) => {
        flushEditorContent();
        const state = get();
        const next = update(state);
        const remaining = [...(next.leftTabs ?? state.leftTabs), ...(next.rightTabs ?? state.rightTabs)];
        const orphaned = [...state.leftTabs, ...state.rightTabs].find(tab => isFileConflict(tab.saveError)
          && !remaining.some(item => samePath(item.path, tab.path) && isEditableFile(item)));
        if (orphaned) {
          showError(`请先处理「${orphaned.title}」的保存冲突，再关闭标签页。`);
          return;
        }
        set(next);
      };
      return ({
      rootPath: null,
      partitionSearchPaths: null,
      setPartitionSearchPaths: (paths) => set({ partitionSearchPaths: paths }),
      searchScopePath: null,
      setSearchScopePath: (path) => set({ searchScopePath: path }),
      remoteLabel: null,
      disconnectRemote: async () => {
        const root = get().rootPath;
        if (!isRemotePath(root)) return;
        await flushPendingWrites();
        const { id } = remotePath(root);
        const prefix = `sftp://${id}/`;
        for (const session of useTerminalStore.getState().sessions) {
          if (session.remoteId === id) useTerminalStore.getState().removeSession(session.id);
        }
        for (const [key, entry] of saves) if (entry.path.startsWith(prefix)) { entry.schedule.cancel(); saves.delete(key); }
        ++projectVersion;
        loadedDirectories.clear();
        set(state => {
          const leftTabs = state.leftTabs.filter(tab => !tab.path.startsWith(prefix));
          const rightTabs = state.rightTabs.filter(tab => !tab.path.startsWith(prefix));
          return { rootPath: null, remoteLabel: null, fileTreeData: [], treeStatuses: {}, logicalTreeData: [],
            ...resolveSplitMode(state.isSplitMode, leftTabs, rightTabs, leftTabs[leftTabs.length - 1]?.id ?? null, rightTabs[rightTabs.length - 1]?.id ?? null, state.focusedPane, null) };
        });
        await tauriInvoke("close_remote", { id });
      },
      fileTreeData: [],
      treeStatuses: {},
      refreshTreeStatuses: async () => {
        const root = get().rootPath;
        const version = projectVersion;
        const request = ++treeStatusRequest;
        if (!root || isRemotePath(root)) return;
        try {
          const entries = await gitApi.treeStatus(root);
          if (version === projectVersion && request === treeStatusRequest && get().rootPath === root)
            set({ treeStatuses: buildTreeStatuses(entries, root) });
        } catch (error) { console.error("Failed to load tree status:", error); }
      },
      logicalTreeData: [],
      indexRevision: 0,
      sidebarMode: "physical",
      recentProjects: [],
      projectPinnedTabs: {},
      projectSessions: {},
      projectTreeOpenState: {},
      setTreeNodeOpen: (project, mode, id, open) => set(state => {
        if (state.rootPath !== project) return state;
        const key = normalizePath(project);
        const projectState = state.projectTreeOpenState[key] ?? {};
        const nodes = { ...projectState[mode] };
        if (open) nodes[id] = true;
        else delete nodes[id];
        return { projectTreeOpenState: { ...state.projectTreeOpenState,
          [key]: { ...projectState, [mode]: nodes } } };
      }),
      pinnedTabsRestored: false,
      restorePinnedTabs: async () => {
        const root = get().rootPath;
        const version = projectVersion;
        if (isSnapshot || !root || get().pinnedTabsRestored) return;
        const session = get().projectSessions[savedPathKey(root)];
        const saved = session ?? get().projectPinnedTabs[normalizePath(root)] ?? { left: [], right: [] };
        const restore = async (tabs: Tab[]) => (await Promise.all(tabs.map(async tab => {
          try {
            const snapshot = tab.browser || tab.reverseTree || tab.revision || tab.diff !== undefined || tab.path === MUSIC_HOME || tab.path === VIDEO_HOME
              ? { content: tab.content, version: undefined } : await fsApi.readFileSnapshot(tab.path);
            return { ...tab, content: snapshot.content, diskVersion: snapshot.version, isPinned: session ? !!tab.isPinned : true, isDirty: false, saveError: undefined,
              suppressInitialDownloads: !!tab.browser };
          } catch (error) {
            console.error("Failed to restore pinned tab:", tab.path, error);
            return null;
          }
        }))).filter((tab): tab is NonNullable<typeof tab> => tab !== null);
        const [left, right] = await Promise.all([restore(saved.left), restore(saved.right)]);
        if (get().rootPath !== root || projectVersion !== version) return;
        set(state => {
          // 浏览器可能从另一项目保留在不同栏，恢复会话时优先复用现有实例。
          const browserIds = new Set([...state.leftTabs, ...state.rightTabs]
            .filter(tab => tab.browser).map(tab => tab.id));
          const merge = (current: Tab[], restored: Tab[]) => sortTabs([...current.map(tab =>
            restored.some(item => item.id === tab.id) ? { ...tab, isPinned: restored.find(item => item.id === tab.id)!.isPinned } : tab),
            ...restored.filter(tab => {
              if (current.some(item => item.id === tab.id)) return false;
              if (tab.browser) {
                if (browserIds.has(tab.id)) return false;
                browserIds.add(tab.id);
              }
              return true;
            })]);
          const leftTabs = merge(state.leftTabs, left);
          const rightTabs = merge(state.rightTabs, right);
          return { ...resolveSplitMode(state.isSplitMode || rightTabs.length > 0, leftTabs, rightTabs,
            state.activeLeftTabId ?? leftTabs.find(tab => tab.id === session?.activeLeft)?.id ?? leftTabs[0]?.id ?? null,
            state.activeRightTabId ?? rightTabs.find(tab => tab.id === session?.activeRight)?.id ?? rightTabs[0]?.id ?? null, session?.focusedPane ?? state.focusedPane, state.rootPath),
            sidebarMode: session?.sidebarMode ?? state.sidebarMode,
            pinnedTabsRestored: true };
        });
      },

      leftTabs: [],
      rightTabs: [],
      activeLeftTabId: null,
      activeRightTabId: null,

      focusedPane: "left",
      isSplitMode: false,

      locateSignal: 0,
      locatePath: null,
      editorJump: null,
      graphLocation: null,
      locateGraph: (path, line, pane) => set(state => ({ graphLocation: { path, line, pane }, editorJump: { path, line, pane }, focusedPane: pane, locatePath: null, locateSignal: state.locateSignal + 1 })),
      triggerLocate: (path) => set(state => ({ locatePath: path ?? null, locateSignal: state.locateSignal + 1 })),

      navHistory: [],
      navIndex: -1,

      pushNavLocation: (path, pos) => set(state => {
        const last = state.navHistory[state.navIndex];
        if (last && samePath(last.path, path) && Math.abs(last.pos - pos) < 15) return state;

        const newHistory = state.navHistory.slice(0, state.navIndex + 1);
        newHistory.push({ path, pos });
        if (newHistory.length > 50) newHistory.shift();
        return { navHistory: newHistory, navIndex: newHistory.length - 1 };
      }),

      navigateHistory: async (direction) => {
        const state = get();
        const newIndex = state.navIndex + (direction === "back" ? -1 : 1);
        const target = state.navHistory[newIndex];
        if (!target) return;
        const request = ++historyRequest;
        const version = projectVersion;
        const findTab = (current: WorkspaceState) => {
          const match = (tabs: Tab[]) => tabs.find(tab => samePath(tab.path, target.path)
            && !tab.browser && !tab.revision && !tab.reverseTree && tab.diff === undefined);
          const left = match(current.leftTabs);
          const right = current.isSplitMode ? match(current.rightTabs) : undefined;
          if (right && (current.focusedPane === "right" || !left)) return { tab: right, pane: "right" as const };
          if (left) return { tab: left, pane: "left" as const };
        };
        set({ navIndex: newIndex });

        let destination = findTab(get());
        if (!destination) {
          const snapshot = await fsApi.readFileSnapshot(target.path).catch(() => null);
          const current = get();
          if (request !== historyRequest || version !== projectVersion || current.navHistory !== state.navHistory) return;
          destination = findTab(current);
          if (!destination) {
            if (!snapshot) return;
            const pane = current.isSplitMode ? current.focusedPane : "left";
            current.openTab({
              id: target.path, path: target.path, title: pathName(target.path),
              content: snapshot.content, diskVersion: snapshot.version, isDirty: false,
            }, { pane });
            destination = findTab(get());
            if (!destination) return;
          }
        }

        const { tab, pane } = destination;
        get().setActiveTab(tab.id, pane);
        set({ editorJump: { path: tab.path, pane, line: 1, from: target.pos, to: target.pos } });
      },

      loadDirectory: async (path, logical = false, refresh = false) => {
        const version = projectVersion;
        const key = `${version}:${logical}:${pathKey(path)}`;
        const pending = directoryRequests.get(key);
        if (pending) {
          if (!refresh) return pending;
          // A mutation needs a listing taken after it, not an older in-flight result.
          await pending;
          if (version !== projectVersion) return;
          return get().loadDirectory(path, logical, true);
        }
        if (!refresh && loadedDirectories.has(key)) return;
        const request = (async () => {
          try {
            const children = await fsApi.readDirectory(path);
            if (version !== projectVersion) return;
            set(state => logical
              ? { logicalTreeData: replaceChildren(state.logicalTreeData, path, children) }
              : { fileTreeData: samePath(path, state.rootPath ?? "")
                  ? preserveLoadedChildren(state.fileTreeData, children) : replaceChildren(state.fileTreeData, path, children) });
            loadedDirectories.add(key);
          } catch (error) {
            console.error("Failed to load directory:", path, error);
          } finally {
            directoryRequests.delete(key);
          }
        })();
        directoryRequests.set(key, request);
        return request;
      },

      closeProject: async () => {
        if (!get().rootPath) return;
        await flushPendingWrites();
        set(state => ({ projectPinnedTabs: pinnedTabsByProject(state), projectSessions: sessionsByProject(state) }));
        if (isRemotePath(get().rootPath)) await get().disconnectRemote();
        for (const session of useTerminalStore.getState().sessions) {
          useTerminalStore.getState().removeSession(session.id);
        }
        ++projectVersion;
        loadedDirectories.clear();
        set({
          rootPath: null, remoteLabel: null, fileTreeData: [], treeStatuses: {}, logicalTreeData: [],
          searchScopePath: null, partitionSearchPaths: null, sidebarMode: "physical", pinnedTabsRestored: false,
          leftTabs: [], rightTabs: [], activeLeftTabId: null, activeRightTabId: null,
          focusedPane: "left", isSplitMode: false, navHistory: [], navIndex: -1,
          editorJump: null, graphLocation: null,
        });
        useLayoutStore.setState({ leftSidebarVisible: false, rightSidebarVisible: false, bottomPanelVisible: false });
        if (isTauri()) await tauriInvoke("close_project_instance");
      },

      setProject: async (path) => {
        if (isRemotePath(path) && (!isRemotePath(get().rootPath) || remotePath(get().rootPath!).id !== remotePath(path).id)) {
          try {
            const result = await tauriInvoke<{ trusted: boolean }>("reconnect_remote", { id: remotePath(path).id });
            if (!result.trusted) throw new Error("SFTP operation failed; check connection, path and permissions");
          } catch (error) { showError(String(error)); return false; }
        }
        try { await flushPendingWrites(); } catch (error) { showError(String(error)); return false; }
        let version = ++projectVersion;
        loadedDirectories.clear();
        try {
          const treeData = await fsApi.readDirectory(path);
          if (version !== projectVersion) return false;
          if (isTauri() && !isSnapshot && !isRemotePath(path)
            && !await tauriInvoke<boolean>("register_project_instance", { path })) return false;
          if (isRemotePath(get().rootPath) && (!isRemotePath(path) || remotePath(get().rootPath!).id !== remotePath(path).id)) {
            set(state => ({ projectPinnedTabs: pinnedTabsByProject(state), projectSessions: sessionsByProject(state) }));
            await get().disconnectRemote();
            version = ++projectVersion;
          }

          if (get().rootPath !== path) {
            for (const session of useTerminalStore.getState().sessions) {
              useTerminalStore.getState().removeSession(session.id);
            }
          }

          set(state => {
            const newRecent = isSnapshot ? state.recentProjects : [path, ...state.recentProjects.filter(p => p !== path)].slice(0, 10);
            const switching = state.rootPath !== path;
            const projectPinnedTabs = pinnedTabsByProject(state);
            const projectSessions = sessionsByProject(state);
            let tabs;
            if (switching) {
              const browserTabs = [...state.leftTabs, ...state.rightTabs]
                .filter(tab => tab.browser)
                .filter((tab, index, all) => all.findIndex(candidate => candidate.id === tab.id) === index);
              const activeBrowserId = [state.activeLeftTabId, state.activeRightTabId]
                .find(id => id && browserTabs.some(tab => tab.id === id)) ?? browserTabs[0]?.id ?? null;
              tabs = resolveSplitMode(false, browserTabs, [], activeBrowserId, null, "left", path);
            } else {
              tabs = resolveTabTitles(state.leftTabs, state.rightTabs, path);
            }
            return { ...tabs, projectPinnedTabs, projectSessions, pinnedTabsRestored: switching ? false : state.pinnedTabsRestored, rootPath: path, searchScopePath: null, partitionSearchPaths: null, remoteLabel: isRemotePath(path) ? (settingsStorage.getItem(`sftp-label:${remotePath(path).id}`) || remotePath(path).id) : null, sidebarMode: "physical", fileTreeData: treeData, treeStatuses: {}, logicalTreeData: [], recentProjects: newRecent };
          });

          const savedLayout = restoreProjectLayout(path);
          await get().restorePinnedTabs();
          if (version !== projectVersion) return false;
          if (!savedLayout) useLayoutStore.setState({ leftSidebarVisible: true, bottomPanelVisible: false });

          if (isSnapshot) return true;
          if (isRemotePath(path)) { void get().fetchLogicalTree(); return true; }
          void (async () => {
            try {
              await gitApi.status(path);
              if (!savedLayout && version === projectVersion && get().rootPath === path)
                useLayoutStore.getState().openBottomPanel("git");
            } catch {
              // A failed Git status means this project has no usable repository.
            }
          })();
          void get().refreshTreeStatuses();
          // Show the folder immediately; index Markdown in the background.
          void (async () => {
            await fsApi.initProjectDb(path);
            if (version !== projectVersion) return;
            await get().fetchLogicalTree();
            await fsApi.syncProjectIndex(path);
            if (version === projectVersion) await get().fetchLogicalTree();
          })().catch(error => console.error("Failed to index project:", error));
          return true;
        } catch (error) {
          console.error("Failed to set project:", error);
          return false;
        }
      },

      setSidebarMode: (mode) => set({ sidebarMode: mode, partitionSearchPaths: null }),

      fetchLogicalTree: async () => {
        if (isSnapshot) return;
        const version = projectVersion;
        const existing = logicalTreeRefreshes.get(version);
        if (existing) { existing.pending = true; return existing.request; }
        const refresh = { pending: false, request: Promise.resolve() };
        refresh.request = (async () => {
          await new Promise(resolve => setTimeout(resolve, 40));
          do {
            refresh.pending = false;
            if (version !== projectVersion) return;
            const request = ++logicalTreeRequest;
            const data = await fsApi.getLogicalTree();
            if (version !== projectVersion || request !== logicalTreeRequest) return;
            for (const key of loadedDirectories) {
              if (key.startsWith(`${version}:true:`)) loadedDirectories.delete(key);
            }
            set(state => ({ logicalTreeData: data, indexRevision: state.indexRevision + 1 }));
            window.dispatchEvent(new Event("nexusdesk-logical-data-changed"));
          } while (refresh.pending);
        })().catch(error => console.error("Failed to fetch logical tree:", error))
          .finally(() => { logicalTreeRefreshes.delete(version); });
        logicalTreeRefreshes.set(version, refresh);
        return refresh.request;
      },

      createLogicalFolder: async (name) => {
        await fsApi.createLogicalFolder(name);
        await get().fetchLogicalTree();
      },

      moveLogicalNode: async (paths, newType) => {
        try {
          await flushPendingWrites();
          for (const path of paths) {
            await fsApi.updateFileFrontmatter(path, newType);
          }
          await refreshOpenFiles(paths);
          get().fetchLogicalTree();
        } catch (error) {
          showError(`Reference failed: ${String(error)}`);
        }
      },

      deletePhysicalEntry: async (path) => {
        await flushPendingWrites();
        fileOperationHistory.selectProject(get().rootPath);
        if (isRemotePath(path)) {
          await fsApi.deleteEntry(path);
          fileOperationHistory.clear();
        } else {
          let backup = await tauriInvoke<string>("stash_entry", { path });
          fileOperationHistory.record({
            undo: async () => {
              await get().movePhysicalEntry(backup, parentPath(path));
            },
            redo: async () => {
              await flushPendingWrites();
              backup = await tauriInvoke<string>("stash_entry", { path });
              const contains = (candidate: string) => isWithinPath(candidate, path);
              set(state => {
                const leftTabs = state.leftTabs.filter(tab => !contains(tab.path));
                const rightTabs = state.rightTabs.filter(tab => !contains(tab.path));
                return { ...resolveTabTitles(leftTabs, rightTabs, state.rootPath),
                  activeLeftTabId: leftTabs.some(tab => tab.id === state.activeLeftTabId) ? state.activeLeftTabId : leftTabs[leftTabs.length - 1]?.id ?? null,
                  activeRightTabId: rightTabs.some(tab => tab.id === state.activeRightTabId) ? state.activeRightTabId : rightTabs[rightTabs.length - 1]?.id ?? null };
              });
              loadedDirectories.clear();
              await get().loadDirectory(parentPath(path), false, true);
              await get().fetchLogicalTree();
            },
          });
        }
        const contains = (candidate: string) => isWithinPath(candidate, path);
        for (const [key, entry] of saves) if (contains(entry.path)) { entry.schedule.cancel(); saves.delete(key); }
        set(state => {
          const leftTabs = state.leftTabs.filter(tab => !contains(tab.path));
          const rightTabs = state.rightTabs.filter(tab => !contains(tab.path));
          const resolved = resolveTabTitles(leftTabs, rightTabs, state.rootPath);
          return { ...resolved,
            activeLeftTabId: leftTabs.some(tab => tab.id === state.activeLeftTabId) ? state.activeLeftTabId : leftTabs[leftTabs.length - 1]?.id ?? null,
            activeRightTabId: rightTabs.some(tab => tab.id === state.activeRightTabId) ? state.activeRightTabId : rightTabs[rightTabs.length - 1]?.id ?? null };
        });
        loadedDirectories.clear();
        await get().loadDirectory(parentPath(path), false, true);
        await get().fetchLogicalTree();
      },

      movePhysicalEntry: async (sourcePath, targetDir, name, opts) => {
        try {
          await flushPendingWrites();
          const target = name === undefined
            ? await invoke<string>("move_entry", { sourcePath, targetDir, opts })
            : await invoke<string>("rename_entry", { sourcePath, name, opts });
          fileOperationHistory.selectProject(get().rootPath);
          if (opts && (opts.mergeFolders || opts.overwriteAll || opts.overwritePaths?.length || opts.skipAll || opts.skipPaths?.length)) {
            fileOperationHistory.clear();
          } else if (normalizePath(sourcePath) !== normalizePath(target)) {
            fileOperationHistory.record({
              undo: () => get().movePhysicalEntry(target, parentPath(sourcePath), name === undefined ? undefined : sourcePath.split(/[/\\]/).pop()!),
              redo: () => get().movePhysicalEntry(sourcePath, targetDir, name),
            });
          }
          const remap = (path: string) => {
            const normalized = normalizePath(path);
            const source = normalizePath(sourcePath);
            return isWithinPath(path, sourcePath) ? target + (target.includes("\\") ? normalized.slice(source.length).replace(/\//g, "\\") : normalized.slice(source.length)) : path;
          };
          for (const [key, entry] of [...saves]) {
            if (remap(entry.path) !== entry.path) { entry.schedule.cancel(); saves.delete(key); }
          }
          set(state => {
            const nextLeft = state.leftTabs.map(tab => ({ ...tab, id: remap(tab.id), path: remap(tab.path), title: remap(tab.path) !== tab.path && !tab.diff && !tab.revision ? remap(tab.path).split(/[/\\]/).pop()! : tab.title }));
            const nextRight = state.rightTabs.map(tab => ({ ...tab, id: remap(tab.id), path: remap(tab.path), title: remap(tab.path) !== tab.path && !tab.diff && !tab.revision ? remap(tab.path).split(/[/\\]/).pop()! : tab.title }));
            const resolved = resolveTabTitles(nextLeft, nextRight, state.rootPath);
            return {
              ...resolved,
              activeLeftTabId: state.activeLeftTabId && remap(state.activeLeftTabId),
              activeRightTabId: state.activeRightTabId && remap(state.activeRightTabId),
            };
          });
          window.dispatchEvent(new Event("nexusdesk:files-moved"));
          loadedDirectories.clear();
          await Promise.all([...new Set([parentPath(sourcePath), targetDir])]
            .map(path => get().loadDirectory(path, false, true)));
          await get().fetchLogicalTree();
        } catch (error) { throw error; }
      },

      copyFileToPhysical: async (sourcePath, targetDir, opts) => {
        try {
          await flushPendingWrites();
          await invoke("copy_file_to_dir", { sourcePath, targetDir, opts });
          await get().loadDirectory(targetDir, false, true);
        } catch (error) {
          throw error;
        }
      },

      createPhysicalFile: async (path) => {
        try {
          await fsApi.createPhysicalFile(path);
          await get().loadDirectory(parentPath(path), false, true);
        } catch (error) {
          throw error;
        }
      },

      createPhysicalFolder: async (path) => {
        try {
          await fsApi.createPhysicalDir(path);
          await get().loadDirectory(parentPath(path), false, true);
        } catch (error) {
          throw error;
        }
      },

      openTab: (tab, options) =>
        setTabs((state) => {
          const entry = saves.get(pathKey(tab.path));
          if (entry && !tab.revision && !tab.diffReadOnly && !tab.diffStaged && !tab.readOnly && !tab.browser
            && (entry.error || entry.content !== entry.saved || pendingWrites.has(pathKey(tab.path)))) {
            tab = { ...tab, content: entry.content, diskVersion: entry.version, isDirty: true, saveError: entry.error };
          }
          if (tab.diff === undefined && !tab.revision && !tab.reverseTree && !tab.browser && !tab.readOnly) void fsApi.touchFile(tab.path).catch(console.error);
          const pane = options?.pane ?? state.focusedPane;
          const tabs = pane === "left" ? state.leftTabs : state.rightTabs;
          const exists = tabs.find((t) => t.id === tab.id || (tab.diff === undefined && !tab.revision && !tab.reverseTree && !tab.browser
            && t.diff === undefined && !t.revision && !t.reverseTree && !t.browser && samePath(t.path, tab.path)));

          if (options?.background) {
            if (exists) return {};
            const newTabs = sortTabs([tab, ...tabs]);
            return resolveTabTitles(
              pane === "left" ? newTabs : state.leftTabs,
              pane === "right" ? newTabs : state.rightTabs,
              state.rootPath,
            );
          }

          if (exists) {
            if (tab.diff !== undefined) {
              const updated = sortTabs([tab, ...tabs.filter(t => t.id !== tab.id)]);
              const nextLeft = pane === "left" ? updated : state.leftTabs;
              const nextRight = pane === "right" ? updated : state.rightTabs;
              const resolved = resolveTabTitles(nextLeft, nextRight, state.rootPath);
              return { ...resolved, activeLeftTabId: pane === "left" ? tab.id : state.activeLeftTabId, activeRightTabId: pane === "right" ? tab.id : state.activeRightTabId };
            }
            const reorderedTabs = sortTabs([exists, ...tabs.filter(t => t.id !== exists.id)]);
            return pane === "left"
              ? { leftTabs: reorderedTabs, activeLeftTabId: exists.id }
              : { rightTabs: reorderedTabs, activeRightTabId: exists.id };
          }

          const newTabs = sortTabs([tab, ...tabs]);
          const nextLeft = pane === "left" ? newTabs : state.leftTabs;
          const nextRight = pane === "right" ? newTabs : state.rightTabs;
          const resolved = resolveTabTitles(nextLeft, nextRight, state.rootPath);
          return {
            ...resolved,
            activeLeftTabId: pane === "left" ? tab.id : state.activeLeftTabId,
            activeRightTabId: pane === "right" ? tab.id : state.activeRightTabId
          };
        }),

      returnFromRevision: (root) => setTabs(state => {
        const keep = (tab: Tab) => !(tab.revision && tab.id.startsWith(`git-revision:${root}:`));
        const left = state.leftTabs.filter(keep);
        const right = state.rightTabs.filter(keep);
        const activeLeft = left.some(t => t.id === state.activeLeftTabId) ? state.activeLeftTabId : left[left.length - 1]?.id ?? null;
        const activeRight = right.some(t => t.id === state.activeRightTabId) ? state.activeRightTabId : right[right.length - 1]?.id ?? null;
        return resolveSplitMode(state.isSplitMode, left, right, activeLeft, activeRight, state.focusedPane, state.rootPath);
      }),

      closeTab: (id, pane) =>
        closeTabs((state) => {
          const isLeft = pane === "left";
          const tabs = isLeft ? state.leftTabs : state.rightTabs;
          const activeId = isLeft ? state.activeLeftTabId : state.activeRightTabId;

          const closedIndex = tabs.findIndex((t) => t.id === id);
          const newTabs = tabs.filter((t) => t.id !== id);
          let newActiveId = activeId;
          if (activeId === id && closedIndex !== -1) {
            newActiveId = newTabs[closedIndex]?.id ?? newTabs[closedIndex - 1]?.id ?? null;
          }

          const nextLeftTabs = isLeft ? newTabs : state.leftTabs;
          const nextRightTabs = isLeft ? state.rightTabs : newTabs;
          const nextActiveLeftId = isLeft ? newActiveId : state.activeLeftTabId;
          const nextActiveRightId = isLeft ? state.activeRightTabId : newActiveId;

          return resolveSplitMode(
            state.isSplitMode,
            nextLeftTabs,
            nextRightTabs,
            nextActiveLeftId,
            nextActiveRightId,
            state.focusedPane,
            state.rootPath
          );
        }),

      closeOtherTabs: (id, pane) =>
        closeTabs((state) => {
          const isLeft = pane === "left";
          const tabs = isLeft ? state.leftTabs : state.rightTabs;
          const targetTab = tabs.find((t) => t.id === id);
          if (!targetTab) return state;

          const newTabs = tabs.filter((t) => t.id === id || t.isPinned);
          const nextLeftTabs = isLeft ? newTabs : state.leftTabs;
          const nextRightTabs = isLeft ? state.rightTabs : newTabs;
          const nextActiveLeftId = isLeft ? id : state.activeLeftTabId;
          const nextActiveRightId = isLeft ? state.activeRightTabId : id;

          return resolveSplitMode(
            state.isSplitMode,
            nextLeftTabs,
            nextRightTabs,
            nextActiveLeftId,
            nextActiveRightId,
            state.focusedPane,
            state.rootPath
          );
        }),

      closeLeftTabs: (id, pane) =>
        closeTabs((state) => {
          const isLeft = pane === "left";
          const tabs = isLeft ? state.leftTabs : state.rightTabs;
          const activeId = isLeft ? state.activeLeftTabId : state.activeRightTabId;

          const index = tabs.findIndex((t) => t.id === id);
          if (index === -1) return state;

          const newTabs = tabs.filter((t, i) => i >= index || t.isPinned);
          const isCurrentActiveRemoved = !newTabs.find((t) => t.id === activeId);
          const newActiveId = isCurrentActiveRemoved ? id : activeId;

          const nextLeftTabs = isLeft ? newTabs : state.leftTabs;
          const nextRightTabs = isLeft ? state.rightTabs : newTabs;
          const nextActiveLeftId = isLeft ? newActiveId : state.activeLeftTabId;
          const nextActiveRightId = isLeft ? state.activeRightTabId : newActiveId;

          return resolveSplitMode(
            state.isSplitMode,
            nextLeftTabs,
            nextRightTabs,
            nextActiveLeftId,
            nextActiveRightId,
            state.focusedPane,
            state.rootPath
          );
        }),

      closeRightTabs: (id, pane) =>
        closeTabs((state) => {
          const isLeft = pane === "left";
          const tabs = isLeft ? state.leftTabs : state.rightTabs;
          const activeId = isLeft ? state.activeLeftTabId : state.activeRightTabId;

          const index = tabs.findIndex((t) => t.id === id);
          if (index === -1) return state;

          const newTabs = tabs.filter((t, i) => i <= index || t.isPinned);
          const isCurrentActiveRemoved = !newTabs.find((t) => t.id === activeId);
          const newActiveId = isCurrentActiveRemoved ? id : activeId;

          const nextLeftTabs = isLeft ? newTabs : state.leftTabs;
          const nextRightTabs = isLeft ? state.rightTabs : newTabs;
          const nextActiveLeftId = isLeft ? newActiveId : state.activeLeftTabId;
          const nextActiveRightId = isLeft ? state.activeRightTabId : newActiveId;

          return resolveSplitMode(
            state.isSplitMode,
            nextLeftTabs,
            nextRightTabs,
            nextActiveLeftId,
            nextActiveRightId,
            state.focusedPane,
            state.rootPath
          );
        }),

      setActiveTab: (id, pane) =>
        setTabs((state) => {
          const tab = (pane === "left" ? state.leftTabs : state.rightTabs).find(t => t.id === id);
          if (!tab) return state;
          if (tab.diff === undefined && !tab.revision && !tab.browser) void fsApi.touchFile(tab.path).catch(console.error);
          return pane === "left"
            ? { activeLeftTabId: id, focusedPane: "left" }
            : { activeRightTabId: id, focusedPane: "right" };
        }),

      updateTabContent: (id, content, pane) => {
        if (isSnapshot) return;
        const tabs = pane === "left" ? get().leftTabs : get().rightTabs;
        const tab = tabs.find((t) => t.id === id);
        if (!tab || tab.revision || tab.browser || tab.diffReadOnly || tab.diffStaged || tab.readOnly) return;

        if (tab.content === content) return;
        const key = pathKey(tab.path);
        let entry = saves.get(key);
        if (!entry) {
          entry = { path: tab.path, title: tab.title, pane, content, saved: tab.content, version: tab.diskVersion, schedule: debounce(() => saveFile(tab.path), 500, { maxWait: 2000 }) };
          saves.set(key, entry);
        } else if (!tab.isDirty && !pendingWrites.has(key)) {
          entry.saved = tab.content;
          entry.version = tab.diskVersion;
        }
        entry.content = content;
        const dirty = content !== entry.saved || pendingWrites.has(key) || !!entry.error;
        const updateMatchingTabs = (tabs: Tab[]) => {
          let changed = false;
          const updated = tabs.map(t => {
            if (!samePath(t.path, tab.path) || t.revision || t.diffReadOnly || t.diffStaged || t.readOnly || (t.content === content && t.isDirty === dirty && t.saveError === entry.error)) return t;
            changed = true;
            return { ...t, content, isDirty: dirty, saveError: entry.error };
          });
          return changed ? updated : tabs;
        };
        set(state => ({ leftTabs: updateMatchingTabs(state.leftTabs), rightTabs: updateMatchingTabs(state.rightTabs) }));
        if (!isFileConflict(entry.error)) entry.schedule();
      },

      setMarkdownMode: (id, pane, mode) => setTabs(state => pane === "left"
        ? { leftTabs: state.leftTabs.map(tab => tab.id === id ? { ...tab, markdownMode: mode } : tab) }
        : { rightTabs: state.rightTabs.map(tab => tab.id === id ? { ...tab, markdownMode: mode } : tab) }),

      toggleTabPin: (id, pane) => set(state => {
        const isLeft = pane === "left";
        const tabs = isLeft ? state.leftTabs : state.rightTabs;
        const newTabs = sortTabs(tabs.map(t => t.id === id ? { ...t, isPinned: !t.isPinned } : t));
        const resolved = resolveTabTitles(isLeft ? newTabs : state.leftTabs, isLeft ? state.rightTabs : newTabs, state.rootPath);
        return {
          ...resolved
        };
      }),

      splitRight: (id, sourcePane) =>
        setTabs((state) => {
          const sourceTabs = sourcePane === "left" ? state.leftTabs : state.rightTabs;
          const tabToSplit = sourceTabs.find(t => t.id === id);
          if (!tabToSplit) return state;

          const existsInRight = state.rightTabs.find(t => t.id === id);
          if (existsInRight) {
            return { isSplitMode: true, activeRightTabId: id, focusedPane: "right" };
          }

          const nextRight = sortTabs([...state.rightTabs, { ...tabToSplit }]);
          const resolved = resolveTabTitles(state.leftTabs, nextRight, state.rootPath);

          return {
            ...resolved,
            isSplitMode: true,
            activeRightTabId: id,
            focusedPane: "right"
          };
        }),

      closeSplit: () => setTabs(state => {
        const resolved = resolveTabTitles(state.leftTabs, [], state.rootPath);
        return { ...resolved, isSplitMode: false, activeRightTabId: null, focusedPane: "left" };
      }),

      setFocusedPane: (pane) => set({ focusedPane: pane }),

      reorderTabs: (pane, oldIndex, newIndex) =>
        set((state) => {
          const tabs = pane === "left" ? [...state.leftTabs] : [...state.rightTabs];
          const [moved] = tabs.splice(oldIndex, 1);
          tabs.splice(newIndex, 0, moved);
          const sortedTabs = sortTabs(tabs);
          return pane === "left" ? { leftTabs: sortedTabs } : { rightTabs: sortedTabs };
        }),

      moveTabAcrossPanes: (tabId, sourcePane, targetPane, newIndex) =>
        setTabs((state) => {
          const sourceTabs = sourcePane === "left" ? [...state.leftTabs] : [...state.rightTabs];
          const targetTabs = targetPane === "left" ? [...state.leftTabs] : [...state.rightTabs];

          const sourceTabIndex = sourceTabs.findIndex(t => t.id === tabId);
          if (sourceTabIndex === -1) return state;

          const [movedTab] = sourceTabs.splice(sourceTabIndex, 1);

          const existingTargetIndex = targetTabs.findIndex(t => t.id === tabId);
          if (existingTargetIndex !== -1) {
            const [existingTab] = targetTabs.splice(existingTargetIndex, 1);
            let insertIndex = newIndex;
            if (existingTargetIndex < newIndex) {
              insertIndex -= 1;
            }
            targetTabs.splice(insertIndex, 0, existingTab);
          } else {
            targetTabs.splice(newIndex, 0, movedTab);
          }

          const sortedTargetTabs = sortTabs(targetTabs);

          const updates: Partial<WorkspaceState> = {};
          if (sourcePane === "left") updates.leftTabs = sourceTabs;
          else updates.rightTabs = sourceTabs;

          if (targetPane === "left") updates.leftTabs = sortedTargetTabs;
          else updates.rightTabs = sortedTargetTabs;

          const activeSourceId = sourcePane === "left" ? state.activeLeftTabId : state.activeRightTabId;
          if (activeSourceId === tabId) {
            const newActiveSourceId = sourceTabs.length > 0 ? sourceTabs[sourceTabs.length - 1].id : null;
            if (sourcePane === "left") updates.activeLeftTabId = newActiveSourceId;
            else updates.activeRightTabId = newActiveSourceId;
          }

          if (targetPane === "left") {
            updates.activeLeftTabId = tabId;
            updates.focusedPane = "left";
          } else {
            updates.activeRightTabId = tabId;
            updates.focusedPane = "right";
          }

          return resolveSplitMode(
            state.isSplitMode,
            updates.leftTabs ?? state.leftTabs,
            updates.rightTabs ?? state.rightTabs,
            updates.activeLeftTabId !== undefined ? updates.activeLeftTabId : state.activeLeftTabId,
            updates.activeRightTabId !== undefined ? updates.activeRightTabId : state.activeRightTabId,
            updates.focusedPane ?? state.focusedPane,
            state.rootPath
          );
        }),
    });
    },
    {
      name: isSnapshot ? "nexusdesk-snapshot-storage" : "nexusdesk-workspace-storage",
      storage: isSnapshot ? undefined : globalJsonStorage,
      partialize: (state) => ({
        recentProjects: state.recentProjects,
        projectPinnedTabs: pinnedTabsByProject(state),
        projectSessions: sessionsByProject(state),
        projectTreeOpenState: state.projectTreeOpenState,
      }),
    }
  )
);

export async function refreshOpenFiles(paths: string[]) {
  flushEditorContent();
  const unchangedPaths = new Set<string>();
  const root = useWorkspaceStore.getState().rootPath;
  const tabs = [...useWorkspaceStore.getState().leftTabs, ...useWorkspaceStore.getState().rightTabs];
  await Promise.all([...new Set(tabs.filter(t => !t.revision && t.diff === undefined && paths.some(p => isWithinPath(t.path, p))).map(t => t.path))].map(async path => {
    const before = tabs.find(t => samePath(t.path, path))!;
    const pendingBeforeRead = pendingWrites.get(pathKey(path));
    const versionBeforeRead = saves.get(pathKey(path))?.version;
    try {
      const snapshot = await fsApi.inspectFileSnapshot(path, before.isDirty ? versionBeforeRead : before.diskVersion);
      if (useWorkspaceStore.getState().rootPath !== root) return;
      flushEditorContent();
      // 正在写入时交给保存接口校验；自身保存通知不能被误判为外部冲突。
      const entry = saves.get(pathKey(path));
      if (pendingBeforeRead || pendingWrites.has(pathKey(path)) || entry?.version !== versionBeforeRead) return;
      if (snapshot.content === undefined) {
        unchangedPaths.add(pathKey(path));
        return;
      }
      const current = [...useWorkspaceStore.getState().leftTabs, ...useWorkspaceStore.getState().rightTabs].find(t => samePath(t.path, path) && !t.revision && t.diff === undefined);
      if (snapshot.content === (current?.isDirty ? entry?.saved : current?.content)) {
        unchangedPaths.add(pathKey(path));
      }
      if (current?.isDirty) {
        if (!isRemotePath(path) && snapshot.content !== entry?.saved && snapshot.content !== entry?.content) markExternalConflict(path);
        return;
      }
      const update = (items: Tab[]) => items.map(t => samePath(t.path, path) && !t.revision && t.diff === undefined && !t.isDirty && t.content === before.content
        ? { ...t, content: snapshot.content, diskVersion: snapshot.version } : t);
      useWorkspaceStore.setState(state => ({ leftTabs: update(state.leftTabs), rightTabs: update(state.rightTabs) }));
    } catch { /* 删除或读取失败时保留编辑内容，后续保存仍需通过版本校验。 */ }
  }));
  return paths.filter(path => !unchangedPaths.has(pathKey(path)));
}
