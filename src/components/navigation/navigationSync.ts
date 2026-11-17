import { settingsStorage } from "@/lib/globalSettings";
import { fsApi, type GraphSyncData, type LogicalSyncData } from "@/lib/api";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { loadNavigationData, mergeNavigationData, saveNavigationData, type NavigationCategory, type NavigationData } from "./navigationData";

export type NavigationSyncProvider = "github" | "gitlab" | "gitee";
const TOKEN_KEYS: Record<NavigationSyncProvider, string> = { github: "nexusdesk.navigation.githubToken", gitlab: "nexusdesk.navigation.gitlabToken", gitee: "nexusdesk.navigation.giteeToken" };
const REPO_KEYS: Record<NavigationSyncProvider, string> = { github: "nexusdesk.navigation.githubRepo", gitlab: "nexusdesk.navigation.gitlabRepo", gitee: "nexusdesk.navigation.giteeRepo" };
const PROVIDER_KEY = "nexusdesk.navigation.provider";
const SYNC_ENABLED_KEY = "nexusdesk.navigation.syncEnabled";
const SYNC_NAVIGATION_KEY = "nexusdesk.cloudSync.myNavigation";
const SYNC_LOGICAL_KEY = "nexusdesk.cloudSync.logicalPartitions";
const SYNC_GRAPH_KEY = "nexusdesk.cloudSync.graphPartitions";
const LEGACY_TOKEN_KEY = "navhub-github-token";
const LEGACY_REPO_KEY = "navhub-github-repo";
const DATA_FILE = "navhub.json";
const LOGICAL_FILE = "logical-partitions.json";
const GRAPH_FILE = "graph-partitions.json";
const SYNC_TIMEOUT_MS = 15000;
type SyncStatus = "disconnected" | "connecting" | "connected" | "syncing" | "error" | "conflict";
export type NavigationSyncState = { status: SyncStatus; provider: NavigationSyncProvider; user: string; repo: string; lastSync: number | null; error: string; logicalNotice?: string; fileErrors?: Partial<Record<SyncChannel, string>> };

let current: NavigationSyncState = { status: "disconnected", provider: "github", user: "", repo: "", lastSync: null, error: "" };
let token = "";
let githubBranch = "main";
let repositoryWrites: Promise<void> = Promise.resolve();
type SyncChannel = "navigation" | "logical" | "graph";
type RepositoryFile = { value: Record<string, unknown> | null; sha: string | null; exists: boolean };
type LogicalWorkspace = Omit<LogicalSyncData, "workspace"> & { deletedEntries?: string[] };
type LogicalFile = { version: 1; updatedAt: number; workspaces: Record<string, LogicalWorkspace> };
type GraphWorkspace = Omit<GraphSyncData, "workspace"> & { deletedCategories?: string[]; deletedFiles?: string[] };
type GraphFile = { version: 1; updatedAt: number; workspaces: Record<string, GraphWorkspace> };
let remoteData: NavigationData | null = null;
let lastNavigationSnapshot: string | null = null;
let lastLogicalSnapshot: string | null = null;
let ready = false;
let suppressSave = false;
const files = new Map<string, RepositoryFile>();
const timers: Partial<Record<SyncChannel, number>> = {};
const queues: Record<SyncChannel, Promise<void>> = { navigation: Promise.resolve(), logical: Promise.resolve(), graph: Promise.resolve() };
const active = new Set<SyncChannel>();
const subscribers = new Set<(state: NavigationSyncState) => void>();

function update(patch: Partial<NavigationSyncState>) {
  current = { ...current, ...patch };
  for (const listener of subscribers) listener(current);
}

export function getNavigationSyncState() { return current; }
export function subscribeNavigationSync(listener: (state: NavigationSyncState) => void) {
  subscribers.add(listener);
  listener(current);
  return () => subscribers.delete(listener);
}

async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (current.provider === "github") Object.assign(headers, { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
  else if (current.provider === "gitlab") headers["PRIVATE-TOKEN"] = token;
  else headers.Authorization = `token ${token}`;
  const response = await fetch(url, {
    method,
    headers,
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({})) as { message?: string };
    if (response.status === 409 || response.status === 422 && /sha/i.test(details.message || "")) throw new Error("云端版本已变化，请重新同步后重试。");
    throw new Error(details.message || `${current.provider} 请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function decodeBase64(value: string): string {
  const bytes = Uint8Array.from(atob(value.replace(/\s/g, "")), character => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function legacyRemoteData(value: Record<string, unknown>): NavigationData | null {
  const categories: NavigationCategory[] = [];
  const customSites = value.customUserSites as NavigationCategory | undefined;
  if (customSites?.categoryId && Array.isArray(customSites.sites)) categories.push(customSites);
  const sources = value.customSources;
  if (Array.isArray(sources)) for (const source of sources) {
    const data = (source as { data?: NavigationData })?.data;
    if (data && Array.isArray(data.categories)) categories.push(...data.categories);
  }
  return categories.length ? { categories } : null;
}

async function readRepositoryFile(name: string): Promise<RepositoryFile> {
  const path = encodeURIComponent(name);
  const url = current.provider === "github" ? `https://api.github.com/repos/${current.repo}/contents/${path}?ref=${encodeURIComponent(githubBranch)}&t=${Date.now()}` : current.provider === "gitlab" ? `https://gitlab.com/api/v4/projects/${encodeURIComponent(current.repo)}/repository/files/${path}?ref=main&t=${Date.now()}` : `https://gitee.com/api/v5/repos/${current.repo}/contents/${path}?ref=master&t=${Date.now()}`;
  const headers: Record<string, string> = current.provider === "github" ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } : current.provider === "gitlab" ? { "PRIVATE-TOKEN": token } : { Authorization: `token ${token}` };
  const result = await fetch(url, { headers, signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
  if (result.status === 404) {
    const missing = { value: null, sha: null, exists: false };
    files.set(name, missing);
    return missing;
  }
  if (!result.ok) throw new Error(`读取 ${current.provider} 数据失败 (${result.status})：${name}`);
  const file = await result.json() as { content: string; sha?: string; blob_id?: string; last_commit_id?: string; encoding?: string; download_url?: string };
  let raw = file.content ? (current.provider === "gitlab" && file.encoding !== "base64" ? file.content : decodeBase64(file.content)) : "";
  if (!raw && file.download_url) {
    const download = await fetch(file.download_url, { headers, signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
    if (!download.ok) throw new Error(`下载 ${current.provider} 数据失败 (${download.status})：${name}`);
    raw = await download.text();
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`云端文件格式无效：${name}`);
  const snapshot = { value: parsed as Record<string, unknown>, sha: file.sha || file.last_commit_id || file.blob_id || null, exists: true };
  files.set(name, snapshot);
  return snapshot;
}

async function readRemote(applyPreferences = true): Promise<NavigationData | null> {
  const { value: parsed } = await readRepositoryFile(DATA_FILE);
  if (!parsed) return null;
  const data = parsed.navigationData as NavigationData | undefined;
  const preferences = parsed.preferences as { proxyMode?: boolean } | undefined;
  if (preferences && applyPreferences) {
    const changed = typeof preferences.proxyMode === "boolean" && preferences.proxyMode !== (localStorage.getItem("proxy-mode-preference") === "true");
    if (typeof preferences.proxyMode === "boolean") localStorage.setItem("proxy-mode-preference", String(preferences.proxyMode));
    const previous = suppressSave;
    suppressSave = true;
    if (changed) window.dispatchEvent(new CustomEvent("nexusdesk-navigation-preferences-changed", { detail: { proxyMode: preferences.proxyMode } }));
    suppressSave = previous;
  }
  if (data && Array.isArray(data.categories)) return data;
  return legacyRemoteData(parsed);
}

function navigationChanges(previous: NavigationData | null, next: NavigationData) {
  const oldCategories = new Map((previous?.categories ?? []).map(category => [category.categoryId, category]));
  const newCategories = new Map(next.categories.map(category => [category.categoryId, category]));
  const oldSites = new Map<string, NavigationCategory["sites"][number]>();
  const newSites = new Map<string, NavigationCategory["sites"][number]>();
  for (const [id, category] of oldCategories) for (const site of category.sites) oldSites.set(`${id}:${site.id || site.url}`, site);
  for (const [id, category] of newCategories) for (const site of category.sites) newSites.set(`${id}:${site.id || site.url}`, site);
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const [key, site] of newSites) {
    const old = oldSites.get(key);
    if (!old) added++;
    else if (JSON.stringify(old) !== JSON.stringify(site)) modified++;
  }
  for (const key of oldSites.keys()) if (!newSites.has(key)) deleted++;
  for (const id of newCategories.keys()) if (!oldCategories.has(id)) added++;
  for (const [id, category] of newCategories) {
    const old = oldCategories.get(id);
    if (old && old.categoryName !== category.categoryName) modified++;
  }
  for (const id of oldCategories.keys()) if (!newCategories.has(id)) deleted++;
  return { added, modified, deleted };
}

function commitMessage(previous: NavigationData | null, next: NavigationData) {
  const changes = navigationChanges(previous, next);
  if (changes.added + changes.modified + changes.deleted === 0) return "同步我的导航：更新显示偏好";
  return `同步我的导航：新增 ${changes.added} 项，修改 ${changes.modified} 项，删除 ${changes.deleted} 项`;
}

async function verifyPrivateRepository() {
  const repoPath = current.repo.split("/").map(encodeURIComponent).join("/");
  const headers: Record<string, string> = current.provider === "github"
    ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
    : current.provider === "gitlab" ? { "PRIVATE-TOKEN": token } : { Authorization: `token ${token}` };
  const url = current.provider === "github" ? `https://api.github.com/repos/${repoPath}`
    : current.provider === "gitlab" ? `https://gitlab.com/api/v4/projects/${encodeURIComponent(current.repo)}`
      : `https://gitee.com/api/v5/repos/${repoPath}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`无法验证仓库隐私设置 (${response.status})`);
  const repository = await response.json() as { private?: boolean; visibility?: string };
  const isPrivate = current.provider === "gitlab" ? repository.visibility === "private" : repository.private === true;
  if (!isPrivate) throw new Error("导航云同步仅允许写入私有仓库，请将仓库设为私有后重试。");
}

async function writeRepositoryFile(name: string, content: unknown, message: string) {
  // 同一仓库的不同文件也会更新分支，必须依次提交。
  const task = repositoryWrites.then(() => commitRepositoryFile(name, content, message));
  repositoryWrites = task.catch(() => {});
  return task;
}

async function commitRepositoryFile(name: string, content: unknown, message: string) {
  await verifyPrivateRepository();
  const snapshot = files.get(name) ?? { value: null, sha: null, exists: false };
  const serialized = JSON.stringify(content, null, 2);
  const bytes = new TextEncoder().encode(serialized);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  const encoded = btoa(binary);
  const path = encodeURIComponent(name);
  let sha = snapshot.sha;
  if (current.provider === "github") {
    const result = await request<{ content: { sha: string } }>(`https://api.github.com/repos/${current.repo}/contents/${path}`, "PUT", { message, content: encoded, branch: githubBranch, ...(sha ? { sha } : {}) });
    sha = result.content.sha;
  } else if (current.provider === "gitlab") {
    await request(`https://gitlab.com/api/v4/projects/${encodeURIComponent(current.repo)}/repository/files/${path}`, snapshot.exists ? "PUT" : "POST", { branch: "main", commit_message: message, content: serialized, ...(sha ? { last_commit_id: sha } : {}) });
  } else {
    const result = await request<{ content: { sha: string } }>(`https://gitee.com/api/v5/repos/${current.repo}/contents/${path}`, snapshot.exists ? "PUT" : "POST", { message, content: encoded, branch: "master", ...(sha ? { sha } : {}) });
    sha = result.content.sha;
  }
  files.set(name, { value: content as Record<string, unknown>, sha, exists: true });
}

function navigationSnapshot(data: NavigationData) {
  return {
    navigationData: { categories: data.categories.filter(category => category.categoryId === "custom-user-sites") },
    preferences: {
      proxyMode: localStorage.getItem("proxy-mode-preference") === "true",
    },
  };
}

async function syncNavigation(mergeRemote = true) {
  if (!getCloudSyncSelection().myNavigation) return false;
  const local = await loadNavigationData();
  const remote = await readRemote(mergeRemote);
  const merged = remote && mergeRemote ? mergeNavigationData(local, remote) : local;
  suppressSave = true;
  try { if (JSON.stringify(local) !== JSON.stringify(merged)) saveNavigationData(merged); }
  finally { suppressSave = false; }
  const snapshot = navigationSnapshot(merged);
  const previous = files.get(DATA_FILE)?.value;
  if (JSON.stringify(previous?.navigationData) !== JSON.stringify(snapshot.navigationData)
    || JSON.stringify(previous?.preferences) !== JSON.stringify(snapshot.preferences)) {
    await writeRepositoryFile(DATA_FILE, { ...previous, updatedAt: Date.now(), ...snapshot }, commitMessage(remoteData ?? remote, merged));
  }
  lastNavigationSnapshot = JSON.stringify(snapshot);
  remoteData = merged;
}

function logicalPath(path: string) {
  const value = path.replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "");
  return /^(?:[a-z]:|\/\/)/i.test(value) ? value.toLowerCase() : value;
}

function entryKey(entry: LogicalSyncData["entries"][number]) {
  return JSON.stringify([entry.kind, logicalPath(entry.path), entry.category]);
}

function normalizeDeletedEntry(key: string) {
  try {
    const [kind, path, category] = JSON.parse(key);
    return entryKey({ kind, path, category });
  } catch { return key; }
}

function logicalEqual(a: Pick<LogicalSyncData, "folders" | "entries">, b: Pick<LogicalSyncData, "folders" | "entries">) {
  return JSON.stringify([...a.folders].sort()) === JSON.stringify([...b.folders].sort())
    && JSON.stringify(a.entries.map(entryKey).sort()) === JSON.stringify(b.entries.map(entryKey).sort());
}

function logicalSnapshot(data: LogicalSyncData) {
  return JSON.stringify(["global", [...data.folders].sort(), data.entries.map(entryKey).sort()]);
}

function validLogicalWorkspace(value: unknown): value is LogicalWorkspace {
  if (!value || typeof value !== "object") return false;
  const data = value as LogicalWorkspace;
  return Array.isArray(data.folders) && data.folders.every(folder => typeof folder === "string")
    && Array.isArray(data.entries) && data.entries.every(entry => entry && typeof entry.path === "string" && typeof entry.category === "string" && ["reference", "copy", "hidden"].includes(entry.kind))
    && (data.deletedFolders === undefined || Array.isArray(data.deletedFolders) && data.deletedFolders.every(folder => typeof folder === "string"))
    && (data.deletedEntries === undefined || Array.isArray(data.deletedEntries) && data.deletedEntries.every(key => typeof key === "string"));
}

function mergeLogical(local: LogicalSyncData, remote: LogicalWorkspace | undefined, baseline: LogicalSyncData | null): LogicalWorkspace {
  const deletedFolders = new Set(remote?.deletedFolders ?? []);
  const deletedEntries = new Set((remote?.deletedEntries ?? []).map(normalizeDeletedEntry));
  const localFolders = new Set(local.folders);
  const localEntries = new Map(local.entries.map(entry => [entryKey(entry), entry]));
  const previousFolders = new Set(baseline?.folders ?? []);
  const previousEntries = new Set(baseline?.entries.map(entryKey) ?? []);
  for (const folder of previousFolders) if (!localFolders.has(folder)) deletedFolders.add(folder);
  for (const key of previousEntries) if (!localEntries.has(key)) deletedEntries.add(key);
  // 仅明确的新建操作可撤销删除标记，旧设备上的残留数据不能复活已删除项。
  if (baseline) {
    for (const folder of localFolders) if (!previousFolders.has(folder)) deletedFolders.delete(folder);
    for (const key of localEntries.keys()) if (!previousEntries.has(key)) deletedEntries.delete(key);
  }
  const folders = [...new Set([...(remote?.folders ?? []), ...local.folders])].filter(folder => !deletedFolders.has(folder)).sort();
  const entries = new Map((remote?.entries ?? []).map(entry => [entryKey(entry), entry]));
  for (const [key, entry] of localEntries) entries.set(key, entry);
  for (const [key, entry] of entries) if (deletedFolders.has(entry.category)) deletedEntries.add(key);
  return {
    folders,
    entries: [...entries.values()].filter(entry => !deletedEntries.has(entryKey(entry)) && !deletedFolders.has(entry.category)).sort((a, b) => entryKey(a).localeCompare(entryKey(b))),
    deletedFolders: [...deletedFolders].sort(),
    deletedEntries: [...deletedEntries].sort(),
  };
}

async function syncLogical() {
  if (!getCloudSyncSelection().logicalPartitions) { update({ logicalNotice: "" }); return false; }
  const root = useWorkspaceStore.getState().rootPath ?? "";
  update({ logicalNotice: "" });
  const local = await fsApi.getLogicalSyncData(root);
  const snapshot = await readRepositoryFile(LOGICAL_FILE);
  let document: LogicalFile;
  const legacyFile = await readRepositoryFile(DATA_FILE);
  if (snapshot.value) {
    if (snapshot.value.version !== 1 || !snapshot.value.workspaces || typeof snapshot.value.workspaces !== "object" || Array.isArray(snapshot.value.workspaces)) throw new Error("云端逻辑分区文件格式无效或版本不受支持");
    document = { ...(snapshot.value as LogicalFile), workspaces: { ...(snapshot.value as LogicalFile).workspaces } };
  } else {
    document = { version: 1, updatedAt: 0, workspaces: {} };
  }
  const legacy = legacyFile.value?.logicalPartitions as LogicalSyncData | undefined;
  if (legacy && (typeof legacy.workspace !== "string" || !validLogicalWorkspace(legacy))) throw new Error("旧版逻辑分区数据格式无效，已保留原文件");
  if (!Object.values(document.workspaces).every(validLogicalWorkspace)) throw new Error("云端逻辑分区数据格式无效");
  if (legacy && !Object.prototype.hasOwnProperty.call(document.workspaces, legacy.workspace)) {
    document.workspaces = { ...document.workspaces, [legacy.workspace]: { folders: legacy.folders, entries: legacy.entries } };
  }
  // 旧项目记录迁入全局；无法定位根目录的其他项目记录继续保留在原文件中。
  let remote = document.workspaces.global;
  const legacyWorkspace = local.legacyWorkspace;
  if (legacyWorkspace && document.workspaces[legacyWorkspace] && root && !root.startsWith("sftp:")) {
    const previous = document.workspaces[legacyWorkspace];
    const absolute = (path: string) => /^(?:[a-z]:[\\/]|[\\/])/i.test(path) ? path : `${root.replace(/[\\/]+$/, "")}/${path}`;
    const migrated = {
      ...previous,
      workspace: "global",
      entries: previous.entries.map(entry => ({ ...entry, path: absolute(entry.path) })),
    };
    const deletedEntries = (previous.deletedEntries ?? []).map(key => {
      try {
        const [kind, path, category] = JSON.parse(key);
        return entryKey({ kind, path: absolute(path), category });
      } catch { return key; }
    });
    remote = mergeLogical(migrated, {
      folders: remote?.folders ?? [], entries: remote?.entries ?? [],
      deletedFolders: [...(remote?.deletedFolders ?? []), ...(previous.deletedFolders ?? [])],
      deletedEntries: [...(remote?.deletedEntries ?? []), ...deletedEntries],
    }, null);
    delete document.workspaces[legacyWorkspace];
  }
  const baselineKey = `nexusdesk.cloudSync.baseline:${current.provider}:${current.repo}:global`;
  let baseline: LogicalSyncData | null = null;
  try { baseline = JSON.parse(settingsStorage.getItem(baselineKey) || "null"); }
  catch { /* 损坏的本地基线按首次同步处理，避免推断删除。 */ }
  const merged = mergeLogical(local, remote, baseline);
  const applied = { workspace: "global", folders: merged.folders, entries: merged.entries };
  const nextDocument = {
    version: 1,
    updatedAt: Date.now(),
    workspaces: { ...document.workspaces, global: merged },
  };
  if (!snapshot.value || JSON.stringify(snapshot.value.workspaces) !== JSON.stringify(nextDocument.workspaces)) {
    await writeRepositoryFile(LOGICAL_FILE, nextDocument, `同步逻辑分区：分区 ${merged.folders.length} 个，记录 ${merged.entries.length} 条`);
  }
  const latestLocal = await fsApi.getLogicalSyncData(root);
  if (!logicalEqual(local, latestLocal)) return;
  if (!logicalEqual(local, applied)) {
    await fsApi.applyLogicalSyncData(root, { ...applied, deletedFolders: merged.deletedFolders });
  }
  settingsStorage.setItem(baselineKey, JSON.stringify(applied));
  // 新文件成功保存后才清理旧字段；通过导航队列避免同一文件并发写入。
  if (legacyFile?.value?.logicalPartitions) {
    await enqueue("navigation", async () => {
      const latest = await readRepositoryFile(DATA_FILE);
      if (!latest.value?.logicalPartitions) return;
      const { logicalPartitions: legacy, ...remaining } = latest.value;
      if (JSON.stringify(legacy) !== JSON.stringify(legacyFile?.value?.logicalPartitions)) return;
      await writeRepositoryFile(DATA_FILE, remaining, "迁移逻辑分区至独立文件");
    });
  }
  lastLogicalSnapshot = logicalSnapshot(applied);
}

function graphCategoryKey(category: GraphSyncData["categories"][number]) { return category.name.toLocaleLowerCase(); }
function graphFileKey(file: GraphSyncData["files"][number]) { return JSON.stringify([file.category.toLocaleLowerCase(), file.path.replace(/\\/g, "/")]); }
function graphEqual(a: Pick<GraphSyncData, "categories" | "files">, b: Pick<GraphSyncData, "categories" | "files">) {
  const categories = (value: GraphSyncData["categories"]) => value.map(item => [graphCategoryKey(item), item.color ?? null]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  return JSON.stringify(categories(a.categories)) === JSON.stringify(categories(b.categories))
    && JSON.stringify(a.files.map(graphFileKey).sort()) === JSON.stringify(b.files.map(graphFileKey).sort());
}
function validGraphWorkspace(value: unknown): value is GraphWorkspace {
  if (!value || typeof value !== "object") return false;
  const data = value as GraphWorkspace;
  return Array.isArray(data.categories) && data.categories.every(category => category && typeof category.name === "string" && (category.color === null || typeof category.color === "string"))
    && Array.isArray(data.files) && data.files.every(file => file && typeof file.category === "string" && typeof file.path === "string")
    && (data.deletedCategories === undefined || Array.isArray(data.deletedCategories) && data.deletedCategories.every(name => typeof name === "string"))
    && (data.deletedFiles === undefined || Array.isArray(data.deletedFiles) && data.deletedFiles.every(key => typeof key === "string"));
}
function mergeGraph(local: GraphSyncData, remote: GraphWorkspace | undefined, baseline: GraphSyncData | null): GraphWorkspace {
  const deletedCategories = new Set(remote?.deletedCategories ?? []);
  const deletedFiles = new Set(remote?.deletedFiles ?? []);
  const localCategories = new Map(local.categories.map(category => [graphCategoryKey(category), category]));
  const remoteCategories = new Map((remote?.categories ?? []).map(category => [graphCategoryKey(category), category]));
  const baselineCategories = new Map((baseline?.categories ?? []).map(category => [graphCategoryKey(category), category]));
  const localFiles = new Map(local.files.map(file => [graphFileKey(file), file]));
  const baselineFiles = new Set(baseline?.files.map(graphFileKey) ?? []);
  for (const key of baselineCategories.keys()) if (!localCategories.has(key)) deletedCategories.add(key);
  for (const key of baselineFiles) if (!localFiles.has(key)) deletedFiles.add(key);
  if (baseline) {
    for (const key of localCategories.keys()) if (!baselineCategories.has(key)) deletedCategories.delete(key);
    for (const key of localFiles.keys()) if (!baselineFiles.has(key)) deletedFiles.delete(key);
  }
  const categories = new Map(remoteCategories);
  for (const [key, category] of localCategories) {
    const base = baselineCategories.get(key);
    const remoteCategory = remoteCategories.get(key);
    if (!remoteCategory || (base ? (category.color ?? null) !== (base.color ?? null) : !!category.color || !remoteCategory.color)) categories.set(key, category);
  }
  for (const key of deletedCategories) categories.delete(key);
  const files = new Map((remote?.files ?? []).map(file => [graphFileKey(file), file]));
  for (const [key, file] of localFiles) files.set(key, file);
  for (const [key, file] of files) if (deletedCategories.has(file.category.toLocaleLowerCase())) deletedFiles.add(key);
  return {
    categories: [...categories.values()].sort((a, b) => a.name.localeCompare(b.name)),
    files: [...files.entries()].filter(([key, file]) => !deletedFiles.has(key) && categories.has(file.category.toLocaleLowerCase())).map(([, file]) => file).sort((a, b) => graphFileKey(a).localeCompare(graphFileKey(b))),
    deletedCategories: [...deletedCategories].sort(),
    deletedFiles: [...deletedFiles].sort(),
  };
}

async function syncGraph() {
  if (!getCloudSyncSelection().graphPartitions) return false;
  const root = useWorkspaceStore.getState().rootPath;
  if (!root || root.startsWith("sftp:")) return false;
  const local = await fsApi.getGraphSyncData(root);
  const snapshot = await readRepositoryFile(GRAPH_FILE);
  let document: GraphFile;
  if (snapshot.value) {
    if (snapshot.value.version !== 1 || !snapshot.value.workspaces || typeof snapshot.value.workspaces !== "object" || Array.isArray(snapshot.value.workspaces)) throw new Error("云端图谱分区文件格式无效或版本不受支持");
    document = { ...(snapshot.value as GraphFile), workspaces: { ...(snapshot.value as GraphFile).workspaces } };
  } else document = { version: 1, updatedAt: 0, workspaces: {} };
  if (!Object.values(document.workspaces).every(validGraphWorkspace)) throw new Error("云端图谱分区数据格式无效");
  const baselineKey = `nexusdesk.cloudSync.baseline:${current.provider}:${current.repo}:${root}:${local.workspace}:graph`;
  let baseline: GraphSyncData | null = null;
  try { baseline = JSON.parse(settingsStorage.getItem(baselineKey) || "null"); } catch { /* 无效基线按首次同步处理。 */ }
  const merged = mergeGraph(local, document.workspaces[local.workspace], baseline);
  const applied: GraphSyncData = { workspace: local.workspace, categories: merged.categories, files: merged.files };
  if (useWorkspaceStore.getState().rootPath !== root) return;
  const workspaces = { ...document.workspaces, [local.workspace]: merged };
  if (!snapshot.value || JSON.stringify(snapshot.value.workspaces) !== JSON.stringify(workspaces)) {
    await writeRepositoryFile(GRAPH_FILE, { version: 1, updatedAt: Date.now(), workspaces }, `同步图谱分区：分类 ${merged.categories.length} 个，关联 ${merged.files.length} 条`);
  }
  if (useWorkspaceStore.getState().rootPath !== root) return;
  const latestLocal = await fsApi.getGraphSyncData(root);
  if (useWorkspaceStore.getState().rootPath !== root || !graphEqual(local, latestLocal)) return;
  if (!graphEqual(local, applied)) await fsApi.applyGraphSyncData(root, applied);
  settingsStorage.setItem(baselineKey, JSON.stringify(applied));
  lastGraphSnapshot = graphSnapshot(root, applied);
}

function graphSnapshot(root: string, data: GraphSyncData) {
  return JSON.stringify([root, data.workspace, data.categories.map(category => [graphCategoryKey(category), category.color ?? null]).sort(), data.files.map(graphFileKey).sort()]);
}
let lastGraphSnapshot: string | null = null;

function publishError(channel: SyncChannel, error: unknown) {
  const fileName = channel === "navigation" ? DATA_FILE : channel === "logical" ? LOGICAL_FILE : GRAPH_FILE;
  const fileErrors = { ...current.fileErrors, [channel]: `${fileName}：${String(error)}` };
  update({ fileErrors, status: Object.values(fileErrors).some(value => value?.includes("版本已变化")) ? "conflict" : "error", error: Object.values(fileErrors).filter(Boolean).join("；") });
}

function enqueue(channel: SyncChannel, action: () => Promise<void | boolean>, shouldSync?: () => Promise<boolean>): Promise<void> {
  const task = queues[channel].then(async () => {
    try { if (shouldSync && !await shouldSync()) return; }
    catch (error) { publishError(channel, error); throw error; }
    active.add(channel);
    update({ status: "syncing" });
    try {
      const completed = await action();
      const fileErrors = { ...current.fileErrors };
      delete fileErrors[channel];
      update({ fileErrors, error: Object.values(fileErrors).filter(Boolean).join("；"), ...(completed === false ? {} : { lastSync: Date.now() }) });
    } catch (error) { publishError(channel, error); throw error; }
    finally {
      active.delete(channel);
      const errors = Object.values(current.fileErrors ?? {}).filter(Boolean);
      update({ status: errors.length ? (errors.some(value => value?.includes("版本已变化")) ? "conflict" : "error") : active.size ? "syncing" : "connected" });
    }
  });
  queues[channel] = task.catch(() => {});
  return task;
}

function queuePush(channel: SyncChannel, mergeRemote = false) {
  if (!ready || !token || current.status === "disconnected") return;
  const selection = getCloudSyncSelection();
  if (!(channel === "navigation" ? selection.myNavigation : channel === "logical" ? selection.logicalPartitions : selection.graphPartitions)) return;
  window.clearTimeout(timers[channel]);
  timers[channel] = window.setTimeout(() => {
    const action = channel === "navigation" ? () => syncNavigation(mergeRemote) : channel === "logical" ? syncLogical : syncGraph;
    void enqueue(channel, action, async () => {
      if (current.fileErrors?.[channel]) return true;
      if (channel === "navigation") return mergeRemote || JSON.stringify(navigationSnapshot(await loadNavigationData())) !== lastNavigationSnapshot;
      const root = useWorkspaceStore.getState().rootPath;
      if (channel === "logical") return logicalSnapshot(await fsApi.getLogicalSyncData(root ?? "")) !== lastLogicalSnapshot;
      if (!root || root.startsWith("sftp:")) return true;
      return graphSnapshot(root, await fsApi.getGraphSyncData(root)) !== lastGraphSnapshot;
    }).catch(() => {});
  }, 1800);
}

window.addEventListener("nexusdesk-navigation-data-changed", () => {
  if (!suppressSave) queuePush("navigation");
});
window.addEventListener("nexusdesk-navigation-preferences-changed", () => {
  if (!suppressSave) queuePush("navigation");
});
window.addEventListener("nexusdesk-logical-data-changed", () => {
  if (!suppressSave) { queuePush("logical"); queuePush("graph"); }
});
window.addEventListener("nexusdesk-graph-data-changed", () => {
  if (!suppressSave) queuePush("graph");
});
window.addEventListener("nexusdesk-cloud-sync-selection-changed", () => {
  if (!suppressSave) { queuePush("navigation", true); queuePush("logical"); queuePush("graph"); }
  if (!getCloudSyncSelection().logicalPartitions) update({ logicalNotice: "" });
});

export function getCloudSyncSelection() {
  return {
    myNavigation: settingsStorage.getItem(SYNC_NAVIGATION_KEY) !== "false",
    logicalPartitions: settingsStorage.getItem(SYNC_LOGICAL_KEY) === "true",
    graphPartitions: settingsStorage.getItem(SYNC_GRAPH_KEY) === "true",
  };
}

export function setCloudSyncSelection(selection: { myNavigation: boolean; logicalPartitions: boolean; graphPartitions: boolean }) {
  settingsStorage.setItem(SYNC_NAVIGATION_KEY, String(selection.myNavigation));
  settingsStorage.setItem(SYNC_LOGICAL_KEY, String(selection.logicalPartitions));
  settingsStorage.setItem(SYNC_GRAPH_KEY, String(selection.graphPartitions));
  window.dispatchEvent(new Event("nexusdesk-cloud-sync-selection-changed"));
}

async function waitForGithubBranch(repo: string) {
  // 新建仓库的初始提交可能晚于创建接口完成。
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(githubBranch)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
    if (response.ok) return;
    if (response.status !== 404 && response.status !== 409) throw new Error(`检查 GitHub 仓库初始化失败 (${response.status})`);
    if (attempt < 5) await new Promise<void>(resolve => window.setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error("GitHub 仓库仍在初始化，请稍后重新连接。");
}

async function connect(tokenValue: string, repoValue: string, createIfMissing: boolean, provider = current.provider): Promise<NavigationData> {
  ready = false;
  for (const timer of Object.values(timers)) window.clearTimeout(timer);
  await Promise.all(Object.values(queues));
  current = { ...current, provider };
  token = tokenValue.trim();
  if (!token) throw new Error("请输入 GitHub Token。");
  update({ status: "connecting", error: "" });
  try {
    const user = provider === "github" ? await request<{ login: string }>("https://api.github.com/user") : provider === "gitlab" ? await request<{ username: string }>("https://gitlab.com/api/v4/user") : await request<{ login: string }>("https://gitee.com/api/v5/user");
    const username = "login" in user ? user.login : user.username;
    let repo = repoValue.trim() || `${username}/nexus-data`;
    if (!repo.includes("/")) repo = `${username}/${repo}`;
    const repoParts = repo.split("/");
    if (repoParts.length !== 2 || repoParts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..")) {
      throw new Error("仓库名称应为 owner/repository 格式。");
    }
    const repoPath = repoParts.map(encodeURIComponent).join("/");
    const options = { signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) };
    const repoResponse = provider === "github" ? await fetch(`https://api.github.com/repos/${repoPath}`, { ...options, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }) : provider === "gitlab" ? await fetch(`https://gitlab.com/api/v4/projects/${encodeURIComponent(repo)}`, { ...options, headers: { "PRIVATE-TOKEN": token } }) : await fetch(`https://gitee.com/api/v5/repos/${repoPath}`, { ...options, headers: { Authorization: `token ${token}` } });
    if (repoResponse.status === 404 && createIfMissing && provider === "github") {
      const repoName = repo.slice(repo.lastIndexOf("/") + 1);
      const repository = await request<{ default_branch?: string }>("https://api.github.com/user/repos", "POST", { name: repoName, description: "NexusDesk 导航数据", private: true, auto_init: true });
      githubBranch = repository.default_branch || "main";
      await waitForGithubBranch(repoPath);
    } else if (!repoResponse.ok) throw new Error(`无法访问仓库 ${repo} (${repoResponse.status})`);
    else {
      const repository = await repoResponse.json() as { private?: boolean; visibility?: string; default_branch?: string };
      const isPrivate = provider === "gitlab" ? repository.visibility === "private" : repository.private === true;
      if (!isPrivate) throw new Error("导航云同步仅允许连接私有仓库，请将仓库设为私有后重试。");
      if (provider === "github") githubBranch = repository.default_branch || "main";
    }
    repo = repoPath;
    settingsStorage.setItem(TOKEN_KEYS[provider], token);
    settingsStorage.setItem(REPO_KEYS[provider], repo);
    settingsStorage.setItem(PROVIDER_KEY, provider);
    current = { ...current, provider, user: username, repo, status: "connected", lastSync: null, error: "" };
    files.clear();
    remoteData = null;
    lastNavigationSnapshot = null;
    lastLogicalSnapshot = null;
    update({ fileErrors: {}, error: "", logicalNotice: "" });
    ready = true;
    settingsStorage.setItem(SYNC_ENABLED_KEY, "true");
    await syncSelected();
    update({ status: "connected", error: "" });
    return loadNavigationData();
  } catch (error) {
    update({ status: Object.values(current.fileErrors ?? {}).some(value => value?.includes("版本已变化")) ? "conflict" : "error", error: String(error) });
    throw error;
  }
}

let initialized: Promise<NavigationData | null> | undefined;
export function initializeNavigationSync(): Promise<NavigationData | null> {
  if (initialized) return initialized;
  initialized = (async () => {
    const storedProvider = settingsStorage.getItem(PROVIDER_KEY);
    let provider: NavigationSyncProvider = storedProvider === "gitlab" || storedProvider === "gitee" ? storedProvider : "github";
    update({ provider });
    if (settingsStorage.getItem(SYNC_ENABLED_KEY) === "false") return null;
    let savedToken = settingsStorage.getItem(TOKEN_KEYS[provider]) || "";
    let savedRepo = settingsStorage.getItem(REPO_KEYS[provider]) || "";
    if (!savedToken) {
      savedToken = localStorage.getItem(LEGACY_TOKEN_KEY) || "";
      savedRepo = localStorage.getItem(LEGACY_REPO_KEY) || savedRepo;
      if (savedToken) {
        provider = "github";
        current = { ...current, provider };
        settingsStorage.setItem(TOKEN_KEYS.github, savedToken);
        settingsStorage.setItem(REPO_KEYS.github, savedRepo);
        localStorage.removeItem(LEGACY_TOKEN_KEY);
        localStorage.removeItem(LEGACY_REPO_KEY);
      }
    }
    if (!savedToken) return null;
    try { return await connect(savedToken, savedRepo, false, provider); }
    catch (error) {
      update({ status: "error", error: String(error) });
      return null;
    }
  })();
  return initialized;
}

export async function connectNavigationSync(tokenValue: string, repoValue: string, provider: NavigationSyncProvider) {
  const savedToken = settingsStorage.getItem(TOKEN_KEYS[provider]) || "";
  const connection = connect(tokenValue.trim() || savedToken, repoValue, true, provider);
  initialized = connection.catch(() => null);
  return connection;
}

async function syncSelected() {
  const selection = getCloudSyncSelection();
  const results = await Promise.allSettled([
    ...(selection.myNavigation ? [enqueue("navigation", syncNavigation)] : []),
    ...(selection.logicalPartitions ? [enqueue("logical", syncLogical)] : []),
    ...(selection.graphPartitions ? [enqueue("graph", syncGraph)] : []),
  ]);
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export async function syncNavigationNow() {
  if (!token || !current.repo) throw new Error("请先连接云同步。");
  for (const timer of Object.values(timers)) window.clearTimeout(timer);
  await syncSelected();
}

export async function disconnectNavigationSync() {
  for (const timer of Object.values(timers)) window.clearTimeout(timer);
  ready = false;
  settingsStorage.setItem(SYNC_ENABLED_KEY, "false");
  await Promise.all(Object.values(queues));
  token = "";
  files.clear();
  remoteData = null;
  update({ status: "disconnected", user: "", repo: "", lastSync: null, error: "", fileErrors: {}, logicalNotice: "" });
}
