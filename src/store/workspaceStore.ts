import { isSnapshot } from "@/lib/snapshot";
import { fileOperationHistory } from "@/lib/fileOperationHistory";
import { showError } from "@/lib/dialogs";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { globalJsonStorage, settingsStorage } from "@/lib/globalSettings";
import debounce from "lodash/debounce";
import { buildTreeStatuses } from "@/lib/fileTreeAppearance";
import { gitApi, type TreeFileStatus } from "@/lib/api";
import { fsApi } from "@/lib/api";
import type { ReverseTreeNode } from "@/lib/treeGraph";
import { invokePathCommand as invoke, isRemotePath, remotePath } from "@/lib/remote";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
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
  markdownMode?: "source" | "preview" | "split"; // 适用于 Markdown, Tree, HTTP 文件的视图模式
  htmlRoot?: string;
  browser?: { root: string; url: string };
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
    const { content, isDirty, saveError, ...metadata } = tab;
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
    const { content, isDirty, saveError, ...rest } = tab;
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
const syncEditorChanges = debounce(() => flushEditorContent(), 200);

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

// Transient write provenance; never persisted in the workspace state.
const recentlySavedPaths = new Map<string, ReturnType<typeof setTimeout>>();
const savedPathKey = (path: string) => {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
};

function forgetRecentSave(path: string) {
  const key = savedPathKey(path);
  clearTimeout(recentlySavedPaths.get(key));
  recentlySavedPaths.delete(key);
}

function recordRecentSave(path: string) {
  forgetRecentSave(path);
  recentlySavedPaths.set(savedPathKey(path), setTimeout(() => forgetRecentSave(path), 1000));
}

export function isRecentlySavedPath(path: string) {
  return recentlySavedPaths.has(savedPathKey(path));
}

const saves = new Map<string, { content: string; saved: string | undefined; error?: string; schedule: ReturnType<typeof debounce> }>();

function markFile(path: string, content: string, isDirty: boolean, saveError?: string) {
  const update = (tabs: Tab[]) => tabs.map(tab => tab.path === path && !tab.revision && tab.diff === undefined && tab.content === content
    ? { ...tab, isDirty, saveError } : tab);
  useWorkspaceStore.setState(state => ({ leftTabs: update(state.leftTabs), rightTabs: update(state.rightTabs) }));
}

function saveFile(path: string) {
  const entry = saves.get(path);
  if (!entry) return;
  const write = (pendingWrites.get(path) ?? Promise.resolve()).then(async () => {
    const content = entry.content;
    if (entry.saved === content && !entry.error) {
      markFile(path, content, false);
      return;
    }
    try {
      // notify can arrive before the write command resolves.
      recordRecentSave(path);
      await fsApi.writeFile(path, content);
      recordRecentSave(path);
      entry.saved = content;
      entry.error = undefined;
      markFile(path, content, false);
      await useWorkspaceStore.getState().fetchLogicalTree();
    } catch (error) {
      forgetRecentSave(path);
      entry.error = String(error);
      markFile(path, entry.content, true, entry.error);
      console.error("Failed to save file:", path, error);
    }
  }).finally(() => {
    if (pendingWrites.get(path) === write) pendingWrites.delete(path);
  });
  pendingWrites.set(path, write);
}

export function retryFileSave(path: string) {
  saves.get(path)?.schedule.cancel();
  saveFile(path);
}

export async function flushPendingWrites() {
  flushEditorContent();
  for (const entry of saves.values()) entry.schedule.flush();
  while (pendingWrites.size) await Promise.all([...pendingWrites.values()]);
  if ([...saves.values()].some(entry => entry.error || entry.content !== entry.saved)) {
    throw new Error("Files have unsaved changes or save errors. Retry saving before continuing.");
  }
}

export async function restoreLocalVersion(path: string, content: string) {
  await flushPendingWrites();
  await fsApi.writeFile(path, content);
  const entry = saves.get(path);
  if (entry) { entry.schedule.cancel(); entry.content = content; entry.saved = content; entry.error = undefined; }
  const update = (tabs: Tab[]) => tabs.map(tab => tab.path === path && !tab.revision && tab.diff === undefined
    ? { ...tab, content, isDirty: false, saveError: undefined } : tab);
  useWorkspaceStore.setState(state => ({ leftTabs: update(state.leftTabs), rightTabs: update(state.rightTabs) }));
  await useWorkspaceStore.getState().fetchLogicalTree();
}

function resolveTabTitles(leftTabs: Tab[], rightTabs: Tab[], rootPath: string | null): { leftTabs: Tab[], rightTabs: Tab[] } {
  const allTabs = [...leftTabs, ...rightTabs];
  const titleMap = new Map<string, string>();

  const normalTabs = allTabs.filter(t => t.diff === undefined && !t.revision && !t.reverseTree && !t.browser);
  const groups = new Map<string, Tab[]>();
  for (const tab of normalTabs) {
    const filename = tab.path.split(/[/\\]/).pop() || tab.path;
    if (!groups.has(filename)) groups.set(filename, []);
    groups.get(filename)!.push(tab);
  }

  for (const [filename, groupTabs] of groups.entries()) {
    if (groupTabs.length === 1) {
      titleMap.set(groupTabs[0].id, filename);
      continue;
    }

    const uniquePaths = Array.from(new Set(groupTabs.map(t => t.path)));
    if (uniquePaths.length === 1) {
      for (const tab of groupTabs) titleMap.set(tab.id, filename);
      continue;
    }

    const parsedPaths = uniquePaths.map(path => ({
      path,
      parts: path.split(/[/\\]/).reverse()
    }));

    for (let i = 0; i < parsedPaths.length; i++) {
      const P = parsedPaths[i];
      let k_max = 0;
      for (let j = 0; j < parsedPaths.length; j++) {
        if (i === j) continue;
        const Q = parsedPaths[j];
        let k = 0;
        while (k < P.parts.length && k < Q.parts.length && P.parts[k] === Q.parts[k]) {
          k++;
        }
        if (k > k_max) k_max = k;
      }

      let title = filename;
      if (k_max >= P.parts.length) {
        title = P.parts.slice().reverse().join('/');
      } else if (k_max === 1) {
        title = `${P.parts[1]}/${filename}`;
      } else if (k_max > 1) {
        title = `${P.parts[k_max]}/../${filename}`;
      }

      for (const tab of groupTabs) {
        if (tab.path === P.path) {
          titleMap.set(tab.id, title);
        }
      }
    }
  }

  const updateTabs = (tabs: Tab[]) => tabs.map(tab => {
    const newTitle = tab.diff !== undefined || tab.revision || tab.reverseTree || tab.browser ? tab.title : titleMap.get(tab.id) || (tab.path.split(/[/\\]/).pop() || tab.path);
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

const normalizePath = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");
function isPathInProject(path: string, rootPath: string) {
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const candidate = normalize(path);
  const root = normalize(rootPath);
  return candidate === root || candidate.startsWith(`${root}/`);
}
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
const directoryRequests = new Map<string, Promise<void>>();
const loadedDirectories = new Set<string>();

const preserveLoadedChildren = (previous: any[], incoming: any[]): any[] => {
  const existing = new Map(previous.map(node => [normalizePath(node.id), node]));
  return incoming.map(node => {
    const old = existing.get(normalizePath(node.id));
    return old?.children?.length && node.children?.length === 0
      ? { ...node, children: old.children } : node;
  });
};

// Preserve unchanged branches so a refresh only replaces the affected directory.
const replaceChildren = (nodes: any[], path: string, children: any[]): any[] => {
  let changed = false;
  const next = nodes.map(node => {
    if (normalizePath(node.id) === normalizePath(path)) {
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
  editorJump: { path: string; line: number; pane: PaneType } | null;
  graphLocation: { path: string; line: number; pane: PaneType } | null;
  locateGraph: (path: string, line: number, pane: PaneType) => void;
  triggerLocate: () => void;

  navHistory: Array<{ path: string; pos: number }>;
  navIndex: number;
  pushNavLocation: (path: string, pos: number) => void;
  navigateHistory: (direction: "back" | "forward") => void;

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

  openTab: (tab: Tab) => void;
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
      const setTabs = (update: (state: WorkspaceState) => Partial<WorkspaceState>) => {
        flushEditorContent();
        set(update);
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
        for (const [path, entry] of saves) if (path.startsWith(prefix)) { entry.schedule.cancel(); saves.delete(path); }
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
            const content = tab.browser || tab.reverseTree || tab.revision || tab.diff !== undefined || tab.path === MUSIC_HOME || tab.path === VIDEO_HOME
              ? tab.content : await fsApi.readFile(tab.path);
            return { ...tab, content, isPinned: session ? !!tab.isPinned : true, isDirty: false, saveError: undefined };
          } catch (error) {
            console.error("Failed to restore pinned tab:", tab.path, error);
            return null;
          }
        }))).filter((tab): tab is NonNullable<typeof tab> => tab !== null);
        const [left, right] = await Promise.all([restore(saved.left), restore(saved.right)]);
        if (get().rootPath !== root || projectVersion !== version) return;
        set(state => {
          const merge = (current: Tab[], restored: Tab[]) => sortTabs([...current.map(tab =>
            restored.some(item => item.id === tab.id) ? { ...tab, isPinned: restored.find(item => item.id === tab.id)!.isPinned } : tab),
            ...restored.filter(tab => !current.some(item => item.id === tab.id))]);
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
      editorJump: null,
      graphLocation: null,
      locateGraph: (path, line, pane) => set(state => ({ graphLocation: { path, line, pane }, editorJump: { path, line, pane }, focusedPane: pane, locateSignal: state.locateSignal + 1 })),
      triggerLocate: () => set(state => ({ locateSignal: state.locateSignal + 1 })),

      navHistory: [],
      navIndex: -1,

      pushNavLocation: (path, pos) => set(state => {
        const last = state.navHistory[state.navIndex];
        if (last && last.path === path && Math.abs(last.pos - pos) < 15) return state;

        const newHistory = state.navHistory.slice(0, state.navIndex + 1);
        newHistory.push({ path, pos });
        if (newHistory.length > 50) newHistory.shift();
        return { navHistory: newHistory, navIndex: newHistory.length - 1 };
      }),

      navigateHistory: async (direction) => {
        const state = get();
        let newIndex = state.navIndex;

        if (direction === "back" && newIndex > 0) newIndex--;
        else if (direction === "forward" && newIndex < state.navHistory.length - 1) newIndex++;
        else return;

        const target = state.navHistory[newIndex];
        set({ navIndex: newIndex });

        const isOpened = [...state.leftTabs, ...state.rightTabs].some(t => t.path === target.path);
        if (!isOpened) {
           const content = await fsApi.readFile(target.path).catch(() => "");
           if (content) {
             get().openTab({
               id: target.path, path: target.path, title: target.path.split(/[/\\]/).pop() || target.path,
               content, isDirty: false
             });
           }
        } else {
           get().setActiveTab(target.path, state.focusedPane);
        }

        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("editor-jump", {
            detail: { path: target.path, pos: target.pos }
          }));
        }, 50);
      },

      loadDirectory: async (path, logical = false, refresh = false) => {
        const version = projectVersion;
        const key = `${version}:${logical}:${normalizePath(path)}`;
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
              : { fileTreeData: normalizePath(path) === normalizePath(state.rootPath ?? "")
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
            const tabs = switching
              ? resolveSplitMode(
                  false, [], [], null, null, "left", path)
              : resolveTabTitles(state.leftTabs, state.rightTabs, path);
            return { ...tabs, projectPinnedTabs, projectSessions, pinnedTabsRestored: switching ? false : state.pinnedTabsRestored, rootPath: path, searchScopePath: null, partitionSearchPaths: null, remoteLabel: isRemotePath(path) ? (settingsStorage.getItem(`sftp-label:${remotePath(path).id}`) || remotePath(path).id) : null, sidebarMode: "physical", fileTreeData: treeData, treeStatuses: {}, logicalTreeData: [], recentProjects: newRecent };
          });

          const savedLayout = restoreProjectLayout(path);
          await get().restorePinnedTabs();
          if (version !== projectVersion) return false;
          if (!savedLayout) useLayoutStore.setState({ leftSidebarVisible: true, bottomPanelVisible: false });

          if (isSnapshot || isRemotePath(path)) return true;
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
        if (!get().rootPath) return;
        if (isRemotePath(get().rootPath)) return;
        try {
          const version = projectVersion;
          const request = ++logicalTreeRequest;
          const data = await fsApi.getLogicalTree();
          if (version !== projectVersion || request !== logicalTreeRequest) return;
          for (const key of loadedDirectories) {
            if (key.startsWith(`${version}:true:`)) loadedDirectories.delete(key);
          }
          set(state => ({ logicalTreeData: data, indexRevision: state.indexRevision + 1 }));
        } catch (error) {
          console.error("Failed to fetch logical tree:", error);
        }
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
              const contains = (candidate: string) => normalizePath(candidate).toLowerCase() === normalizePath(path).toLowerCase() || normalizePath(candidate).toLowerCase().startsWith(normalizePath(path).toLowerCase() + "/");
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
        const normalize = (candidate: string) => isRemotePath(candidate) ? normalizePath(candidate) : normalizePath(candidate).toLowerCase();
        const contains = (candidate: string) => normalize(candidate) === normalize(path) || normalize(candidate).startsWith(normalize(path) + "/");
        for (const [key, entry] of saves) if (contains(key)) { entry.schedule.cancel(); saves.delete(key); }
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
            const normalized = path.replace(/\\/g, "/");
            const source = sourcePath.replace(/\\/g, "/");
            return normalized === source || normalized.startsWith(source + "/") ? target + (target.includes("\\") ? normalized.slice(source.length).replace(/\//g, "\\") : normalized.slice(source.length)) : path;
          };
          for (const [path, entry] of [...saves]) {
            if (remap(path) !== path) { entry.schedule.cancel(); saves.delete(path); }
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

      openTab: (tab) =>
        setTabs((state) => {
          if (tab.diff === undefined && !tab.revision && !tab.reverseTree && !tab.browser && !tab.readOnly) void fsApi.touchFile(tab.path).catch(console.error);
          const pane = state.focusedPane;
          const tabs = pane === "left" ? state.leftTabs : state.rightTabs;
          const exists = tabs.find((t) => t.id === tab.id);

          if (exists) {
            if (tab.diff !== undefined) {
              const updated = tabs.map(t => t.id === tab.id ? tab : t);
              const nextLeft = pane === "left" ? updated : state.leftTabs;
              const nextRight = pane === "right" ? updated : state.rightTabs;
              const resolved = resolveTabTitles(nextLeft, nextRight, state.rootPath);
              return { ...resolved, activeLeftTabId: pane === "left" ? tab.id : state.activeLeftTabId, activeRightTabId: pane === "right" ? tab.id : state.activeRightTabId };
            }
            return pane === "left"
              ? { activeLeftTabId: tab.id }
              : { activeRightTabId: tab.id };
          }

          const newTabs = sortTabs([...tabs, tab]);
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
        setTabs((state) => {
          const isLeft = pane === "left";
          const tabs = isLeft ? state.leftTabs : state.rightTabs;
          const activeId = isLeft ? state.activeLeftTabId : state.activeRightTabId;

          const newTabs = tabs.filter((t) => t.id !== id);
          let newActiveId = activeId;
          if (activeId === id) {
            newActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
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
        setTabs((state) => {
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
        setTabs((state) => {
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
        setTabs((state) => {
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
          if (tab && tab.diff === undefined && !tab.revision && !tab.browser) void fsApi.touchFile(tab.path).catch(console.error);
          return pane === "left"
            ? { activeLeftTabId: id, focusedPane: "left" }
            : { activeRightTabId: id, focusedPane: "right" };
        }),

      updateTabContent: (id, content, pane) => {
        if (isSnapshot) return;
        const tabs = pane === "left" ? get().leftTabs : get().rightTabs;
        const tab = tabs.find((t) => t.id === id);
        if (!tab || tab.revision || tab.browser) return;

        if (tab.content === content) return;
        let entry = saves.get(tab.path);
        if (!entry) {
          entry = { content, saved: tab.content, schedule: debounce(() => saveFile(tab.path), 500) };
          saves.set(tab.path, entry);
        } else if (!tab.isDirty && !pendingWrites.has(tab.path)) {
          entry.saved = tab.content;
        }
        entry.content = content;
        const dirty = content !== entry.saved || pendingWrites.has(tab.path) || !!entry.error;
        const updateMatchingTabs = (tabs: Tab[]) => {
          let changed = false;
          const updated = tabs.map(t => {
            if (t.path !== tab.path || t.revision || (t.content === content && t.isDirty === dirty && t.saveError === entry.error)) return t;
            changed = true;
            return { ...t, content, isDirty: dirty, saveError: entry.error };
          });
          return changed ? updated : tabs;
        };
        set(state => ({ leftTabs: updateMatchingTabs(state.leftTabs), rightTabs: updateMatchingTabs(state.rightTabs) }));
        entry.schedule();
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
  const root = useWorkspaceStore.getState().rootPath;
  const tabs = [...useWorkspaceStore.getState().leftTabs, ...useWorkspaceStore.getState().rightTabs];
  await Promise.all([...new Set(tabs.filter(t => !t.revision && t.diff === undefined && paths.some(p => normalizePath(t.path) === normalizePath(p) || normalizePath(t.path).startsWith(normalizePath(p) + "/"))).map(t => t.path))].map(async path => {
    const before = tabs.find(t => t.path === path)!;
    if (before.isDirty || pendingWrites.has(path)) return;
    try {
      const content = await fsApi.readFile(path);
      if (useWorkspaceStore.getState().rootPath !== root) return;
      const update = (items: Tab[]) => items.map(t => t.path === path && !t.revision && t.diff === undefined && !t.isDirty && t.content === before.content ? { ...t, content } : t);
      useWorkspaceStore.setState(state => ({ leftTabs: update(state.leftTabs), rightTabs: update(state.rightTabs) }));
    } catch { /* Deleted files stay open so their contents can be recovered. */ }
  }));
}
