import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

try {
  const entries: Record<string, string> = {};
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)!;
    entries[key] = localStorage.getItem(key)!;
  }
  await invoke("import_global_settings", { entries });
} catch (error) {
  document.body.textContent = `无法迁移全局配置，原始数据未删除。请重启重试。\n${String(error)}`;
  await getCurrentWindow().show();
}
