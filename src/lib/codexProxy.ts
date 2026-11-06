import { invoke, isTauri } from "@tauri-apps/api/core";
import type { NetworkRequest } from "./networkMonitor";

export type ProxyInfo = {
  running: boolean;
  upstreamUrl: string | null;
  proxyBaseUrl: string | null;
  providerId: string | null;
};

export type DetectedProvider = { providerId: string | null; upstreamUrl: string | null };
type ProxyRecord = Pick<NetworkRequest,
  "id" | "url" | "method" | "status" | "startedAt" | "timeMs" | "failed" | "requestMessage" | "responseMessage" | "requestBytes" | "responseBytes" | "truncated" | "inFlight">;
type ProxyBatch = { cursor: number; requests: ProxyRecord[]; info: ProxyInfo };

export function codexProxyLaunchCommand(providerId: string, proxyBaseUrl: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(providerId)) throw new Error("此 provider 名称不支持命令行覆盖，请使用字母、数字、下划线或短横线");
  if (!/^http:\/\/127\.0\.0\.1:\d+(?:\/[a-zA-Z0-9_./%~-]*)?$/.test(proxyBaseUrl)) throw new Error("本地网关地址无效");
  const key = `model_providers.${providerId}`;
  const quote = (value: string) => `'${value}'`;
  return `codex --no-alt-screen -c ${quote(`${key}.base_url=${JSON.stringify(proxyBaseUrl)}`)} -c ${quote(`${key}.supports_websockets=false`)}`;
}

export async function detectCodexProvider() {
  if (!isTauri()) return { providerId: null, upstreamUrl: null } satisfies DetectedProvider;
  return invoke<DetectedProvider>("codex_proxy_detect");
}

export async function getCodexProxyStatus() {
  if (!isTauri()) return { running: false, upstreamUrl: null, proxyBaseUrl: null, providerId: null } satisfies ProxyInfo;
  return invoke<ProxyInfo>("codex_proxy_status");
}

export async function startCodexProxy(upstreamUrl: string) {
  return invoke<ProxyInfo>("codex_proxy_start", { upstreamUrl });
}

export async function stopCodexProxy() {
  return invoke<void>("codex_proxy_stop");
}

/** Polls the in-memory request ring serially so long streams cannot overlap reads. */
export function watchCodexProxy(onRequest: (request: NetworkRequest) => void, onInfo: (info: ProxyInfo) => void) {
  if (!isTauri()) return () => {};
  let stopped = false;
  let cursor: number | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    try {
      const batch = await invoke<ProxyBatch>("codex_proxy_requests", { cursor: cursor ?? null });
      if (stopped) return;
      cursor = batch.info.running ? batch.cursor : undefined;
      onInfo(batch.info);
      for (const request of batch.requests) onRequest({ ...request, id: -(1_000_000_000_000 + request.id), source: "codex", captureMode: "proxy" });
    } catch {
      if (!stopped) onInfo({ running: false, upstreamUrl: null, proxyBaseUrl: null, providerId: null });
    }
    if (!stopped) timer = setTimeout(() => void poll(), 500);
  };
  void poll();
  return () => { stopped = true; clearTimeout(timer); };
}
