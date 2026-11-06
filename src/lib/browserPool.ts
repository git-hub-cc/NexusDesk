import { getCurrentWindow } from "@tauri-apps/api/window";

export function reserveBrowser(_url?: string): { label: string; warm: boolean; loaded?: boolean } {
  return {
    label: `${getCurrentWindow().label}-browser-${crypto.randomUUID()}`,
    warm: false,
  };
}
