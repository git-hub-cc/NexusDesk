import { invoke, isTauri } from "@tauri-apps/api/core";
import { createJSONStorage } from "zustand/middleware";
import globalSettingKeys from "./globalSettingKeys.json";

const cache: Record<string, string> = {};
type Write = { key: string; previous: string | null; value: string; failures?: number; retryAt?: number };
const pending: Write[] = [];
let running: Promise<void> | null = null;
let refreshing = false;
const rejected = new Set<string>();

export function isGlobalSetting(key: string): boolean {
  return globalSettingKeys.keys.includes(key) || globalSettingKeys.prefixes.some(prefix => key.startsWith(prefix));
}

function changed() { window.dispatchEvent(new Event("global-settings-changed")); }

export const settingsStorage = {
  getItem(key: string): string | null {
    return isTauri() ? cache[key] ?? null : localStorage.getItem(key);
  },
  setItem(key: string, value: string): void {
    if (!isTauri()) { localStorage.setItem(key, value); return; }
    if (!isGlobalSetting(key)) {
      throw new Error(`Unknown global setting: ${key}`);
    }
    if (rejected.has(key)) return; // Already reported; retry after upgrading/restarting the backend.
    const previous = cache[key] ?? null;
    if (previous === value) return;
    cache[key] = value;
    pending.push({ key, previous, value });
    void flushGlobalSettings(true).catch(error => console.error("Cannot save global settings:", error));
  },
  removeItem(): void {
    // Stores remove individual history/profile entries through setItem, allowing
    // the backend to merge deletions with concurrent changes from other windows.
    throw new Error("Remove individual settings entries instead of clearing the global store");
  },
};

export const globalJsonStorage = createJSONStorage(() => settingsStorage);

export function flushGlobalSettings(onlyDue = false): Promise<void> {
  if (running) return running;
  running = (async () => {
    const blocked = new Set<string>();
    let failure: unknown;
    for (let index = 0; index < pending.length;) {
      const entry = pending[index];
      if (blocked.has(entry.key) || (onlyDue && (entry.retryAt ?? 0) > Date.now())) {
        blocked.add(entry.key);
        index++;
        continue;
      }
      let merged: string;
      try {
        const { key, previous, value } = entry;
        merged = await invoke<string>("write_global_setting", { key, previous, value });
      } catch (error) {
        if (String(error).includes("Unknown global setting")) {
          rejected.add(entry.key);
          const edits = pending.filter(item => item.key === entry.key);
          const rollback = cache[entry.key] === edits[edits.length - 1].value;
          if (rollback) {
            if (entry.previous === null) delete cache[entry.key];
            else cache[entry.key] = entry.previous;
          }
          for (let i = pending.length - 1; i >= 0; i--) {
            if (pending[i].key === entry.key) pending.splice(i, 1);
          }
          if (rollback) changed();
          console.error(`Global setting rejected key=${entry.key}:`, error);
          continue;
        }
        entry.failures = (entry.failures ?? 0) + 1;
        entry.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(entry.failures, 5));
        blocked.add(entry.key);
        failure ??= new Error(`Cannot write global setting key=${entry.key}: ${String(error)}`);
        index++;
        continue;
      }
      pending.splice(index, 1);
      if (cache[entry.key] === entry.value && merged !== entry.value) {
        cache[entry.key] = merged;
        changed();
      }
    }
    if (failure) throw failure;
  })().finally(() => { running = null; });
  return running;
}

export async function refreshGlobalSettings(): Promise<void> {
  if (!isTauri() || refreshing) return;
  refreshing = true;
  try {
    // Failed writes retain their optimistic edits but must not block reading
    // unrelated changes made by another project.
    await flushGlobalSettings(true).catch(error => console.error("Cannot save global settings:", error));
    const before = { ...cache };
    const values = await invoke<Record<string, string>>("read_global_settings");
    let updated = false;
    for (const key of new Set([...Object.keys(before), ...Object.keys(values)])) {
      if (cache[key] !== before[key] || pending.some(entry => entry.key === key)) continue;
      if (cache[key] !== values[key]) {
        if (values[key] === undefined) delete cache[key];
        else cache[key] = values[key];
        updated = true;
      }
    }
    if (updated) changed();
  } finally { refreshing = false; }
}

export async function initializeGlobalSettings(): Promise<void> {
  if (!isTauri()) return;
  Object.assign(cache, await invoke<Record<string, string>>("read_global_settings"));
  const refresh = () => void refreshGlobalSettings().catch(error => console.error("Cannot refresh global settings:", error));
  window.addEventListener("focus", refresh);
  window.addEventListener("pagehide", () => { void flushGlobalSettings().catch(console.error); });
  window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 2000);
}
