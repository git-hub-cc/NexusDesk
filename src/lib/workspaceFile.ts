import { fsApi } from "./api";
import { canPreview, canReadAsText, isPreviewDocument } from "./assets";
import { normalizePath, pathName, samePath } from "./paths";
import { isRemotePath } from "./remote";
import { flushEditorContent, useWorkspaceStore, type Tab } from "@/stores/workspaceStore";

export function findWorkspaceFile(tabs: readonly Tab[], path: string): Tab | undefined {
  return tabs.find(tab => samePath(tab.path, path) && !tab.revision && tab.diff === undefined
    && !tab.browser && !tab.reverseTree);
}

export async function openWorkspaceFile(path: string, options: { title?: string; pane?: "left" | "right"; background?: boolean; isCurrent?: () => boolean } = {}): Promise<boolean> {
  flushEditorContent();
  const initial = useWorkspaceStore.getState();
  const root = initial.rootPath;
  const pane = options.pane ?? initial.focusedPane;
  if (options.isCurrent && !options.isCurrent()) return false;
  if (isRemotePath(path) && canPreview(path)) {
    throw new Error(isPreviewDocument(path) ? "请先将文档保存到本地，再进行预览。" : "暂不支持远程媒体预览");
  }
  if (!canReadAsText(path) && !canPreview(path)) throw new Error("二进制文件暂不支持文本预览");
  const tabs = pane === "left" ? [...initial.leftTabs, ...initial.rightTabs] : [...initial.rightTabs, ...initial.leftTabs];
  const existing = findWorkspaceFile(tabs, path);
  let changedProject = false;
  const stop = useWorkspaceStore.subscribe(state => { if (state.rootPath !== root) changedProject = true; });
  let snapshot: { content: string; version?: string };
  try {
    snapshot = existing?.content !== undefined ? { content: existing.content, version: existing.diskVersion }
      : canReadAsText(path) ? await fsApi.readFileSnapshot(path) : { content: "" };
  } finally { stop(); }
  const current = useWorkspaceStore.getState();
  if (changedProject || current.rootPath !== root || options.isCurrent && !options.isCurrent()) return false;
  const latestTabs = pane === "left" ? [...current.leftTabs, ...current.rightTabs] : [...current.rightTabs, ...current.leftTabs];
  const latest = findWorkspaceFile(latestTabs, path);
  current.openTab({
    id: latest?.id ?? normalizePath(path), path: latest?.path ?? path,
    title: options.title ?? pathName(path),
    content: latest?.content ?? snapshot.content, diskVersion: latest?.diskVersion ?? snapshot.version, isDirty: latest?.isDirty ?? false,
    saveError: latest?.saveError, markdownMode: latest?.markdownMode,
  }, { ...options, pane });
  return true;
}
