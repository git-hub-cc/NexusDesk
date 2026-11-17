import { useEffect, useRef, useState } from "react";
import { settingsStorage } from "./globalSettings";

const queues = new Map<string, Promise<void>>();
const flushers = new Set<() => void>();

export async function flushSettingsAutosaves(): Promise<void> {
  for (const flush of flushers) flush();
  await Promise.all(queues.values());
}

export function waitForSettingsSave(key: string): Promise<void> {
  return (queues.get(key) || Promise.resolve()).catch(() => {});
}

export function readSettingsDraft<T>(key: string): Partial<T> {
  try {
    const value = JSON.parse(settingsStorage.getItem(key) || "null");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function useSettingsAutosave<T>(key: string, value: T, enabled: boolean, save: (value: T) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const pending = useRef<(() => void) | null>(null);
  const serialized = JSON.stringify(value);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    mounted.current = true;
    const flush = () => pending.current?.();
    flushers.add(flush);
    window.addEventListener("pagehide", flush);
    return () => {
      mounted.current = false;
      flushers.delete(flush);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [key]);

  useEffect(() => {
    if (!enabled) return;
    settingsStorage.setItem(key, serialized);
    const write = saveRef.current;
    const flush = () => {
      if (pending.current !== flush) return;
      pending.current = null;
      if (mounted.current) { setBusy(true); setError(""); }
      const task = (queues.get(key) || Promise.resolve()).catch(() => {}).then(() => write(JSON.parse(serialized)));
      queues.set(key, task);
      void task.then(() => {
        if (settingsStorage.getItem(key) === serialized) settingsStorage.setItem(key, "");
      }).catch(reason => {
        if (mounted.current) setError(String(reason));
        console.error("设置保存失败，输入已保留：", reason);
      }).finally(() => {
        if (queues.get(key) === task) {
          queues.delete(key);
          if (mounted.current) setBusy(false);
        }
      });
    };
    pending.current = flush;
    const timer = window.setTimeout(flush, 500);
    return () => window.clearTimeout(timer);
  }, [key, serialized, enabled]);

  return { busy, error };
}
