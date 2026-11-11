import * as Dialog from "@radix-ui/react-dialog";
import { useId, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";

interface CreateNameDialogProps {
  initialName?: string;
  selectBasename?: boolean;
  title: string;
  description: string;
  label: string;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
  validate?: (name: string) => string | undefined;
}

export function CreateNameDialog({ title, description, label, onClose, onCreate, validate, initialName = "", selectBasename = false }: CreateNameDialogProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const submitting = useRef(false);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    const value = name.trim();
    const invalid = !value ? "请输入名称。" : validate?.(value);
    if (invalid) { setError(invalid); input.current?.focus(); return; }
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await onCreate(value);
      onClose();
    } catch (cause) {
      setError(`操作失败：${String(cause)}`);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !submitting.current) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="search-overlay" />
        <Dialog.Content className="create-name-dialog" onClick={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
          onOpenAutoFocus={event => {
            event.preventDefault();
            previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            input.current?.focus();
            const value = input.current?.value ?? "";
            const extensionStart = value.lastIndexOf(".");
            input.current?.setSelectionRange(0, selectBasename && extensionStart > 0 ? extensionStart : value.length);
          }}
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (previousFocus.current?.isConnected) previousFocus.current.focus();
          }}
          onEscapeKeyDown={event => { if (submitting.current) event.preventDefault(); }}>
          <header className="flex items-center justify-between border-b border-ide-panel-border px-4 py-3">
            <Dialog.Title className="font-medium">{title}</Dialog.Title>
            <Dialog.Close disabled={busy} aria-label="取消新建" className="rounded p-1 hover:bg-white/10 disabled:opacity-40"><X size={16} /></Dialog.Close>
          </header>
          <form onSubmit={event => void submit(event)} className="flex flex-col gap-3 p-4" aria-busy={busy}>
            <Dialog.Description className="break-all text-xs text-gray-400">{description}</Dialog.Description>
            <label htmlFor={id} className="text-xs">{label}</label>
            <input ref={input} id={id} value={name} disabled={busy} autoComplete="off" spellCheck={false}
              aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
              onChange={event => { setName(event.target.value); setError(""); }}
              onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}
              className="w-full rounded border border-ide-panel-border bg-ide-bg px-3 py-2 outline-none focus:border-ide-accent disabled:opacity-60" />
            {error && <p id={`${id}-error`} role="alert" className="break-words text-xs text-red-400">{error}</p>}
            <footer className="mt-2 flex justify-end gap-2">
              <Dialog.Close disabled={busy} className="rounded border border-ide-panel-border px-4 py-1.5 hover:bg-white/10 disabled:opacity-40">取消</Dialog.Close>
              <button type="submit" disabled={busy || !name.trim()} className="rounded bg-ide-accent px-4 py-1.5 text-white disabled:opacity-40">{busy ? "正在处理…" : "确定"}</button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function validateEntryName(name: string) {
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    return "名称不能包含路径分隔符、保留名称或非法字符，也不能以点结尾。";
  }
}
