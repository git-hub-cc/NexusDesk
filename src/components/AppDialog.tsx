import * as Dialog from "@radix-ui/react-dialog";
import { DialogShell } from "@/components/DialogShell";
import { AlertTriangle, X } from "lucide-react";
import { useDialogStore } from "@/utils/dialogs";

export function AppDialog() {
  const request = useDialogStore(state => state.queue[0]);
  if (!request) return null;
  const finish = (confirmed: boolean) => {
    useDialogStore.setState(state => ({ queue: state.queue.slice(1) }));
    request.resolve(confirmed);
  };
  return <Dialog.Root open onOpenChange={open => { if (!open) finish(false); }}>
    <DialogShell purpose="confirmation" onKeyDown={event => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        finish(true);
      }
    }}>
      <header className="flex items-center justify-between border-b border-ide-panel-border px-4 py-3">
        <Dialog.Title className="flex items-center gap-2 font-medium"><AlertTriangle size={18} className="text-amber-400" />{request.title}</Dialog.Title>
        <Dialog.Close aria-label="关闭提示" className="rounded p-1 hover:bg-white/10"><X size={16} /></Dialog.Close>
      </header>
      <Dialog.Description className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-4 text-gray-300">{request.description}</Dialog.Description>
      <footer className="flex justify-end gap-2 border-t border-ide-panel-border px-4 py-3">
        {request.cancelLabel && <button className="ide-button ide-button-secondary rounded px-4 py-1.5" onClick={() => finish(false)}>{request.cancelLabel}</button>}
        <button className={request.cancelLabel ? "delete-confirm-action" : "rounded ide-button ide-button-primary px-4 py-1.5"} onClick={() => finish(true)}>{request.confirmLabel ?? "知道了"}</button>
      </footer>
    </DialogShell>
  </Dialog.Root>;
}
