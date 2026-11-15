import { settingsStorage } from "@/lib/globalSettings";
import { loadNavigationData, mergeNavigationData, saveNavigationData, type NavigationCategory, type NavigationData } from "./navigationData";

export type NavigationSyncProvider = "github" | "gitlab" | "gitee";
const TOKEN_KEYS: Record<NavigationSyncProvider, string> = { github: "nexusdesk.navigation.githubToken", gitlab: "nexusdesk.navigation.gitlabToken", gitee: "nexusdesk.navigation.giteeToken" };
const REPO_KEYS: Record<NavigationSyncProvider, string> = { github: "nexusdesk.navigation.githubRepo", gitlab: "nexusdesk.navigation.gitlabRepo", gitee: "nexusdesk.navigation.giteeRepo" };
const PROVIDER_KEY = "nexusdesk.navigation.provider";
const SYNC_ENABLED_KEY = "nexusdesk.navigation.syncEnabled";
const LEGACY_TOKEN_KEY = "navhub-github-token";
const LEGACY_REPO_KEY = "navhub-github-repo";
const DATA_FILE = "navhub-data.json";
const SYNC_TIMEOUT_MS = 15000;
type SyncStatus = "disconnected" | "connecting" | "connected" | "syncing" | "error" | "conflict";
export type NavigationSyncState = { status: SyncStatus; provider: NavigationSyncProvider; user: string; repo: string; lastSync: number | null; error: string };

let current: NavigationSyncState = { status: "disconnected", provider: "github", user: "", repo: "", lastSync: null, error: "" };
let token = "";
let remoteSha: string | null = null;
let remoteFileExists = false;
let remoteData: NavigationData | null = null;
let ready = false;
let suppressSave = false;
let saveTimer: number | undefined;
let syncQueue = Promise.resolve();
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

async function readRemote(): Promise<{ data: NavigationData | null; sha: string | null }> {
  const path = encodeURIComponent(DATA_FILE);
  const url = current.provider === "github" ? `https://api.github.com/repos/${current.repo}/contents/${path}?t=${Date.now()}` : current.provider === "gitlab" ? `https://gitlab.com/api/v4/projects/${encodeURIComponent(current.repo)}/repository/files/${path}?ref=main&t=${Date.now()}` : `https://gitee.com/api/v5/repos/${current.repo}/contents/${path}?ref=master&t=${Date.now()}`;
  const headers: Record<string, string> = current.provider === "github" ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } : current.provider === "gitlab" ? { "PRIVATE-TOKEN": token } : { Authorization: `token ${token}` };
  const result = await fetch(url, { headers, signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
  if (result.status === 404) return { data: null, sha: null };
  if (!result.ok) throw new Error(`读取 GitHub 数据失败 (${result.status})`);
  const file = await result.json() as { content: string; sha?: string; blob_id?: string; last_commit_id?: string; encoding?: string; download_url?: string };
  let raw = file.content ? (current.provider === "gitlab" && file.encoding !== "base64" ? file.content : decodeBase64(file.content)) : "";
  if (!raw && file.download_url) {
    const download = await fetch(file.download_url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
    if (!download.ok) throw new Error(`下载 GitHub 数据失败 (${download.status})`);
    raw = await download.text();
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const data = parsed.navigationData as NavigationData | undefined;
  const preferences = parsed.preferences as { theme?: string; proxyMode?: boolean } | undefined;
  if (preferences) {
    if (preferences.theme === "dark" || preferences.theme === "light") localStorage.setItem("theme-preference", preferences.theme);
    if (typeof preferences.proxyMode === "boolean") localStorage.setItem("proxy-mode-preference", String(preferences.proxyMode));
    const previous = suppressSave;
    suppressSave = true;
    window.dispatchEvent(new CustomEvent("nexusdesk-navigation-preferences-changed", { detail: preferences }));
    suppressSave = previous;
  }
  const sha = file.sha || file.last_commit_id || file.blob_id || null;
  if (data && Array.isArray(data.categories)) return { data, sha };
  return { data: legacyRemoteData(parsed), sha };
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
  if (changes.added + changes.modified + changes.deleted === 0) return "同步导航：更新显示偏好";
  return `同步导航：新增 ${changes.added} 项，修改 ${changes.modified} 项，删除 ${changes.deleted} 项`;
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

async function push(data: NavigationData) {
  await verifyPrivateRepository();
  const content = {
    updatedAt: Date.now(),
    navigationData: data,
    preferences: {
      theme: localStorage.getItem("theme-preference") || "dark",
      proxyMode: localStorage.getItem("proxy-mode-preference") === "true",
    },
  };
  const serialized = JSON.stringify(content, null, 2);
  const message = commitMessage(remoteData, data);
  const bytes = new TextEncoder().encode(serialized);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  const encoded = btoa(binary);
  let sha = remoteSha;
  if (current.provider === "github") {
    const result = await request<{ content: { sha: string } }>(`https://api.github.com/repos/${current.repo}/contents/${DATA_FILE}`, "PUT", { message, content: encoded, branch: "main", ...(remoteSha ? { sha: remoteSha } : {}) });
    sha = result.content.sha;
  } else if (current.provider === "gitlab") {
    const path = encodeURIComponent(DATA_FILE);
    await request(`https://gitlab.com/api/v4/projects/${encodeURIComponent(current.repo)}/repository/files/${path}`, remoteFileExists ? "PUT" : "POST", { branch: "main", commit_message: message, content: serialized });
  } else {
    const result = await request<{ content: { sha: string } }>(`https://gitee.com/api/v5/repos/${current.repo}/contents/${encodeURIComponent(DATA_FILE)}`, remoteFileExists ? "PUT" : "POST", { message, content: encoded, branch: "master", ...(remoteSha ? { sha: remoteSha } : {}) });
    sha = result.content.sha;
  }
  remoteSha = sha;
  remoteFileExists = true;
  remoteData = data;
  update({ status: "connected", lastSync: Date.now(), error: "" });
}

function queuePush() {
  if (!ready || !token || current.status === "disconnected") return;
  window.clearTimeout(saveTimer);
  update({ status: "syncing", error: "" });
  saveTimer = window.setTimeout(() => {
    const task = syncQueue.then(async () => push(await loadNavigationData()));
    syncQueue = task.catch(error => {
      update({ status: String(error).includes("版本已变化") ? "conflict" : "error", error: String(error) });
    });
  }, 1800);
}

window.addEventListener("nexusdesk-navigation-data-changed", () => {
  if (!suppressSave) queuePush();
});
window.addEventListener("nexusdesk-navigation-preferences-changed", () => {
  if (!suppressSave) queuePush();
});

async function connect(tokenValue: string, repoValue: string, createIfMissing: boolean, provider = current.provider): Promise<NavigationData> {
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
    current = { ...current, provider, user: username, repo, status: "connected", error: "" };
    const local = await loadNavigationData();
    const remote = await readRemote();
    remoteSha = remote.sha;
    remoteFileExists = remote.sha !== null;
    remoteData = remote.data;
    const merged = remote.data ? mergeNavigationData(local, remote.data) : local;
    if (remote.data) {
      suppressSave = true;
      saveNavigationData(merged);
      suppressSave = false;
    }
    await push(merged);
    ready = true;
    settingsStorage.setItem(SYNC_ENABLED_KEY, "true");
    update({ status: "connected", lastSync: Date.now(), error: "" });
    return merged;
  } catch (error) {
    ready = false;
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

export async function syncNavigationNow() {
  if (!token || !current.repo) throw new Error("请先连接 GitHub。");
  window.clearTimeout(saveTimer);
  await syncQueue;
  update({ status: "syncing", error: "" });
  try {
    const local = await loadNavigationData();
    const remote = await readRemote();
    remoteSha = remote.sha;
    remoteFileExists = remote.sha !== null;
    remoteData = remote.data;
    const merged = remote.data ? mergeNavigationData(local, remote.data) : local;
    suppressSave = true;
    try { saveNavigationData(merged); }
    finally { suppressSave = false; }
    await push(merged);
  } catch (error) {
    update({ status: String(error).includes("版本已变化") ? "conflict" : "error", error: String(error) });
    throw error;
  }
}

export async function disconnectNavigationSync() {
  window.clearTimeout(saveTimer);
  ready = false;
  settingsStorage.setItem(SYNC_ENABLED_KEY, "false");
  await syncQueue;
  token = "";
  remoteSha = null;
  remoteFileExists = false;
  remoteData = null;
  ready = false;
  update({ status: "disconnected", user: "", repo: "", lastSync: null, error: "" });
}
