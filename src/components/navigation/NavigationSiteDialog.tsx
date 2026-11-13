import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import type { NavigationSite } from "./navigationData";

interface NavigationSiteDialogProps {
  site: NavigationSite;
  mode: "add" | "edit";
  focusDescription?: boolean;
  onSave: (site: NavigationSite) => void | Promise<void>;
  onClose: () => void;
}

export function NavigationSiteDialog({ site, mode, focusDescription = false, onSave, onClose }: NavigationSiteDialogProps) {
  const titleInput = useRef<HTMLInputElement>(null);
  const descriptionInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (saving) return;
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") || "").trim();
    const rawUrl = String(form.get("url") || "").trim();
    try {
      if (!title) throw new Error("请输入网站名称");
      const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error("请输入 HTTP 或 HTTPS 网站地址");
      setSaving(true);
      setError("");
      await onSave({ ...site, title, url: url.href, desc: String(form.get("desc") || "").trim(), proxy: form.get("proxy") === "on" });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setSaving(false); }
  };

  return <Dialog.Root open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55" />
      <Dialog.Content onOpenAutoFocus={event => { event.preventDefault(); (focusDescription ? descriptionInput : titleInput).current?.focus(); }}
        className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-ide-panel-border bg-ide-bg p-5 text-sm text-gray-200 shadow-2xl">
        <header className="mb-5 flex items-center justify-between">
          <Dialog.Title className="text-base font-semibold">{mode === "add" ? "新增网站" : "编辑网站"}</Dialog.Title>
          <Dialog.Close disabled={saving} aria-label="关闭"><X size={18} /></Dialog.Close>
        </header>
        <Dialog.Description className="sr-only">填写网站名称、网址和描述，保存到导航页。</Dialog.Description>
        <form onSubmit={event => { void submit(event); }} className="space-y-3">
          <fieldset disabled={saving} className="space-y-3">
            <label className="block text-xs">名称<input ref={titleInput} name="title" required defaultValue={site.title} className="mt-1 block w-full rounded border border-ide-panel-border bg-ide-tab-bg px-3 py-2 text-sm" /></label>
            <label className="block text-xs">网址<input name="url" required defaultValue={site.url} className="mt-1 block w-full rounded border border-ide-panel-border bg-ide-tab-bg px-3 py-2 text-sm" /></label>
            <label className="block text-xs">描述<input ref={descriptionInput} name="desc" defaultValue={site.desc} className="mt-1 block w-full rounded border border-ide-panel-border bg-ide-tab-bg px-3 py-2 text-sm" /></label>
            <label className="flex items-center gap-2 text-xs"><input name="proxy" type="checkbox" defaultChecked={site.proxy} />需要代理</label>
          </fieldset>
          {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
          <footer className="flex justify-end gap-2 pt-2">
            <button type="button" disabled={saving} className="rounded px-3 py-2 text-xs hover:bg-white/10" onClick={onClose}>取消</button>
            <button disabled={saving} className="rounded bg-ide-accent px-3 py-2 text-xs text-white disabled:opacity-50">{saving ? "正在保存…" : "保存"}</button>
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
