import * as Dialog from "@radix-ui/react-dialog";
import { useId, useState, type FormEvent } from "react";
import { X } from "lucide-react";

interface InsertTableDialogProps {
  onClose: () => void;
  onInsert: (rows: number, cols: number) => void;
}

export function InsertTableDialog({ onClose, onInsert }: InsertTableDialogProps) {
  const id = useId();
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onInsert(rows, cols);
    onClose();
  };

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="search-overlay" />
        <Dialog.Content className="create-name-dialog" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
          <header className="flex items-center justify-between border-b border-ide-panel-border px-4 py-3">
            <Dialog.Title className="font-medium">插入表格</Dialog.Title>
            <Dialog.Close aria-label="取消" className="rounded p-1 hover:bg-white/10"><X size={16} /></Dialog.Close>
          </header>
          <form onSubmit={submit} className="flex flex-col gap-4 p-4">
            <div className="flex gap-4">
              <div className="flex-1 flex flex-col gap-2">
                <label htmlFor={`${id}-rows`} className="text-xs text-gray-300">行数</label>
                <input id={`${id}-rows`} type="number" min={1} max={100} value={rows} onChange={e => setRows(Number(e.target.value))} className="w-full rounded border border-ide-panel-border bg-ide-bg px-3 py-2 outline-none focus:border-ide-accent" />
              </div>
              <div className="flex-1 flex flex-col gap-2">
                <label htmlFor={`${id}-cols`} className="text-xs text-gray-300">列数</label>
                <input id={`${id}-cols`} type="number" min={1} max={100} value={cols} onChange={e => setCols(Number(e.target.value))} className="w-full rounded border border-ide-panel-border bg-ide-bg px-3 py-2 outline-none focus:border-ide-accent" />
              </div>
            </div>
            <footer className="mt-2 flex justify-end gap-2">
              <Dialog.Close className="rounded border border-ide-panel-border px-4 py-1.5 hover:bg-white/10">取消</Dialog.Close>
              <button type="submit" className="rounded bg-ide-accent px-4 py-1.5 text-white">确定</button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}