import * as Dialog from "@radix-ui/react-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ExternalLink, Puzzle, Settings, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const STORE_URL = "https://chromewebstore.google.com/?hl=zh-CN";
interface ExtensionInfo { id: string; name: string; enabled: boolean; removable: boolean; options_url: string | null; popup_url: string | null }

function isStoreDetail(value: string) {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "chromewebstore.google.com" && url.pathname.startsWith("/detail/"); }
  catch { return false; }
}

export function BrowserExtensions({ getLabel, currentUrl, onOpenStore, onInstalled }: { getLabel: () => string; currentUrl: string; onOpenStore: () => Promise<void>; onInstalled: () => Promise<void> }) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const latest = useRef({ getLabel, refresh: async () => {} });
  const refresh = async () => {
    setLoading(true);
    try { setExtensions(await invoke<ExtensionInfo[]>("browser_list_extensions", { label: getLabel() })); }
    catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  };
  latest.current = { getLabel, refresh };
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ label: string }>).detail;
      if (detail.label !== latest.current.getLabel()) return;
      setOpened(true); setError(""); setMessage("");
    };
    window.addEventListener("noteide-open-extensions", open);
    void getCurrentWindow().listen<{ label: string; source: string; state: string; message: string }>("browser-extension-install", event => {
      if (disposed || event.payload.label !== latest.current.getLabel()) return;
      const { state, message } = event.payload;
      setOpened(true); setBusy(state === "installing");
      setError(state === "failed" ? message : "");
      setMessage(state === "failed" ? "" : message);
      if (state === "completed") void latest.current.refresh();
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; unlisten?.(); window.removeEventListener("noteide-open-extensions", open); };
  }, []);
  useEffect(() => { if (opened) void refresh(); }, [opened]);
  if (!navigator.userAgent.includes("Windows")) return null;
  const install = async () => {
    setOpened(true); setBusy(true); setMessage(""); setError("");
    try {
      const id = await invoke<string>("browser_install_extension", { label: getLabel(), source: currentUrl });
      setMessage(`已安装扩展 ${id}，保存在当前项目中。请刷新需要使用扩展的网页。`);
      await refresh();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const openPage = async (extension: ExtensionInfo, page: "options" | "popup") => {
    setBusy(true); setError("");
    try {
      await invoke("browser_open_extension_page", { label: getLabel(), id: extension.id, page });
      setOpened(false);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const remove = async (extension: ExtensionInfo) => {
    setBusy(true); setMessage(""); setError("");
    try {
      await invoke("browser_remove_extension", { label: getLabel(), id: extension.id });
      setMessage(`已删除“${extension.name}”。请刷新已打开的网页。`);
      await refresh();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <Dialog.Root open={opened} onOpenChange={value => { if (!busy) { setOpened(value); setError(""); setMessage(""); } }}>
    <Dialog.Trigger asChild><button type="button" title="Chrome 扩展" aria-label="Chrome 扩展" className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white"><Puzzle size={15} /></button></Dialog.Trigger>
    {isStoreDetail(currentUrl) && <button type="button" disabled={busy} onClick={() => void install()} className="shrink-0 rounded bg-ide-accent px-2 py-1 text-xs text-white disabled:opacity-50">安装此扩展</button>}
    <Dialog.Portal>
      <Dialog.Overlay className="search-overlay" />
      <Dialog.Content className="create-name-dialog" style={{ width: "min(520px, 92vw)" }} onKeyDown={event => event.stopPropagation()} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
        <header className="flex items-center justify-between border-b border-ide-panel-border px-4 py-3">
          <Dialog.Title>Chrome 扩展管理</Dialog.Title>
          <Dialog.Close disabled={busy} aria-label="关闭扩展安装" className="rounded p-1 hover:bg-white/10"><X size={16} /></Dialog.Close>
        </header>
        <div className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto p-4 text-sm">
          <Dialog.Description className="text-gray-400">前往 Chrome 网上应用店选择扩展，点击“添加至 Chrome”即可安装。</Dialog.Description>
          <button type="button" disabled={busy} onClick={() => { void onOpenStore().then(() => setOpened(false)).catch(reason => setError(String(reason))); }} className="flex items-center justify-center gap-2 rounded border border-ide-panel-border px-3 py-2 hover:bg-white/10 disabled:opacity-50"><ExternalLink size={15} />前往 Chrome 网上应用店</button>
          <p className="text-xs text-gray-400">点击“设置”或“打开界面”可在新标签页中打开扩展页面。支持范围取决于 WebView2，部分 Chrome API 可能不可用。</p>
          {message && <button type="button" disabled={busy} onClick={() => { void onInstalled().then(() => setOpened(false)).catch(reason => setError(String(reason))); }} className="rounded border border-ide-panel-border px-3 py-2 hover:bg-white/10">刷新当前网页</button>}
          {message && <p role="status" className="break-all text-xs text-green-400">{message}</p>}
          {error && <p role="alert" className="break-all text-xs text-red-400">{error}</p>}
          <section className="border-t border-ide-panel-border pt-3" aria-label="已安装扩展">
            <div className="mb-3 flex items-center justify-between"><h3>已安装扩展</h3><button type="button" disabled={busy || loading} onClick={() => void refresh()} className="text-xs hover:text-white disabled:opacity-50">刷新列表</button></div>
            {loading ? <p role="status" className="text-xs text-gray-400">正在读取扩展…</p> : extensions.length === 0 ? <p className="text-xs text-gray-400">当前项目尚未安装扩展。</p> : <ul className="flex flex-col gap-2">
              {extensions.map(extension => <li key={extension.id} className="flex items-center gap-3 rounded border border-ide-panel-border p-3">
                <div className="min-w-0 flex-1"><p className="break-words text-white">{extension.name}</p><p className="break-all text-xs text-gray-400">{extension.id}</p><p className="text-xs text-gray-400">{extension.enabled ? "已启用" : "已停用"}</p></div>
                {(extension.options_url || extension.popup_url) ? <button type="button" disabled={busy || loading || !extension.enabled} onClick={() => void openPage(extension, extension.options_url ? "options" : "popup")} aria-label={`${extension.options_url ? "设置" : "打开界面"} ${extension.name}`} className="flex shrink-0 items-center gap-1 rounded px-2 py-1 hover:bg-white/10 disabled:opacity-50"><Settings size={14} />{extension.options_url ? "设置" : "打开界面"}</button> : extension.removable && <span className="shrink-0 text-xs text-gray-400">无配置页</span>}
                {extension.removable
                  ? <button type="button" disabled={busy || loading} onClick={() => void remove(extension)} aria-label={`删除 ${extension.name}`} className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-red-400 hover:bg-white/10 disabled:opacity-50"><Trash2 size={14} />删除</button>
                  : <span className="shrink-0 text-xs text-gray-400" title="WebView2 内置扩展，不支持删除">内置扩展</span>}
              </li>)}
            </ul>}
          </section>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export { STORE_URL as CHROME_EXTENSION_STORE_URL };
