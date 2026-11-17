import { useCallback, useMemo, useSyncExternalStore, type SetStateAction } from "react";
import { settingsStorage } from "@/utils/globalSettings";
import { readUI, writeUI } from "@/utils/uiPersistence";

const changeEvent = "persistent-state-changed";

function subscribe(listener: () => void) {
  window.addEventListener(changeEvent, listener);
  window.addEventListener("global-settings-changed", listener);
  return () => {
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener("global-settings-changed", listener);
  };
}

function decode<T>(raw: string | null, normalize: (value: unknown) => T): T {
  try { return normalize(raw === null ? undefined : JSON.parse(raw)); }
  catch { return normalize(undefined); }
}

function usePersistentState<T>(read: () => string | null, write: (value: T) => void, normalize: (value: unknown) => T): [T, (action: SetStateAction<T>) => void] {
  const raw = useSyncExternalStore(subscribe, read);
  const value = useMemo(() => decode(raw, normalize), [raw, normalize]);
  const setValue = (action: SetStateAction<T>) => {
    const current = decode(read(), normalize);
    const next = typeof action === "function" ? (action as (previous: T) => T)(current) : action;
    write(normalize(next));
    window.dispatchEvent(new Event(changeEvent));
  };
  return [value, setValue];
}

export function useGlobalPreference<T>(key: string, normalize: (value: unknown) => T) {
  const read = useCallback(() => settingsStorage.getItem(key), [key]);
  const write = (value: T) => settingsStorage.setItem(key, JSON.stringify(value));
  return usePersistentState(read, write, normalize);
}

export function useProjectUIState<T>(root: string, category: string, normalize: (value: unknown) => T) {
  const read = useCallback(() => JSON.stringify(readUI(root, category) ?? null), [root, category]);
  const write = (value: T) => writeUI(root, category, value);
  return usePersistentState(read, write, normalize);
}

export function storedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
