import { create } from "zustand";

interface DialogRequest {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  resolve: (confirmed: boolean) => void;
}

export const useDialogStore = create<{ queue: DialogRequest[] }>(() => ({ queue: [] }));

export function confirmAction(description: string, options: { title: string; confirmLabel: string; cancelLabel: string }) {
  return new Promise<boolean>(resolve => {
    useDialogStore.setState(state => ({ queue: [...state.queue, { ...options, description, resolve }] }));
  });
}

export function showError(description: string) {
  useDialogStore.setState(state => ({ queue: [...state.queue, { title: "操作失败", description, resolve: () => {} }] }));
}
