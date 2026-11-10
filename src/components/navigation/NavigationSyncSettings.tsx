import { useEffect, useState, type FormEvent } from "react";
import { Cloud, LoaderCircle, RefreshCw, Unplug } from "lucide-react";
import { settingsStorage } from "@/lib/globalSettings";
import {
  connectNavigationSync,
  disconnectNavigationSync,
  getNavigationSyncState,
  initializeNavigationSync,
  subscribeNavigationSync,
  syncNavigationNow,
  type NavigationSyncProvider,
  type NavigationSyncState,
} from "./navigationSync";

const inputClass = "w-full min-w-0 rounded border border-ide-panel-border bg-ide-bg px-2 py-1.5 outline-none focus:border-ide-accent";

export function NavigationSyncSettings() {
  const [state, setState] = useState<NavigationSyncState>(getNavigationSyncState());
  const [provider, setProvider] = useState<NavigationSyncProvider>(getNavigationSyncState().provider);
  const [token, setToken] = useState("");
  const repoKey = `nexusdesk.navigation.${provider}Repo`;
  const [repo, setRepo] = useState(() => settingsStorage.getItem(repoKey) || "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeNavigationSync(next => { setState(next); setProvider(next.provider); });
    void initializeNavigationSync();
    return () => { unsubscribe(); };
  }, []);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await connectNavigationSync(token, repo, provider);
      setToken("");
      setRepo(getNavigationSyncState().repo);
    } catch { /* The sync service publishes the connection error. */ }
    finally { setBusy(false); }
  };

  const sync = async () => {
    setBusy(true);
    try { await syncNavigationNow(); }
    catch { /* The sync service publishes the error state. */ }
    finally { setBusy(false); }
  };

  const disconnect = () => {
    disconnectNavigationSync();
    setRepo("");
  };
  const changeProvider = (value: NavigationSyncProvider) => {
    setProvider(value);
    setRepo(settingsStorage.getItem(`nexusdesk.navigation.${value}Repo`) || "");
    setToken("");
  };

  const statusLabel = state.status === "connecting" ? "正在连接" : state.status === "syncing" ? "正在同步" : state.status === "connected" ? "已连接" : state.status === "conflict" ? "版本冲突" : state.status === "error" ? "同步失败" : "未连接";

  return <div className="mx-auto w-full max-w-3xl p-8" onKeyDown={event => event.stopPropagation()}>
    <header className="mb-6 border-b border-ide-panel-border pb-4">
      <h2 className="text-xl font-semibold">导航云同步</h2>
      <p className="mt-1 text-sm text-gray-400">选择 GitHub、GitLab 或 Gitee，将导航数据和显示偏好同步到你自己的代码仓库。</p>
    </header>
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex items-center gap-2 text-gray-300"><Cloud size={16} /><span>{statusLabel}</span>{(state.status === "connecting" || state.status === "syncing") && <LoaderCircle size={14} className="animate-spin" />}</div>
      {state.status === "connected" || state.status === "syncing" || state.status === "conflict" ? <>
        <div className="rounded border border-ide-panel-border bg-ide-panel-bg p-3">
          <div className="font-medium">{state.provider} · {state.user}</div>
          <div className="mt-1 text-xs text-gray-400">仓库：{state.repo}</div>
          {state.lastSync && <div className="mt-1 text-xs text-gray-500">最近同步：{new Date(state.lastSync).toLocaleString()}</div>}
        </div>
        <div className="flex gap-2">
          <button type="button" disabled={busy || state.status === "syncing"} onClick={() => void sync()} className="flex items-center gap-2 rounded bg-ide-accent px-3 py-2 text-white disabled:opacity-50"><RefreshCw size={14} />立即同步</button>
          <button type="button" disabled={busy} onClick={disconnect} className="flex items-center gap-2 rounded border border-ide-panel-border px-3 py-2 hover:bg-white/5 disabled:opacity-50"><Unplug size={14} />断开连接</button>
        </div>
      </> : <form onSubmit={event => void connect(event)} className="flex flex-col gap-4">
        <label className="grid gap-1">同步平台<select className={inputClass} value={provider} onChange={event => changeProvider(event.target.value as NavigationSyncProvider)}><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="gitee">Gitee</option></select></label>
        <label className="grid gap-1">{provider === "github" ? "GitHub Personal Access Token" : provider === "gitlab" ? "GitLab Personal Access Token" : "Gitee Personal Access Token"}<input className={inputClass} type="password" required value={token} onChange={event => setToken(event.target.value)} placeholder={provider === "github" ? "ghp_..." : provider === "gitlab" ? "glpat-..." : "访问令牌"} autoComplete="new-password" /></label>
        <label className="grid gap-1">仓库名称（可选）<input className={inputClass} value={repo} onChange={event => setRepo(event.target.value)} placeholder={provider === "github" ? "默认创建 navhub-data 私有仓库" : "输入已有仓库 owner/repository"} spellCheck={false} /></label>
        <p className="text-xs text-gray-400">GitHub 支持自动创建私有仓库；GitLab 和 Gitee 请先创建仓库并授予读写权限。Token 保存在 NexusDesk 本机设置中。</p>
        <div><button type="submit" disabled={busy || !token.trim()} className="flex items-center gap-2 rounded bg-ide-accent px-3 py-2 text-white disabled:opacity-50">{busy && <LoaderCircle size={14} className="animate-spin" />}连接 {provider === "github" ? "GitHub" : provider === "gitlab" ? "GitLab" : "Gitee"}</button></div>
      </form>}
      {state.error && <p role="alert" className="break-all text-red-400">{state.error}</p>}
      {state.status === "connected" && <p className="text-xs text-gray-500">导航修改后会自动同步。连接时本地和云端网站会合并，重复网址保留本地版本。</p>}
    </div>
  </div>;
}
