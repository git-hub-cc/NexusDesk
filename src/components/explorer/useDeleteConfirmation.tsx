import * as Dialog from "@radix-ui/react-dialog";
import { DialogShell } from "@/components/DialogShell";
import { displayPath } from "@/utils/paths";
import { AlertTriangle, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Request = { title: string; description: string; paths: string[]; permanent?: boolean; confirmLabel?: string; notice?: boolean };

export function useDeleteConfirmation(project: string | null) {
  const [request, setRequest] = useState<Request | null>(null);
  const resolve = useRef<((confirmed: boolean) => void) | null>(null);
  useEffect(() => {
    setRequest(null);
    return () => { resolve.current?.(false); resolve.current = null; };
  }, [project]);

  // 删除确认不依赖弹窗容器焦点，避免全局焦点策略移除焦点后回车失效。
  useEffect(() => {
    if (!request) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      // 让输入框和按钮保留自己的 Enter 行为，避免误确认删除。
      if (target?.closest("input, textarea, select, button, a, [role=button], [contenteditable]")) return;
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [request]);

  const finish = (confirmed: boolean) => {
    resolve.current?.(confirmed);
    resolve.current = null;
    setRequest(null);
  };
  const confirmDelete = (next: Request) => new Promise<boolean>(done => {
    resolve.current?.(false);
    resolve.current = done;
    setRequest(next);
  });
  const showDeletionBlocked = (description: string) => {
    void confirmDelete({ title: "目录被占用，无法删除", description, paths: [], notice: true });
  };

  const confirmationDialog = request && (
    <Dialog.Root open onOpenChange={open => { if (!open) finish(false); }}>
      <DialogShell purpose="confirmation" className="outline-none"
        onKeyDown={event => {
          if (event.key === "Tab") event.preventDefault();
        }}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}>
        <header className="flex items-center gap-3 px-5 pt-5">
          <span className="delete-confirm-icon">{request.notice ? <AlertTriangle size={20} className="text-amber-400" /> : <Trash2 size={20} />}</span>
          <Dialog.Title className="flex-1 font-medium text-base">{request.title}</Dialog.Title>
          <Dialog.Close aria-label={request.notice ? "关闭提示" : "取消删除"} className="rounded p-1 text-gray-400 hover:bg-white/10"><X size={16} /></Dialog.Close>
        </header>
        <div className="px-5 py-4">
          <Dialog.Description className="whitespace-pre-wrap break-words text-xs leading-6 text-gray-400">{request.description}</Dialog.Description>
          {request.paths.length > 0 && <ul aria-label="待删除项目" className="delete-confirm-list">
            {request.paths.map(path => <li key={path} className="px-3 py-2" title={displayPath(path)}>
              <p className="truncate text-sm">{path.split(/[/\\]/).pop() || path}</p>
              {/[\\/]/.test(path) && <p className="mt-1 break-all text-xs text-gray-500">{displayPath(path)}</p>}
            </li>)}
          </ul>}
          {request.permanent && <p className="mt-3 text-xs text-red-300">文件和文件夹内容将被永久删除，此操作无法撤销。</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-ide-panel-border px-5 py-3">
          <Dialog.Close className={request.notice ? "delete-confirm-action" : "rounded border border-ide-panel-border px-4 py-1.5 hover:bg-white/10"}>{request.notice ? "知道了" : "取消"}</Dialog.Close>
          {!request.notice && <button type="button" className="delete-confirm-action" onClick={() => finish(true)}>{request.confirmLabel ?? (request.permanent ? "永久删除" : "删除分类")}</button>}
        </footer>
      </DialogShell>
    </Dialog.Root>
  );
  return { confirmDelete, showDeletionBlocked, confirmationDialog };
}
