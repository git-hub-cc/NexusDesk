import { getCurrentWindow } from "@tauri-apps/api/window";

export function warmBrowserPool() {}

export function reserveBrowser(_url?: string): { label: string; warm: boolean; loaded?: boolean } {
  return {
    label: `${getCurrentWindow().label}-browser-${crypto.randomUUID()}`,
    warm: false,
  };
}

export function cancelBrowserSpeculation() {}

export function speculateBrowser(_value: string) {}

export function takeSpeculativeBrowser(_url?: string): { label: string; warm: true; loaded: true } | undefined {
  return undefined;
}
