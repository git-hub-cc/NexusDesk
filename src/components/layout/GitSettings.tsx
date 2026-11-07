import { useEffect, useRef, useState } from "react";
import { gitApi } from "@/lib/api";
import { useWorkspaceStore } from "@/store/workspaceStore";

export function GitSettings() {
  const root = useWorkspaceStore(state => state.rootPath);
  const [remote, setRemote] = useState("");
  const [proxy, setProxy] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);
  const inputClass = "w-full min-w-0 rounded border border-ide-panel-border bg-ide-bg px-2 py-1.5 outline-none focus:border-ide-accent";

  useEffect(() => {
    loaded.current = false;
    if (root) void gitApi.settings(root).then(value => {
      setRemote(value.remote); setProxy(value.proxy); setToken(value.token); loaded.current = true;
    }).catch(reason => setError(String(reason)));
  }, [root]);

  useEffect(() => {
    if (!root || !loaded.current) return;
    const timer = window.setTimeout(async () => {
      setBusy(true); setError("");
      try {
        await gitApi.saveSettings(root, { remote, proxy, token });
        window.dispatchEvent(new Event("git-settings-changed"));
      } catch (reason) { setError(String(reason)); }
      finally { setBusy(false); }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [root, remote, proxy, token]);

  return <div className="mx-auto w-full max-w-3xl p-8" onKeyDown={event => event.stopPropagation()}>
        <header className="mb-6 border-b border-ide-panel-border pb-4">
          <h2 className="text-xl font-semibold">版本控制</h2>
          <p className="mt-1 text-sm text-gray-400">配置当前项目的 Git 远程地址、代理和访问凭据。</p>
        </header>
        <div className="flex flex-col gap-4 text-sm">
          {!root && <p className="text-amber-400">请先打开一个项目。</p>}
          <label className="grid gap-1">当前项目远程地址<input className={inputClass} value={remote} onChange={event => setRemote(event.target.value)} placeholder="https://... 或 git@..." spellCheck={false} /></label>
          <label className="grid gap-1">Git 代理<input className={inputClass} value={proxy} onChange={event => setProxy(event.target.value)} placeholder="http://127.0.0.1:7890（留空关闭）" spellCheck={false} /></label>
          <label className="grid gap-1">访问 Token<input className={inputClass} type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="留空保留已保存 Token" autoComplete="new-password" /></label>
          <p className="text-xs text-gray-400">远程地址和代理保存在项目 Git 配置；Token 保存在本机应用配置，不会写入远程地址。</p>
          {error && <p role="alert" className="text-red-400 break-all">{error}</p>}
          {root && <p className="text-xs text-gray-400" role="status">{busy ? "正在保存…" : "修改会自动保存并生效"}</p>}
        </div>
      </div>;
}
