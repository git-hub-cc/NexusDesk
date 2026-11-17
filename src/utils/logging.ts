import { invoke, isTauri } from "@tauri-apps/api/core";

// Keep native console output while forwarding a bounded queue to disk.
if (isTauri()) {
  type Entry = { level: string; message: string };
  const queue: Entry[] = [];
  let sending = false;
  const originalError = console.error.bind(console);
  function format(value: unknown): string {
    try {
      if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
      if (typeof value === "string") return value;
      return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? `${item}n` : item) ?? String(value);
    } catch { return "[Unserializable console value]"; }
  }
  function enqueue(level: string, values: unknown[]) {
    if (queue.length >= 1000) queue.shift();
    queue.push({ level, message: values.map(format).join(" ").slice(0, 64 * 1024) });
  }
  for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]) => {
      original(...values);
      enqueue(level === "trace" ? "debug" : level, level === "trace" ? [...values, new Error().stack] : values);
    };
  }
  window.addEventListener("error", event => enqueue("error", [event.error ?? `${event.message} (${event.filename}:${event.lineno}:${event.colno})`]));
  window.addEventListener("unhandledrejection", event => enqueue("error", ["Unhandled promise rejection:", event.reason]));
  async function flush() {
    if (sending || queue.length === 0) return;
    sending = true;
    const entries = queue.splice(0, 100);
    try { await invoke("write_console_logs", { entries }); }
    catch (error) { originalError("Cannot write console logs:", error); }
    finally { sending = false; }
  }
  window.setInterval(() => void flush(), 250);
  window.addEventListener("pagehide", () => void flush());
  enqueue("info", ["Webview started", window.location.href]);
}
