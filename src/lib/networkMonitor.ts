export type NetworkRequest = {
  source?: "codex"; captureMode?: "logs" | "proxy"; metricsUnavailable?: boolean; truncated?: boolean; inFlight?: boolean;
  id: number; url: string; method: string; status: number | null; timeMs: number;
  requestBytes: number; responseBytes: number; startedAt: number; failed?: boolean;
  requestMessage: string; responseMessage: string;
};

type Listener = (request: NetworkRequest) => void;
const listeners = new Set<Listener>();
let nextId = 1;
export function subscribeNetworkRequests(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish(request: NetworkRequest) { for (const listener of listeners) listener(request); }
export function recordNetworkRequest(request: Omit<NetworkRequest, "id" | "startedAt"> & Partial<Pick<NetworkRequest, "id" | "startedAt">>) {
  publish({ id: request.id ?? nextId++, startedAt: request.startedAt ?? Date.now(), ...request });
}

export function formatHttpMessage(startLine: string, headers: [string, string][], body = "") {
  return [startLine, ...headers.map(([name, value]) => `${name}: ${value}`)].join("\r\n") + "\r\n\r\n" + body;
}
