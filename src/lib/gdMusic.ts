import type { MusicTrack } from "@/lib/api";

const ORIGIN = "https://music.gdstudio.org";
let serverTime: { fetchedAt: number; timestamp: number } | null = null;
let signer: { fetchedAt: number; value: Promise<{ script: string; version: string }> } | null = null;
const playback = new Map<string, { fetchedAt: number; value: Promise<string> }>();

async function resource(path: string): Promise<string> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("music_service_resource", { path });
  }
  const response = await fetch(`${ORIGIN}${path}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`音乐服务请求失败（HTTP ${response.status}）`);
  return response.text();
}

function scriptPath(html: string, filename: string): string {
  const sources = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)];
  for (const [, src] of sources) {
    const url = new URL(src.replace(/&amp;/g, "&"), ORIGIN);
    if (url.origin === ORIGIN && url.pathname === `/js/${filename}`) return url.pathname + url.search;
  }
  throw new Error(`音乐网站未提供 ${filename}，请稍后重试`);
}

async function currentSigner() {
  if (!signer || Date.now() - signer.fetchedAt >= 5 * 60_000) {
    const value = (async () => {
      const html = await resource("/");
      const [script, player] = await Promise.all([
        resource(scriptPath(html, "crc32.min.js")), resource(scriptPath(html, "player.js")),
      ]);
      const version = /\bversion\s*:\s*["']([\d.]+)["']/.exec(player)?.[1];
      if (!version) throw new Error("无法识别音乐网站版本，请稍后重试");
      return { script, version };
    })();
    signer = { fetchedAt: Date.now(), value };
    void value.catch(() => { if (signer?.value === value) signer = null; });
  }
  return signer.value;
}

// The upstream script runs only inside a disposable Worker, without DOM or Tauri IPC.
// Its synchronous /time request is answered from our server-time cache.
export function signerWorkerSource(script: string, version: string): string {
  return `
    self.window = { location: { hostname: "music.gdstudio.org" } };
    self.mkPlayer = { version: ${JSON.stringify(version)} };
    let timestamp;
    self.XMLHttpRequest = class {
      status = 200; readyState = 4;
      open(method, path) { if (method !== "GET" || path !== "/time") throw Error("Unsupported signer request"); }
      send() { this.responseText = String(Math.floor(timestamp / 1000)); }
      abort() {}
    };
    self.fetch = self.WebSocket = self.importScripts = undefined;
    ${script}
    self.onmessage = ({ data }) => {
      timestamp = data.timestamp;
      try { self.postMessage({ signature: crc32(data.input) }); }
      catch { self.postMessage({ error: "音乐签名脚本运行失败" }); }
    };
  `;
}

async function serviceTimestamp(): Promise<number> {
  const now = Date.now();
  if (serverTime && now - serverTime.fetchedAt < 5 * 60_000) return serverTime.timestamp + now - serverTime.fetchedAt;
  try {
    const seconds = (await resource("/time")).trim();
    if (!/^\d{10}$/.test(seconds)) throw new Error("无效的服务器时间");
    serverTime = { fetchedAt: Date.now(), timestamp: Number(seconds) * 1000 };
    return serverTime.timestamp;
  } catch { return Date.now(); }
}

async function signature(input: string): Promise<string> {
  const [{ script, version }, timestamp] = await Promise.all([currentSigner(), serviceTimestamp()]);
  const url = URL.createObjectURL(new Blob([signerWorkerSource(script, version)], { type: "text/javascript" }));
  let worker: Worker;
  try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
  return new Promise((resolve, reject) => {
    const finish = (error?: string, value?: string) => {
      clearTimeout(timer); worker.terminate();
      if (error) reject(new Error(error)); else resolve(value!);
    };
    const timer = setTimeout(() => finish("音乐签名计算超时，请重试"), 3000);
    worker.onerror = event => { event.preventDefault(); finish("音乐签名脚本加载失败"); };
    worker.onmessage = ({ data }) => {
      if (typeof data.signature === "string" && /^[A-F0-9]{8}$/.test(data.signature)) finish(undefined, data.signature);
      else finish("音乐签名脚本返回了无效数据");
    };
    worker.postMessage({ input, timestamp });
  });
}

async function apiRequest<T>(params: Record<string, string>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const s = await signature(encodeURIComponent(params.id ?? params.name ?? ""));
      const text = await resource(`/api.php?${new URLSearchParams({ ...params, s })}`);
      const data = JSON.parse(text);
      if (params.types === "search" ? !Array.isArray(data) : !data || typeof data.url !== "string") {
        throw new Error("音乐服务返回了无效数据");
      }
      return data as T;
    } catch (error) {
      if (attempt) throw error;
      // A website deployment can invalidate an otherwise fresh cached signer.
      signer = null; serverTime = null;
    }
  }
  throw new Error("音乐服务请求失败");
}

interface GDTrack {
  id: string | number; name: string; artist: string | string[]; album?: string;
  extra_data?: { duration?: number | string };
}

export async function searchGDStudio(query: string, offset = 0): Promise<MusicTrack[]> {
  query = query.trim();
  if (!query) return [];
  const page = Math.floor(offset / 30) + 1;
  const data = await apiRequest<GDTrack[]>({ types: "search", count: "30", source: "netease", pages: String(page), name: query });
  return data.filter(track => track?.id != null).map(track => ({
    id: String(track.id), title: track.name ?? "未知歌曲",
    artist: Array.isArray(track.artist) ? track.artist.join(" / ") : track.artist ?? "未知歌手",
    album: track.album ?? "未知专辑", duration: Number(track.extra_data?.duration ?? 0) * 1000, path: null, coverPath: null,
  }));
}

export function resolveGDStudioPlayUrl(id: string): Promise<string> {
  const cached = playback.get(id);
  if (cached && Date.now() - cached.fetchedAt < 10 * 60_000) return cached.value;
  if (playback.size >= 128) playback.clear();
  const value = resolvePlayUrl(id);
  playback.set(id, { fetchedAt: Date.now(), value });
  void value.catch(() => { if (playback.get(id)?.value === value) playback.delete(id); });
  return value;
}

async function resolvePlayUrl(id: string): Promise<string> {
  const result = await apiRequest<{ url?: string; error?: string }>({ types: "url", id, source: "netease", br: "320" });
  if (!result?.url || result.url === "err") throw new Error(result?.error || "该歌曲暂无可用的播放地址，请尝试其他歌曲");
  try {
    const url = new URL(result.url);
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") throw new Error();
    return url.toString();
  } catch { throw new Error("音乐服务返回了无效的播放地址"); }
}
