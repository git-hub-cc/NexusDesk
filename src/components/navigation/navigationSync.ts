import { settingsStorage } from "@/lib/globalSettings";
import { loadNavigationData, mergeNavigationData, saveNavigationData, type NavigationCategory, type NavigationData } from "./navigationData";

const TOKEN_KEY = "nexusdesk.navigation.githubToken";
const REPO_KEY = "nexusdesk.navigation.githubRepo";
const LEGACY_TOKEN_KEY = "navhub-github-token";
const LEGACY_REPO_KEY = "navhub-github-repo";
const DATA_FILE = "navhub-data.json";
type SyncStatus = "disconnected" | "connecting" | "connected" | "syncing" | "error" | "conflict";
export type NavigationSyncState = { status: SyncStatus; user: string; repo: string; lastSync: number | null; error: string };

let current: NavigationSyncState = { status: "disconnected", user: "", repo: "", lastSync: null, error: "" };
let token = "";
let remoteSha: string | null = null;
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
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({})) as { message?: string };
    if (response.status === 409 || response.status === 422) throw new Error("云端版本已变化，请重新同步后重试。");
    throw new Error(details.message || `GitHub 请求失败 (${response.status})`);
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
  const result = await fetch(`https://api.github.com/repos/${current.repo}/contents/${DATA_FILE}?t=${Date.now()}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (result.status === 404) return { data: null, sha: null };
  if (!result.ok) throw new Error(`读取 GitHub 数据失败 (${result.status})`);
  const file = await result.json() as { content: string; sha: string; download_url?: string };
  let raw = file.content ? decodeBase64(file.content) : "";
  if (!raw && file.download_url) {
    const download = await fetch(file.download_url, { headers: { Authorization: `Bearer ${token}` } });
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
  if (data && Array.isArray(data.categories)) return { data, sha: file.sha };
  return { data: legacyRemoteData(parsed), sha: file.sha };
}

async function push(data: NavigationData) {
  const content = {
    updatedAt: Date.now(),
    navigationData: data,
    preferences: {
      theme: localStorage.getItem("theme-preference") || "dark",
      proxyMode: localStorage.getItem("proxy-mode-preference") === "true",
    },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(content));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  const encoded = btoa(binary);
  const result = await request<{ content: { sha: string } }>(`https://api.github.com/repos/${current.repo}/contents/${DATA_FILE}`, "PUT", {
    message: "同步 NexusDesk 导航数据", content: encoded, branch: "main", ...(remoteSha ? { sha: remoteSha } : {}),
  });
  remoteSha = result.content.sha;
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

async function connect(tokenValue: string, repoValue: string, createIfMissing: boolean) {
  token = tokenValue.trim();
  if (!token) throw new Error("请输入 GitHub Token。");
  update({ status: "connecting", error: "" });
  try {
    const user = await request<{ login: string }>("https://api.github.com/user");
    let repo = repoValue.trim() || `${user.login}/navhub-data`;
    if (!repo.includes("/")) repo = `${user.login}/${repo}`;
    const repoParts = repo.split("/");
    if (repoParts.length !== 2 || repoParts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..")) {
      throw new Error("仓库名称应为 owner/repository 格式。");
    }
    repo = repoParts.map(encodeURIComponent).join("/");
    const repoResponse = await fetch(`https://api.github.com/repos/${repo}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
    if (repoResponse.status === 404 && createIfMissing) {
      const repoName = repo.slice(repo.lastIndexOf("/") + 1);
      await request("https://api.github.com/user/repos", "POST", { name: repoName, description: "NexusDesk 导航数据", private: true, auto_init: true });
    } else if (!repoResponse.ok) throw new Error(`无法访问仓库 ${repo} (${repoResponse.status})`);
    settingsStorage.setItem(TOKEN_KEY, token);
    settingsStorage.setItem(REPO_KEY, repo);
    current = { ...current, user: user.login, repo, status: "connected", error: "" };
    const local = await loadNavigationData();
    const remote = await readRemote();
    remoteSha = remote.sha;
    if (remote.data) {
      const merged = mergeNavigationData(local, remote.data);
      suppressSave = true;
      saveNavigationData(merged);
      suppressSave = false;
      await push(merged);
    } else await push(local);
    ready = true;
    update({ status: "connected", lastSync: Date.now(), error: "" });
  } catch (error) {
    ready = false;
    update({ status: "error", error: String(error) });
    throw error;
  }
}

let initialized: Promise<void> | undefined;
export function initializeNavigationSync(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    let savedToken = settingsStorage.getItem(TOKEN_KEY) || "";
    let savedRepo = settingsStorage.getItem(REPO_KEY) || "";
    if (!savedToken) {
      savedToken = localStorage.getItem(LEGACY_TOKEN_KEY) || "";
      savedRepo = localStorage.getItem(LEGACY_REPO_KEY) || savedRepo;
      if (savedToken) {
        settingsStorage.setItem(TOKEN_KEY, savedToken);
        settingsStorage.setItem(REPO_KEY, savedRepo);
        localStorage.removeItem(LEGACY_TOKEN_KEY);
        localStorage.removeItem(LEGACY_REPO_KEY);
      }
    }
    if (savedToken) {
      try { await connect(savedToken, savedRepo, false); }
      catch (error) { update({ status: "error", error: String(error) }); }
    }
  })();
  return initialized;
}

export async function connectNavigationSync(tokenValue: string, repoValue: string) {
  initialized = undefined;
  await connect(tokenValue, repoValue, true);
}

export async function syncNavigationNow() {
  if (!token || !current.repo) throw new Error("请先连接 GitHub。");
  window.clearTimeout(saveTimer);
  await syncQueue;
  update({ status: "syncing", error: "" });
  const local = await loadNavigationData();
  const remote = await readRemote();
  remoteSha = remote.sha;
  const merged = remote.data ? mergeNavigationData(local, remote.data) : local;
  suppressSave = true;
  saveNavigationData(merged);
  suppressSave = false;
  await push(merged);
}

export function disconnectNavigationSync() {
  window.clearTimeout(saveTimer);
  token = "";
  remoteSha = null;
  ready = false;
  settingsStorage.setItem(TOKEN_KEY, "");
  settingsStorage.setItem(REPO_KEY, "");
  update({ status: "disconnected", user: "", repo: "", lastSync: null, error: "" });
}
