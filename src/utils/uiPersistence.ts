import { settingsStorage } from "./globalSettings";
import { pathKey } from "./paths";
import { isSnapshot } from "./snapshot";

const pending = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;

export const projectKey = pathKey;

export function readUI<T>(root: string, category: string): T | undefined {
  const key = `nexusdesk-ui:${projectKey(root)}:${category}`;
  try { return JSON.parse(pending.get(key) ?? settingsStorage.getItem(key) ?? "null") ?? undefined; }
  catch { return undefined; }
}

export function writeUI(root: string, category: string, value: unknown) {
  pending.set(`nexusdesk-ui:${projectKey(root)}:${category}`, JSON.stringify(value));
  // 快照窗口仅保留内存状态，仍允许切换预览模式等交互。
  if (isSnapshot) return;
  clearTimeout(timer);
  timer = setTimeout(flushUIState, 300);
  deadline ??= setTimeout(flushUIState, 2000);
}

export function flushUIState() {
  if (isSnapshot) return;
  clearTimeout(timer);
  clearTimeout(deadline);
  deadline = undefined;
  for (const [key, value] of pending) {
    settingsStorage.setItem(key, value);
    pending.delete(key);
  }
}
