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
  type NavigationSyncState,
} from "./navigationSync";

const REPO_KEY = "nexusdesk.navigation.githubRepo";
const inputClass = "w-full min-w-0 rounded border border-ide-panel-border bg-ide-bg px-2 py-1.5 outline-none focus:border-ide-accent";

export function NavigationSyncSettings() {
  const [state, setState] = useState<NavigationSyncState>(getNavigationSyncState());
  const [token, setToken] = useState("");
  const [repo, setRepo] = useState(() => settingsStorage.getItem(REPO_KEY) || "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeNavigationSync(setState);
    void initializeNavigationSync();
    return () => { unsubscribe(); };
  }, []);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await connectNavigationSync(token, repo);
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

  const statusLabel = state.status === "connecting" ? "正在连接" : state.status === "syncing" ? "正在同步" : state.status === "connected" ? "已连接" : state.status === "conflict" ? "版本冲突" : state.status === "error" ? "同步失败" : "未连接";

  return <div className="mx-auto w-full max-w-3xl p-8" onKeyDown={event => event.stopPropagation()}>
    <header className="mb-6 border-b border-ide-panel-border pb-4">
      <h2 className="text-xl font-semibold">导航云同步</h2>
      <p className="mt-1 text-sm text-gray-400">将导航数据和显示偏好保存在你的 GitHub 私有仓库中。</p>
    </header>
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex items-center gap-2 text-gray-300"><Cloud size={16} /><span>{statusLabel}</span>{(state.status === "connecting" || state.status === "syncing") && <LoaderCircle size={14} className="animate-spin" />}</div>
      {state.status === "connected" || state.status === "syncing" || state.status === "conflict" ? <>
        <div className="rounded border border-ide-panel-border bg-ide-panel-bg p-3">
          <div className="font-medium">{state.user}</div>
          <div className="mt-1 text-xs text-gray-400">仓库：{state.repo}</div>
          {state.lastSync && <div className="mt-1 text-xs text-gray-500">最近同步：{new Date(state.lastSync).toLocaleString()}</div>}
        </div>
        <div className="flex gap-2">
          <button type="button" disabled={busy || state.status === "syncing"} onClick={() => void sync()} className="flex items-center gap-2 rounded bg-ide-accent px-3 py-2 text-white disabled:opacity-50"><RefreshCw size={14} />立即同步</button>
          <button type="button" disabled={busy} onClick={disconnect} className="flex items-center gap-2 rounded border border-ide-panel-border px-3 py-2 hover:bg-white/5 disabled:opacity-50"><Unplug size={14} />断开连接</button>
        </div>
      </> : <form onSubmit={event => void connect(event)} className="flex flex-col gap-4">
        <label className="grid gap-1">GitHub Personal Access Token<input className={inputClass} type="password" required value={token} onChange={event => setToken(event.target.value)} placeholder="ghp_..." autoComplete="new-password" /></label>
        <label className="grid gap-1">仓库名称（可选）<input className={inputClass} value={repo} onChange={event => setRepo(event.target.value)} placeholder="默认创建 navhub-data 私有仓库" spellCheck={false} /></label>
        <p className="text-xs text-gray-400">Token 需要创建私有仓库和读写仓库内容的权限。凭据保存在 NexusDesk 本机设置中。</p>
        <div><button type="submit" disabled={busy || !token.trim()} className="flex items-center gap-2 rounded bg-ide-accent px-3 py-2 text-white disabled:opacity-50">{busy && <LoaderCircle size={14} className="animate-spin" />}连接 GitHub</button></div>
      </form>}
      {state.error && <p role="alert" className="break-all text-red-400">{state.error}</p>}
      {state.status === "connected" && <p className="text-xs text-gray-500">导航修改后会自动同步。连接时本地和云端网站会合并，重复网址保留本地版本。</p>}
    </div>
  </div>;
}
