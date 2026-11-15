import { settingsStorage } from "@/lib/globalSettings";
import { fsApi, type LogicalSyncData } from "@/lib/api";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { loadNavigationData, mergeNavigationData, saveNavigationData, type NavigationCategory, type NavigationData } from "./navigationData";

export type NavigationSyncProvider = "github" | "gitlab" | "gitee";
const TOKEN_KEYS: Record<NavigationSyncProvider, string> = { github: "nexusdesk.navigation.githubToken", gitlab: "nexusdesk.navigation.gitlabToken", gitee: "nexusdesk.navigation.giteeToken" };
const REPO_KEYS: Record<NavigationSyncProvider, string> = { github: "nexusdesk.navigation.githubRepo", gitlab: "nexusdesk.navigation.gitlabRepo", gitee: "nexusdesk.navigation.giteeRepo" };
const PROVIDER_KEY = "nexusdesk.navigation.provider";
const SYNC_ENABLED_KEY = "nexusdesk.navigation.syncEnabled";
const SYNC_NAVIGATION_KEY = "nexusdesk.cloudSync.myNavigation";
const SYNC_LOGICAL_KEY = "nexusdesk.cloudSync.logicalPartitions";
const LEGACY_TOKEN_KEY = "navhub-github-token";
const LEGACY_REPO_KEY = "navhub-github-repo";
const DATA_FILE = "navhub-data.json";
const LOGICAL_FILE = "logical-partitions.json";
const SYNC_TIMEOUT_MS = 15000;
type SyncStatus = "disconnected" | "connecting" | "connected" | "syncing" | "error" | "conflict";
export type NavigationSyncState = { status: SyncStatus; provider: NavigationSyncProvider; user: string; repo: string; lastSync: number | null; error: string; logicalNotice?: string; fileErrors?: Partial<Record<SyncChannel, string>> };

let current: NavigationSyncState = { status: "disconnected", provider: "github", user: "", repo: "", lastSync: null, error: "" };
let token = "";
type SyncChannel = "navigation" | "logical";
type RepositoryFile = { value: Record<string, unknown> | null; sha: string | null; exists: boolean };
type LogicalWorkspace = Omit<LogicalSyncData, "workspace"> & { deletedEntries?: string[] };
type LogicalFile = { version: 1; updatedAt: number; workspaces: Record<string, LogicalWorkspace> };
let remoteData: NavigationData | null = null;
let ready = false;
let suppressSave = false;
const files = new Map<string, RepositoryFile>();
const timers: Partial<Record<SyncChannel, number>> = {};
const queues: Record<SyncChannel, Promise<void>> = { navigation: Promise.resolve(), logical: Promise.resolve() };
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
    if (response.status === 409 || response.status === 422) throw new Error("云端版本已变化，请重新同步后重试。");
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
  const url = current.provider === "github" ? `https://api.github.com/repos/${current.repo}/contents/${path}?t=${Date.now()}` : current.provider === "gitlab" ? `https://gitlab.com/api/v4/projects/${encodeURIComponent(current.repo)}/repository/files/${path}?ref=main&t=${Date.now()}` : `https://gitee.com/api/v5/repos/${current.repo}/contents/${path}?ref=master&t=${Date.now()}`;
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
  const preferences = parsed.preferences as { theme?: string; proxyMode?: boolean } | undefined;
  if (preferences && applyPreferences) {
    if (preferences.theme === "dark" || preferences.theme === "light") localStorage.setItem("theme-preference", preferences.theme);
    if (typeof preferences.proxyMode === "boolean") localStorage.setItem("proxy-mode-preference", String(preferences.proxyMode));
    const previous = suppressSave;
    suppressSave = true;
    window.dispatchEvent(new CustomEvent("nexusdesk-navigation-preferences-changed", { detail: preferences }));
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
    const result = await request<{ content: { sha: string } }>(`https://api.github.com/repos/${current.repo}/contents/${path}`, "PUT", { message, content: encoded, branch: "main", ...(sha ? { sha } : {}) });
    sha = result.content.sha;
  } else if (current.provider === "gitlab") {
    await request(`https://gitlab.com/api/v4/projects/${encodeURIComponent(current.repo)}/repository/files/${path}`, snapshot.exists ? "PUT" : "POST", { branch: "main", commit_message: message, content: serialized, ...(sha ? { last_commit_id: sha } : {}) });
  } else {
    const result = await request<{ content: { sha: string } }>(`https://gitee.com/api/v5/repos/${current.repo}/contents/${path}`, snapshot.exists ? "PUT" : "POST", { message, content: encoded, branch: "master", ...(sha ? { sha } : {}) });
    sha = result.content.sha;
  }
  files.set(name, { value: content as Record<string, unknown>, sha, exists: true });
}

async function syncNavigation(mergeRemote = true) {
  if (!getCloudSyncSelection().myNavigation) return false;
  const local = await loadNavigationData();
  const remote = await readRemote(mergeRemote);
  const merged = remote && mergeRemote ? mergeNavigationData(local, remote) : local;
  suppressSave = true;
  try { if (remote) saveNavigationData(merged); }
  finally { suppressSave = false; }
  await writeRepositoryFile(DATA_FILE, {
    ...files.get(DATA_FILE)?.value,
    updatedAt: Date.now(),
    navigationData: { categories: merged.categories.filter(category => category.categoryId === "custom-user-sites") },
    preferences: {
      theme: localStorage.getItem("theme-preference") || "dark",
      proxyMode: localStorage.getItem("proxy-mode-preference") === "true",
    },
  }, commitMessage(remoteData ?? remote, merged));
  remoteData = merged;
}

function entryKey(entry: LogicalSyncData["entries"][number]) {
  return JSON.stringify([entry.kind, entry.path.replace(/\\/g, "/"), entry.category]);
}

function logicalEqual(a: Pick<LogicalSyncData, "folders" | "entries">, b: Pick<LogicalSyncData, "folders" | "entries">) {
  return JSON.stringify([...a.folders].sort()) === JSON.stringify([...b.folders].sort())
    && JSON.stringify(a.entries.map(entryKey).sort()) === JSON.stringify(b.entries.map(entryKey).sort());
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
  const deletedEntries = new Set(remote?.deletedEntries ?? []);
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
  const root = useWorkspaceStore.getState().rootPath;
  if (!root || root.startsWith("sftp:")) {
    update({ logicalNotice: root ? "当前 SFTP 项目不支持逻辑分区同步" : "逻辑分区等待打开本地项目" });
    return false;
  }
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
  const baselineKey = `nexusdesk.cloudSync.baseline:${current.provider}:${current.repo}:${root}:${local.workspace}`;
  let baseline: LogicalSyncData | null = null;
  try { baseline = JSON.parse(settingsStorage.getItem(baselineKey) || "null"); }
  catch { /* 损坏的本地基线按首次同步处理，避免推断删除。 */ }
  const merged = mergeLogical(local, document.workspaces[local.workspace], baseline);
  const applied = { workspace: local.workspace, folders: merged.folders, entries: merged.entries };
  if (useWorkspaceStore.getState().rootPath !== root) return;
  const nextDocument = {
    version: 1,
    updatedAt: Date.now(),
    workspaces: { ...document.workspaces, [local.workspace]: merged },
  };
  if (!snapshot.value || JSON.stringify(snapshot.value.workspaces) !== JSON.stringify(nextDocument.workspaces)) {
    await writeRepositoryFile(LOGICAL_FILE, nextDocument, `同步逻辑分区：${local.workspace}，分区 ${merged.folders.length} 个，记录 ${merged.entries.length} 条`);
  }
  if (useWorkspaceStore.getState().rootPath !== root) return;
  const latestLocal = await fsApi.getLogicalSyncData(root);
  if (useWorkspaceStore.getState().rootPath !== root || !logicalEqual(local, latestLocal)) return;
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
}

function publishError(channel: SyncChannel, error: unknown) {
  const fileErrors = { ...current.fileErrors, [channel]: `${channel === "navigation" ? DATA_FILE : LOGICAL_FILE}：${String(error)}` };
  update({ fileErrors, status: Object.values(fileErrors).some(value => value?.includes("版本已变化")) ? "conflict" : "error", error: Object.values(fileErrors).filter(Boolean).join("；") });
}

function enqueue(channel: SyncChannel, action: () => Promise<void | boolean>): Promise<void> {
  const task = queues[channel].then(async () => {
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
  if (!(channel === "navigation" ? selection.myNavigation : selection.logicalPartitions)) return;
  window.clearTimeout(timers[channel]);
  timers[channel] = window.setTimeout(() => {
    void enqueue(channel, channel === "navigation" ? () => syncNavigation(mergeRemote) : syncLogical).catch(() => {});
  }, 1800);
}

window.addEventListener("nexusdesk-navigation-data-changed", () => {
  if (!suppressSave) queuePush("navigation");
});
window.addEventListener("nexusdesk-navigation-preferences-changed", () => {
  if (!suppressSave) queuePush("navigation");
});
window.addEventListener("nexusdesk-logical-data-changed", () => {
  if (!suppressSave) queuePush("logical");
});
window.addEventListener("nexusdesk-cloud-sync-selection-changed", () => {
  if (!suppressSave) { queuePush("navigation", true); queuePush("logical"); }
  if (!getCloudSyncSelection().logicalPartitions) update({ logicalNotice: "" });
});

export function getCloudSyncSelection() {
  return {
    myNavigation: settingsStorage.getItem(SYNC_NAVIGATION_KEY) !== "false",
    logicalPartitions: settingsStorage.getItem(SYNC_LOGICAL_KEY) === "true",
  };
}

export function setCloudSyncSelection(selection: { myNavigation: boolean; logicalPartitions: boolean }) {
  settingsStorage.setItem(SYNC_NAVIGATION_KEY, String(selection.myNavigation));
  settingsStorage.setItem(SYNC_LOGICAL_KEY, String(selection.logicalPartitions));
  window.dispatchEvent(new Event("nexusdesk-cloud-sync-selection-changed"));
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
    let repo = repoValue.trim() || `${username}/navhub-data`;
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
      await request("https://api.github.com/user/repos", "POST", { name: repoName, description: "NexusDesk 导航数据", private: true, auto_init: true });
    } else if (!repoResponse.ok) throw new Error(`无法访问仓库 ${repo} (${repoResponse.status})`);
    else {
      const repository = await repoResponse.json() as { private?: boolean; visibility?: string };
      const isPrivate = provider === "gitlab" ? repository.visibility === "private" : repository.private === true;
      if (!isPrivate) throw new Error("导航云同步仅允许连接私有仓库，请将仓库设为私有后重试。");
    }
    repo = repoPath;
    settingsStorage.setItem(TOKEN_KEYS[provider], token);
    settingsStorage.setItem(REPO_KEYS[provider], repo);
    settingsStorage.setItem(PROVIDER_KEY, provider);
    current = { ...current, provider, user: username, repo, status: "connected", lastSync: null, error: "" };
    files.clear();
    remoteData = null;
    update({ fileErrors: {}, error: "", logicalNotice: "" });
    ready = true;
    settingsStorage.setItem(SYNC_ENABLED_KEY, "true");
    await syncSelected();
    update({ status: "connected", error: "" });
    return loadNavigationData();
  } catch (error) {
    update({ status: "error", error: String(error) });
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
  initialized = undefined;
  const savedToken = settingsStorage.getItem(TOKEN_KEYS[provider]) || "";
  return connect(tokenValue.trim() || savedToken, repoValue, true, provider);
}

async function syncSelected() {
  const selection = getCloudSyncSelection();
  const results = await Promise.allSettled([
    ...(selection.myNavigation ? [enqueue("navigation", syncNavigation)] : []),
    ...(selection.logicalPartitions ? [enqueue("logical", syncLogical)] : []),
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
