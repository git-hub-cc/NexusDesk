import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { fsApi } from "@/lib/api";
import { getProjectSaveLocation, rememberProjectSaveLocation } from "@/lib/projectLocation";
import { validateEntryName } from "@/components/explorer/CreateNameDialog";

interface CreateProjectDialogProps {
  onCreate: (path: string) => Promise<void>;
  onClose: () => void;
}

export function CreateProjectDialog({ onCreate, onClose }: CreateProjectDialogProps) {
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void getProjectSaveLocation().then(setLocation).catch(() => {}); }, []);
  const parent = location.trim();
  const projectName = name.trim();
  const separator = parent.includes("\\") ? "\\" : "/";
  const projectPath = parent && projectName
    ? `${parent}${/[/\\]$/.test(parent) ? "" : separator}${projectName}` : "";

  const browse = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      const selected = await fsApi.openFolderDialog(location);
      if (selected) { setLocation(selected); rememberProjectSaveLocation(selected); }
    } catch (cause) {
      setError(`选择目录失败：${String(cause)}`);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (working.current) return;
    const invalid = !projectName ? "请输入项目名称。" : validateEntryName(projectName);
    if (invalid) { setError(invalid); nameInput.current?.focus(); return; }
    if (!parent) { setError("请选择或输入保存位置。"); return; }
    if (!/^(?:[a-z]:[/\\]|\/|\\\\[^\\]+\\[^\\]+)/i.test(parent)) {
      setError("保存位置必须是完整的目录路径。");
      return;
    }
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await onCreate(projectPath);
      onClose();
    } catch (cause) {
      setError(`创建失败：${String(cause)}`);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !working.current) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="search-overlay" />
        <Dialog.Content className="create-name-dialog" onClick={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
          onOpenAutoFocus={event => { event.preventDefault(); nameInput.current?.focus(); }}
          onEscapeKeyDown={event => { if (working.current) event.preventDefault(); }}>
          <header className="flex items-center justify-between border-b border-ide-panel-border px-4 py-3">
            <Dialog.Title className="font-medium">新建项目</Dialog.Title>
            <Dialog.Close disabled={busy} aria-label="取消新建项目" className="rounded p-1 hover:bg-white/10 disabled:opacity-40"><X size={16} /></Dialog.Close>
          </header>
          <form onSubmit={event => void submit(event)} className="flex flex-col gap-3 p-4" aria-busy={busy}>
            <Dialog.Description className="text-xs text-gray-400">填写项目名称和保存位置，将自动创建项目文件夹。</Dialog.Description>
            <label htmlFor={`${id}-name`} className="text-xs">项目名称</label>
            <input ref={nameInput} id={`${id}-name`} value={name} disabled={busy} autoComplete="off" spellCheck={false}
              onChange={event => { setName(event.target.value); setError(""); }}
              onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}
              className="w-full rounded border border-ide-panel-border bg-ide-bg px-3 py-2 outline-none focus:border-ide-accent disabled:opacity-60" />
            <label htmlFor={`${id}-location`} className="text-xs">保存位置</label>
            <div className="flex gap-2">
              <input id={`${id}-location`} value={location} disabled={busy} autoComplete="off" spellCheck={false}
                placeholder="选择或输入父目录路径"
              onChange={event => { setLocation(event.target.value); rememberProjectSaveLocation(event.target.value); setError(""); }}
                onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}
                className="min-w-0 flex-1 rounded border border-ide-panel-border bg-ide-bg px-3 py-2 outline-none focus:border-ide-accent disabled:opacity-60" />
              <button type="button" disabled={busy} onClick={() => void browse()} className="shrink-0 rounded border border-ide-panel-border px-3 py-2 hover:bg-white/10 disabled:opacity-40">浏览…</button>
            </div>
            {projectPath && <p className="break-all text-xs text-gray-400">项目路径：{projectPath}</p>}
            {error && <p role="alert" className="break-words text-xs text-red-400">{error}</p>}
            <footer className="mt-2 flex justify-end gap-2">
              <Dialog.Close disabled={busy} className="rounded border border-ide-panel-border px-4 py-1.5 hover:bg-white/10 disabled:opacity-40">取消</Dialog.Close>
              <button type="submit" disabled={busy || !projectPath} className="rounded bg-ide-accent px-4 py-1.5 text-white disabled:opacity-40">{busy ? "正在处理…" : "创建"}</button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
