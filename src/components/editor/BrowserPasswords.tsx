import * as Dialog from "@radix-ui/react-dialog";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { KeyRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { confirmAction } from "@/lib/dialogs";

type PasswordStats = { sites: number; passwords: number; updated_at: string | null };

export function BrowserPasswords({ onImported }: { onImported?: () => Promise<void> }) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [stats, setStats] = useState<PasswordStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);
  useEffect(() => {
    if (!opened) return;
    let disposed = false;
    setStatsLoading(true);
    void invoke<PasswordStats>("browser_password_stats")
      .then(value => { if (!disposed) setStats(value); })
      .catch(reason => { if (!disposed) setError(String(reason)); })
      .finally(() => { if (!disposed) setStatsLoading(false); });
    return () => { disposed = true; };
  }, [opened]);
  const run = async (kind: "import" | "export") => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setBusy(true); setMessage(""); setError("");
    try {
      const filters = [{ name: "Chrome 密码 CSV", extensions: ["csv"] }];
      if (kind === "import") {
        const file = await open({ title: "导入密码", multiple: false, directory: false, filters });
        if (!file || typeof file !== "string") return;
        const result = await invoke<{ imported: number; updated: number; skipped: number }>("browser_import_passwords", { file });
        setMessage(`已导入 ${result.imported} 条，更新 ${result.updated} 条，跳过 ${result.skipped} 条。`);
        await onImported?.();
        await new Promise<void>(resolve => {
          closeTimer.current = setTimeout(() => {
            closeTimer.current = null;
            resolve();
          }, 1800);
        });
        setOpened(false);
        setMessage("");
      } else {
        if (!await confirmAction("导出的 CSV 文件包含明文账号和密码，任何能读取该文件的人都能查看。是否继续？", { title: "导出密码", confirmLabel: "继续导出", cancelLabel: "取消" })) return;
        const file = await save({ title: "导出密码", defaultPath: "NexusDesk Passwords.csv", filters });
        if (!file) return;
        const count = await invoke<number>("browser_export_passwords", { file });
        setMessage(`已导出 ${count} 条密码。`);
      }
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <Dialog.Root open={opened} onOpenChange={value => { if (!busy) { setOpened(value); setMessage(""); setError(""); } }}>
    <Dialog.Trigger asChild><button type="button" title="密码管理" aria-label="密码管理" className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white"><KeyRound size={15} /></button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="search-overlay" />
      <Dialog.Content className="create-name-dialog" style={{ width: "min(480px, 92vw)" }} onKeyDown={event => event.stopPropagation()} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
        <header className="flex items-center justify-between border-b border-ide-panel-border px-4 py-3">
          <Dialog.Title>密码管理</Dialog.Title>
          <Dialog.Close disabled={busy} aria-label="关闭密码管理" className="rounded p-1 hover:bg-white/10"><X size={16} /></Dialog.Close>
        </header>
        <div className="flex flex-col gap-4 p-4 text-sm">
          <Dialog.Description className="text-gray-400">导入 Chrome 密码管理工具导出的 CSV 文件，或将已保存的密码导出为兼容 Chrome 的 CSV。</Dialog.Description>
          <div className="grid grid-cols-3 gap-2 rounded border border-ide-panel-border bg-black/10 p-3 text-center">
            <div><strong className="block text-base text-gray-100">{statsLoading ? "…" : stats?.sites ?? 0}</strong><span className="text-xs text-gray-400">保存的网站</span></div>
            <div><strong className="block text-base text-gray-100">{statsLoading ? "…" : stats?.passwords ?? 0}</strong><span className="text-xs text-gray-400">保存的密码</span></div>
            <div><strong className="block text-xs leading-4 text-gray-100">{statsLoading ? "…" : stats?.updated_at ? <><span className="block">{new Date(stats.updated_at).toLocaleDateString()}</span><span className="block">{new Date(stats.updated_at).toLocaleTimeString()}</span></> : "暂无"}</strong><span className="text-xs text-gray-400">最新更新</span></div>
          </div>
          <p className="text-xs text-gray-400">按完整域名匹配登录信息，忽略路径和查询参数，支持先填账号再填密码；同一网站有多个账号时可选择账号。检测到登录表单消失后，会更新已有账号的密码和登录地址。密码在 Windows 本机加密保存。</p>
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => void run("import")} className="rounded bg-ide-accent px-3 py-2 text-white disabled:opacity-50">导入密码</button>
            <button disabled={busy} onClick={() => void run("export")} className="rounded border border-ide-panel-border px-3 py-2 hover:bg-white/10 disabled:opacity-50">导出密码</button>
          </div>
          {busy && <p role="status" className="text-xs text-gray-400">正在处理…</p>}
          {message && <p role="status" className="text-xs text-green-400">{message}</p>}
          {error && <p role="alert" className="break-all text-xs text-red-400">{error}</p>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
