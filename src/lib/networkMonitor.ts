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
function headerPairs(headers: Headers): [string, string][] {
  const pairs: [string, string][] = [];
  headers.forEach((value, name) => pairs.push([name, value]));
  return pairs;
}
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
type BodyDetails = { text: string; bytes: number };
function bytesDetails(buffer: ArrayBuffer): BodyDetails {
  const bytes = new Uint8Array(buffer);
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), bytes: bytes.byteLength }; }
  catch {
    const parts: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 8192) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
    return { text: `[二进制内容，Base64]\r\n${btoa(parts.join(""))}`, bytes: bytes.byteLength };
  }
}
async function bodyDetails(body: BodyInit | Document | null | undefined): Promise<BodyDetails> {
  if (body == null) return { text: "", bytes: 0 };
  try {
    if (body instanceof Document) return bodyDetails(new XMLSerializer().serializeToString(body));
    if (typeof body === "string") return { text: body, bytes: byteLength(body) };
    if (body instanceof URLSearchParams) return bodyDetails(body.toString());
    if (body instanceof ReadableStream) return { text: "[流式请求体不可读取]", bytes: 0 };
    return bytesDetails(await new Response(body).arrayBuffer());
  } catch { return { text: "[正文不可读取]", bytes: 0 }; }
}

let installed = false;
/** Observe HTTP(S) made by this WebView, retaining exposed headers and bodies. */
export function installNetworkMonitor() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const originalFetch = window.fetch;
  window.fetch = async function(this: Window, input: RequestInfo | URL, init?: RequestInit) {
    const req = input instanceof Request ? input : null;
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, window.location.href).href;
    if (!/^https?:/i.test(url)) return originalFetch.call(this, input, init);
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    // Request resolves body serialization (including multipart boundaries) without consuming the caller's body.
    let snapshot: Request | undefined;
    try { snapshot = new Request(req ? req.clone() : url, init); } catch { /* preserve native fetch errors */ }
    const headers = headerPairs(snapshot?.headers ?? new Headers(init?.headers ?? req?.headers));
    const requestBody = snapshot ? snapshot.clone().arrayBuffer().then(bytesDetails, () => ({ text: "[请求体不可读取]", bytes: 0 })) : bodyDetails(init?.body);
    const started = performance.now(), startedAt = Date.now(), id = nextId++;
    const capture = async (response?: Response, error?: unknown) => {
      const responseCopy = response?.clone();
      const sent = await requestBody;
      let received: BodyDetails = { text: "[响应体不可读取]", bytes: Number(response?.headers.get("content-length")) || 0 };
      if (responseCopy) { try { received = bytesDetails(await responseCopy.arrayBuffer()); } catch { /* opaque response */ } }
      publish({ id, url, method, status: response?.status ?? null, timeMs: Math.round(performance.now() - started), requestBytes: sent.bytes, responseBytes: response ? received.bytes : 0, startedAt, failed: !response,
        requestMessage: formatHttpMessage(`${method} ${url}`, headers, sent.text),
        responseMessage: response ? formatHttpMessage(`${response.status} ${response.statusText}`.trim(), headerPairs(response.headers), received.text) : `请求失败: ${String(error)}` });
    };
    try {
      const response = await originalFetch.call(this, snapshot ?? input, snapshot ? undefined : init);
      // Read a clone in the background so streamed responses remain available immediately.
      void capture(response).catch(() => {});
      return response;
    } catch (error) {
      void capture(undefined, error).catch(() => {});
      throw error;
    }
  };
  const proto = XMLHttpRequest.prototype, open = proto.open, send = proto.send, setHeader = proto.setRequestHeader;
  type XhrRecord = { method: string; url: string; headers: [string, string][] };
  const records = new WeakMap<XMLHttpRequest, XhrRecord>();
  proto.open = function(this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
    const result = (open as any).call(this, method, url, ...rest);
    records.set(this, { method: method.toUpperCase(), url: new URL(String(url), window.location.href).href, headers: [] });
    return result;
  } as typeof proto.open;
  proto.setRequestHeader = function(this: XMLHttpRequest, name: string, value: string) {
    setHeader.call(this, name, value);
    records.get(this)?.headers.push([name, value]);
  };
  proto.send = function(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const data = records.get(this);
    if (!data || !/^https?:/i.test(data.url)) return send.call(this, body);
    const started = performance.now(), startedAt = Date.now(), id = nextId++, requestBody = bodyDetails(body);
    this.addEventListener("loadend", () => {
      // Snapshot before asynchronous body conversion; callers may reuse this XHR.
      const status = this.status, statusText = this.statusText, rawHeaders = this.getAllResponseHeaders();
      const timeMs = Math.round(performance.now() - started);
      let value: unknown;
      try { value = this.responseType === "json" ? JSON.stringify(this.response) : this.response; } catch { value = "[响应体不可读取]"; }
      const received = bodyDetails(value as BodyInit | Document | null);
      void Promise.all([requestBody, received]).then(([sent, response]) => {
        const headers: [string, string][] = rawHeaders.trim().split(/\r?\n/).filter(Boolean).map(line => {
          const colon = line.indexOf(":"); return [line.slice(0, colon), line.slice(colon + 1).trim()];
        });
        publish({ id, url: data.url, method: data.method, status: status || null, timeMs, requestBytes: sent.bytes, responseBytes: response.bytes, startedAt, failed: status === 0,
          requestMessage: formatHttpMessage(`${data.method} ${data.url}`, data.headers, sent.text),
          responseMessage: status ? formatHttpMessage(`${status} ${statusText}`.trim(), headers, response.text) : "请求失败" });
      }).catch(() => {});
    }, { once: true });
    return send.call(this, body);
  } as typeof proto.send;
}
