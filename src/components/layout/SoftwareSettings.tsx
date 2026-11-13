import { Check, Download, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { softwareApi, type ManagedSoftware } from "@/lib/api";

export function SoftwareSettings() {
  const [software, setSoftware] = useState<ManagedSoftware[]>([]);
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const items = await softwareApi.list();
      setSoftware(items);
      const results = await Promise.all(items.map(async item => {
        try {
          return { id: item.id, name: item.name, installed: await softwareApi.status(item.id) };
        } catch (reason) {
          return { id: item.id, name: item.name, error: String(reason) };
        }
      }));
      const status: Record<string, boolean> = {};
      for (const result of results) {
        if (typeof result.installed === "boolean") status[result.id] = result.installed;
      }
      setInstalled(status);
      const failures = results.filter(result => "error" in result);
      if (failures.length) {
        setError(failures.map(result => `${result.name} 状态查询失败：${"error" in result ? result.error : ""}`).join("；"));
      }
    } catch (reason) {
      setError(String(reason));
      throw reason;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh().catch(() => {}); }, [refresh]);

  const run = async (item: ManagedSoftware, action: "install" | "uninstall") => {
    setBusy(item.id);
    setError("");
    setMessage("");
    try {
      if (action === "install") await softwareApi.install(item.id);
      else await softwareApi.uninstall(item.id);
      await refresh();
      setMessage(`${item.name}${action === "install" ? "安装" : "卸载"}完成。`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  return <section className="space-y-4 p-5 text-sm">
    <div className="flex items-center justify-between gap-3">
      <h2 className="font-medium">外部软件</h2>
      <button type="button" aria-label="刷新软件状态" title="刷新软件状态" disabled={busy !== null || loading} onClick={() => void refresh().catch(() => {})} className="flex h-8 w-8 items-center justify-center rounded border border-ide-panel-border text-gray-400 hover:bg-white/5 hover:text-ide-fg disabled:opacity-50"><RefreshCw size={15} /></button>
    </div>
    <p className="text-xs text-gray-400">通过 winget 管理外部软件。</p>
    <div className="divide-y divide-ide-panel-border border-y border-ide-panel-border">
      {software.map(item => <div key={item.id} className="flex min-w-0 items-center gap-3 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{item.name}</span>
            {installed[item.id] && <span className="inline-flex items-center gap-1 text-xs text-green-400"><Check size={13} />已安装</span>}
          </div>
          <code className="break-all text-xs text-gray-500">{item.id}</code>
        </div>
        <button type="button" disabled={busy !== null || loading || installed[item.id] === undefined} onClick={() => void run(item, installed[item.id] ? "uninstall" : "install")} title={loading ? "正在读取软件状态" : installed[item.id] === undefined ? "软件状态未知，请刷新重试" : installed[item.id] ? "卸载" : "安装"} aria-label={loading ? `正在读取 ${item.name} 的状态` : installed[item.id] === undefined ? `${item.name} 状态未知` : `${installed[item.id] ? "卸载" : "安装"} ${item.name}`} className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-ide-panel-border text-gray-300 hover:bg-white/5 disabled:opacity-40">
          {loading || busy === item.id ? <LoaderCircle size={15} className="animate-spin" /> : installed[item.id] ? <Trash2 size={15} /> : <Download size={15} />}
        </button>
      </div>)}
      {loading && <div role="status" className="flex items-center justify-center gap-2 py-5 text-xs text-gray-500"><LoaderCircle size={14} className="animate-spin" />正在读取 winget 软件状态…</div>}
      {!loading && !software.length && !error && <div className="py-5 text-center text-xs text-gray-500">暂无可管理的软件</div>}
    </div>
    {message && <p role="status" className="text-xs text-green-400">{message}</p>}
    {error && <p role="alert" className="break-words text-xs text-red-400">{error}</p>}
  </section>;
}
