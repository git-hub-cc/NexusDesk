import { settingsStorage } from "./globalSettings";
import { isSnapshot } from "./snapshot";

const pending = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;

export function projectKey(path: string) {
  const value = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^(?:[a-z]:|\/\/)/i.test(value) ? value.toLowerCase() : value;
}

export function readUI<T>(root: string, category: string): T | undefined {
  const key = `noteide-ui:${projectKey(root)}:${category}`;
  try { return JSON.parse(pending.get(key) ?? settingsStorage.getItem(key) ?? "null") ?? undefined; }
  catch { return undefined; }
}

export function writeUI(root: string, category: string, value: unknown) {
  if (isSnapshot) return;
  pending.set(`noteide-ui:${projectKey(root)}:${category}`, JSON.stringify(value));
  clearTimeout(timer);
  timer = setTimeout(flushUIState, 300);
  deadline ??= setTimeout(flushUIState, 2000);
}

export function flushUIState() {
  clearTimeout(timer);
  clearTimeout(deadline);
  deadline = undefined;
  for (const [key, value] of pending) {
    settingsStorage.setItem(key, value);
    pending.delete(key);
  }
}
