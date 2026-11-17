import { invoke, isTauri } from "@tauri-apps/api/core";
import type { NetworkRequest } from "./networkMonitor";

type CodexRecord = Pick<NetworkRequest, "id" | "url" | "method" | "status" | "startedAt" | "failed" | "requestMessage" | "responseMessage">;
type Batch = { cursor: number; requests: CodexRecord[]; available: boolean };

/** Serial polling keeps SQLite reads bounded and avoids overlapping requests. */
export function watchCodexNetwork(onRequest: (item: NetworkRequest) => void, onStatus: (status: string) => void) {
  if (!isTauri()) { onStatus("Codex 监控需要桌面应用"); return () => {}; }
  let stopped = false;
  let cursor: number | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    try {
      const batch = await invoke<Batch>("codex_network_requests", { cursor: cursor ?? null });
      if (stopped) return;
      cursor = batch.cursor;
      onStatus(batch.available ? "Codex · 本机 HTTP 日志" : "未找到 Codex HTTP 日志");
      for (const item of batch.requests) onRequest({ ...item, id: -item.id, source: "codex", captureMode: "logs", metricsUnavailable: true, timeMs: 0, requestBytes: 0, responseBytes: 0 });
    } catch {
      if (!stopped) onStatus("Codex 日志读取失败，将自动重试");
    }
    if (!stopped) timer = setTimeout(() => void poll(), 1500);
  };
  void poll();
  return () => { stopped = true; clearTimeout(timer); };
}
