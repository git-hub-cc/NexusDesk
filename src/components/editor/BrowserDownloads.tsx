import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Download, FolderOpen, X } from "lucide-react";

interface BrowserDownload {
  id: string; label: string; name: string; path: string;
  received: number; total: number | null; speed: number; connections: number;
  state: "downloading" | "completed" | "failed" | "cancelled";
  message: string; revision: number;
}

const DIRECTORY_REVEAL_WINDOW_MS = 5 * 60 * 1000;

export function downloadSize(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, bytes).toFixed(0)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function mergeDownload(items: BrowserDownload[], next: BrowserDownload): BrowserDownload[] {
  const previous = items.find(item => item.id === next.id);
  if (previous && previous.revision >= next.revision) return items;
  return previous ? items.map(item => item.id === next.id ? next : item) : [next, ...items];
}

export function isFailedExtensionDownload(item: BrowserDownload): boolean {
  return item.state === "failed" && [item.name, item.path].some(value => /\.crx(?:$|[?#])/i.test(value));
}

export function BrowserDownloads({ labels }: { labels: string[] }) {
  const [items, setItems] = useState<BrowserDownload[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [error, setError] = useState("");
  const dismissTimers = useRef(new Map<string, number>());
  const observedStates = useRef(new Map<string, BrowserDownload["state"]>());
  const revealedDownloads = useRef(new Set<string>());
  const lastDirectoryRevealAt = useRef(0);
  const [cancelling, setCancelling] = useState<string[]>([]);
  const handleDownload = (next: BrowserDownload) => {
    const previousState = observedStates.current.get(next.id);
    observedStates.current.set(next.id, next.state);
    const now = Date.now();
    if (next.state === "completed" && previousState === "downloading" && next.path &&
      !revealedDownloads.current.has(next.id) && now - lastDirectoryRevealAt.current >= DIRECTORY_REVEAL_WINDOW_MS) {
      revealedDownloads.current.add(next.id);
      lastDirectoryRevealAt.current = now;
      void revealItemInDir(next.path).catch(reason => setError(String(reason)));
    }
  };
  const close = async (item: BrowserDownload) => {
    if (cancelling.includes(item.id)) return;
    setCancelling(ids => [...ids, item.id]);
    try {
      if (item.state === "downloading") await invoke("browser_cancel_download", { id: item.id });
      setDismissed(ids => [...ids, item.id]);
    } catch (reason) { setError(`无法取消下载：${String(reason)}`); }
    finally { setCancelling(ids => ids.filter(id => id !== item.id)); }
  };
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let polling = false;
    const synchronize = async () => {
      if (disposed || polling) return;
      polling = true;
      try {
        const snapshot = await invoke<BrowserDownload[]>("browser_downloads");
        if (!disposed) {
          snapshot.forEach(handleDownload);
          setItems(items => snapshot.reduce(mergeDownload, items));
        }
      } finally { polling = false; }
    };
    // A terminal event can arrive while this tab is mounting or moving panes.
    // Reconcile with the backend even if the entire transfer fit between events.
    const poll = window.setInterval(() => { void synchronize().catch(() => {}); }, 500);
    void (async () => {
      unlisten = await getCurrentWindow().listen<BrowserDownload>("browser-download", event => {
        if (!disposed) {
          handleDownload(event.payload);
          setItems(items => mergeDownload(items, event.payload));
        }
      });
      if (disposed) { unlisten(); return; }
      await synchronize();
    })().catch(reason => { if (!disposed) setError(`无法读取下载进度：${String(reason)}`); });
    return () => { disposed = true; window.clearInterval(poll); unlisten?.(); };
  }, []);
  useEffect(() => {
    for (const item of items) {
      if ((item.state === "completed" || item.state === "cancelled") && !dismissed.includes(item.id) && !dismissTimers.current.has(item.id)) {
        dismissTimers.current.set(item.id, window.setTimeout(() => {
          dismissTimers.current.delete(item.id);
          setDismissed(ids => ids.includes(item.id) ? ids : [...ids, item.id]);
        }, 1500));
      }
    }
  }, [items, dismissed]);
  useEffect(() => () => { dismissTimers.current.forEach(timer => window.clearTimeout(timer)); dismissTimers.current.clear(); }, []);
  const visible = items.filter(item => labels.includes(item.label) && !dismissed.includes(item.id));
  if (!visible.length && !error) return null;
  return <section aria-label="文件下载" className="max-h-48 shrink-0 overflow-y-auto border-b border-ide-panel-border bg-ide-tab-bg px-3 py-2 text-xs text-gray-300">
    {error && <div role="status" className="mb-1 text-red-400">{error}</div>}
    {visible.map(item => {
      const downloading = item.state === "downloading";
      const extensionFailed = isFailedExtensionDownload(item);
      const percent = item.total ? Math.min(100, Math.floor(item.received / item.total * 100)) : undefined;
      const remaining = item.total && item.speed > 0 ? Math.max(0, Math.ceil((item.total - item.received) / item.speed)) : undefined;
      return <div key={item.id} className="py-1.5">
        <div className="flex items-center gap-2">
          <Download size={14} className="shrink-0 text-ide-accent" />
          <span className="min-w-0 flex-1 truncate" title={item.path}>{item.name}</span>
          <span role="status" className={item.state === "failed" ? "text-red-400" : "text-gray-400"}>{extensionFailed ? "扩展下载未完成，请使用 NoteIDE 扩展面板安装" : item.message}{downloading && item.connections > 1 ? ` · ${item.connections} 路并发` : ""}</span>
          {item.state === "completed" && <button type="button" title="打开所在文件夹" aria-label={`显示 ${item.name} 所在文件夹`} className="rounded p-1 hover:bg-white/10" onClick={() => { void revealItemInDir(item.path).catch(reason => setError(String(reason))); }}><FolderOpen size={14} /></button>}
          <button type="button" disabled={cancelling.includes(item.id)} title={downloading ? "取消下载并关闭" : "关闭下载提示"} aria-label={`${downloading ? "取消下载并关闭" : "关闭下载提示"} ${item.name}`} className="rounded p-1 hover:bg-white/10 disabled:opacity-50" onClick={() => { void close(item); }}><X size={14} /></button>
        </div>
        <div role="progressbar" aria-label={`${item.name} 下载进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.state === "completed" ? 100 : percent} aria-valuetext={item.state === "completed" ? "下载完成" : percent === undefined ? `已下载 ${downloadSize(item.received)}` : `${percent}%`}
          className="my-1.5 h-1 overflow-hidden rounded bg-white/10">
          <div className={`h-full rounded ${item.state === "failed" ? "bg-red-400" : "bg-ide-accent"} ${downloading && percent === undefined ? "animate-pulse" : ""}`} style={{ width: `${item.state === "completed" ? 100 : percent ?? 25}%` }} />
        </div>
        <div className="flex flex-wrap gap-x-3 text-[11px] text-gray-500">
          {extensionFailed && <button type="button" className="text-ide-accent hover:underline" onClick={() => window.dispatchEvent(new CustomEvent("noteide-open-extensions", { detail: { label: item.label } }))}>使用 NoteIDE 扩展面板安装</button>}
          <span>{downloadSize(item.received)}{item.total ? ` / ${downloadSize(item.total)}` : " · 大小未知"}</span>
          {downloading && <><span>{percent === undefined ? "正在接收文件…" : `${percent}%`}</span><span>{downloadSize(item.speed)}/s</span>{remaining !== undefined && <span>剩余约 {remaining < 60 ? `${remaining} 秒` : `${Math.ceil(remaining / 60)} 分钟`}</span>}</>}
          {item.state === "completed" && <span className="truncate" title={item.path}>已保存至 {item.path}</span>}
        </div>
      </div>;
    })}
  </section>;
}
