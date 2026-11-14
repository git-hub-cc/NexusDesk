import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { confirmAction } from "@/lib/dialogs";
import { navigationFaviconUrl, type NavigationSite } from "./navigationData";
import { NavigationSiteIcon } from "./NavigationSiteIcon";

interface NavigationSiteDialogProps {
  site: NavigationSite;
  mode: "add" | "edit";
  focusDescription?: boolean;
  onSave: (site: NavigationSite) => void | Promise<void>;
  onRemove?: () => void | Promise<void>;
  onClose: () => void;
}

export function NavigationSiteDialog({ site, mode, focusDescription = false, onSave, onRemove, onClose }: NavigationSiteDialogProps) {
  const titleInput = useRef<HTMLInputElement>(null);
  const descriptionInput = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [icon, setIcon] = useState(site.icon);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const busy = saving || removing;
  const removeBookmark = async () => {
    if (!onRemove || busy || uploading) return;
    setRemoving(true);
    setError("");
    try {
      if (!await confirmAction(`移除书签“${site.title}”？`, { title: "移除书签", confirmLabel: "移除", cancelLabel: "取消" })) return;
      await onRemove();
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRemoving(false); }
  };
  const useWebsiteIcon = () => {
    try {
      const form = new FormData(formRef.current!);
      setIcon(navigationFaviconUrl(String(form.get("url") || "")));
      setError("");
    } catch { setError("请先填写有效的网站地址"); }
  };
  const uploadIcon = async (file: File) => {
    setError("");
    if (!file.type.startsWith("image/") && !/\.ico$/i.test(file.name)) {
      setError("请选择图片文件");
      return;
    }
    if (file.size > 512 * 1024) {
      setError("图标不能超过 512 KB，请选择较小的图片");
      return;
    }
    setUploading(true);
    try {
      const value = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;/, `data:${file.type.startsWith("image/") ? file.type : "image/x-icon"};`));
        reader.onerror = () => reject(new Error("读取图标失败，请重试"));
        reader.readAsDataURL(file);
      });
      setIcon(value);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setUploading(false); }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy || uploading) return;
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") || "").trim();
    const rawUrl = String(form.get("url") || "").trim();
    try {
      if (!title) throw new Error("请输入网站名称");
      const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error("请输入 HTTP 或 HTTPS 网站地址");
      const savedIcon = typeof icon === "string" ? icon.trim() || undefined : icon;
      if (typeof savedIcon === "string" && !/^data:image\//i.test(savedIcon)) {
        const iconUrl = new URL(savedIcon);
        if (!["http:", "https:"].includes(iconUrl.protocol)) throw new Error("请输入 HTTP、HTTPS 图标地址或上传图片");
      }
      setSaving(true);
      setError("");
      await onSave({ ...site, title, url: url.href, icon: savedIcon, desc: String(form.get("desc") || "").trim(), proxy: form.get("proxy") === "on" });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setSaving(false); }
  };

  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55" />
      <Dialog.Content onOpenAutoFocus={event => { event.preventDefault(); (focusDescription ? descriptionInput : titleInput).current?.focus(); }}
        className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-ide-panel-border bg-ide-bg p-5 text-sm text-gray-200 shadow-2xl">
        <header className="mb-5 flex items-center justify-between">
          <Dialog.Title className="text-base font-semibold">{mode === "add" ? "新增网站" : "编辑网站"}</Dialog.Title>
          <Dialog.Close disabled={busy} aria-label="关闭"><X size={18} /></Dialog.Close>
        </header>
        <Dialog.Description className="sr-only">填写网站名称、网址、图标和描述，保存到导航页。</Dialog.Description>
        <form ref={formRef} onSubmit={event => { void submit(event); }} className="space-y-3">
          <fieldset disabled={busy || uploading} className="space-y-3">
            <label className="block text-xs">名称<input ref={titleInput} name="title" required defaultValue={site.title} className="mt-1 block w-full rounded border border-ide-panel-border bg-ide-tab-bg px-3 py-2 text-sm" /></label>
            <label className="block text-xs">网址<input name="url" required defaultValue={site.url} className="mt-1 block w-full rounded border border-ide-panel-border bg-ide-tab-bg px-3 py-2 text-sm" /></label>
            <div className="space-y-2">
              <label className="block text-xs">图标地址<input name="icon" value={typeof icon === "string" && !icon.startsWith("data:") ? icon : ""}
                placeholder={typeof icon === "object" ? "已使用内置图标，可输入地址替换" : icon?.startsWith("data:") ? "已上传图片，可输入地址替换" : "https://example.com/favicon.ico"}
                onChange={event => setIcon(event.target.value)} className="mt-1 block w-full rounded border border-ide-panel-border bg-ide-tab-bg px-3 py-2 text-sm" /></label>
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-ide-panel-border" role="img" aria-label="图标预览"><NavigationSiteIcon icon={icon} /></span>
                <button type="button" onClick={useWebsiteIcon} className="rounded px-2 py-1 text-xs hover:bg-white/10">使用网站图标</button>
                <button type="button" disabled={!icon} onClick={() => setIcon(undefined)} className="rounded px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-50">清除图标</button>
              </div>
              <label className="block text-xs">上传图标<input type="file" accept="image/*,.ico" className="mt-1 block w-full text-xs"
                onChange={event => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void uploadIcon(file);
                }} /></label>
              <p className="text-xs text-gray-400">支持图片地址或上传不超过 512 KB 的图片，上传图片将随导航保存。</p>
            </div>
            <label className="block text-xs">描述<input ref={descriptionInput} name="desc" defaultValue={site.desc} className="mt-1 block w-full rounded border border-ide-panel-border bg-ide-tab-bg px-3 py-2 text-sm" /></label>
            <label className="flex items-center gap-2 text-xs"><input name="proxy" type="checkbox" defaultChecked={site.proxy} />需要代理</label>
          </fieldset>
          {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
          <footer className="flex justify-end gap-2 pt-2">
            {mode === "edit" && onRemove && <button type="button" disabled={busy || uploading}
              className="mr-auto rounded px-3 py-2 text-xs text-red-400 hover:bg-red-400/10 disabled:opacity-50"
              onClick={() => { void removeBookmark(); }}>{removing ? "正在移除…" : "移除书签"}</button>}
            <button type="button" disabled={busy} className="rounded px-3 py-2 text-xs hover:bg-white/10" onClick={onClose}>取消</button>
            <button disabled={busy || uploading} className="rounded bg-ide-accent px-3 py-2 text-xs text-white disabled:opacity-50">{uploading ? "正在读取图标…" : saving ? "正在保存…" : "保存"}</button>
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
