import { settingsStorage } from "@/lib/globalSettings";
import { memo, useEffect, useRef, useState, useMemo } from "react";
import { Code, Eye, Columns2, Play, Square, Clock, HardDrive, Globe, AlertTriangle } from "lucide-react";
import { useWorkspaceStore, type Tab } from "@/store/workspaceStore";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { extractStreamContent, extractResponseUrls } from "@/lib/httpStreamExtraction";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { compactResponseBase64 } from "@/lib/httpResponsePreview";
import { extractResponseBase64 } from "@/lib/httpBase64Extraction";
import { formatHttpMessage, recordNetworkRequest } from "@/lib/networkMonitor";

const ResponseText = memo(({ content, className }: { content: string; className: string }) => {
  const preview = useMemo(() => compactResponseBase64(content), [content]);
  return <pre className={className} onCopy={event => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!event.currentTarget.contains(range.startContainer) || !event.currentTarget.contains(range.endContainer)) return;
    const prefix = range.cloneRange();
    prefix.selectNodeContents(event.currentTarget);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    event.clipboardData.setData("text/plain", preview.copySelection(start, start + range.toString().length));
    event.preventDefault();
  }}>{preview.text}</pre>;
});

const modes = [
  { id: "source", label: "源码", icon: Code },
  { id: "preview", label: "调试", icon: Eye },
  { id: "split", label: "双栏", icon: Columns2 },
] as const;

interface HttpRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
  lineStart: number;
}

interface HttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  timeMs: number;
  sizeBytes: number;
  isBinary: boolean;
  truncated: boolean;
}

function parseHttpFile(content: string): HttpRequest[] {
  const requests: HttpRequest[] = [];
  const lines = content.split(/\r?\n/);
  let current: Partial<HttpRequest> & { headerPhase: boolean } = { headerPhase: true, headers: [], body: "", lineStart: 0 };

  const commitCurrent = () => {
    if (current.method && current.url) {
      requests.push({
        id: JSON.stringify([current.method, current.url, current.name || "", requests.filter(r => r.method === current.method && r.url === current.url && r.name === (current.name || `${current.method} ${current.url}`)).length]),
        name: current.name || `${current.method} ${current.url}`,
        method: current.method,
        url: current.url,
        headers: current.headers || [],
        body: (current.body || "").trim(),
        lineStart: current.lineStart || 0,
      });
    }
    current = { headerPhase: true, headers: [], body: "", lineStart: 0 };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("###")) {
      commitCurrent();
      const name = line.replace(/^###\s*/, "").trim();
      if (name) current.name = name;
      current.lineStart = i + 1;
      continue;
    }
    if (line.trim().startsWith("#") || line.trim().startsWith("//")) {
      if (!current.name && current.headerPhase && !current.method) {
        current.name = line.replace(/^[#\/]+\s*/, "").trim();
      }
      continue;
    }
    if (current.headerPhase) {
      if (line.trim() === "") {
        if (current.method) current.headerPhase = false;
        continue;
      }
      if (!current.method) {
        const match = line.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\s+(.+)$/i);
        if (match) {
          current.method = match[1].toUpperCase();
          current.url = match[2].trim();
          if (!current.lineStart) current.lineStart = i + 1;
        } else if (line.trim().startsWith("http")) {
          current.method = "GET";
          current.url = line.trim();
          if (!current.lineStart) current.lineStart = i + 1;
        }
      } else {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          current.headers!.push([line.slice(0, colonIdx).trim(), line.slice(colonIdx + 1).trim()]);
        }
      }
    } else {
      current.body += line + "\n";
    }
  }
  commitCurrent();
  return requests;
}

const HttpDebugger = memo(({ content, filePath }: { content: string; filePath: string }) => {
  const requests = useMemo(() => parseHttpFile(content), [content]);
  const [timeoutSeconds, setTimeoutSeconds] = useState(300);
  const [maxSizeMb, setMaxSizeMb] = useState(20);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [responseTab, setResponseTab] = useState<"body" | "extract" | "urls" | "base64">("body");
  const [templates, setTemplates] = useState<Record<string, string>>(() => {
    try { const saved = JSON.parse(settingsStorage.getItem("nexusdesk.http.extraction.v1") || "{}"); return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {}; } catch { return {}; }
  });
  const [storageError, setStorageError] = useState("");
  const [activeReqId, setActiveReqId] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, HttpResponse>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (requests.length > 0 && !activeReqId) {
      setActiveReqId(requests[0].id);
    } else if (requests.length > 0 && activeReqId && !requests.find(r => r.id === activeReqId)) {
      setActiveReqId(requests[0].id);
    }
  }, [requests, activeReqId]);

  const activeReq = requests.find(r => r.id === activeReqId);

  const templateKey = JSON.stringify([filePath.replace(/\\/g, "/"), activeReq?.id]);
  const extractedUrls = useMemo(() => extractResponseUrls(activeReq ? responses[activeReq.id]?.body || "" : ""), [activeReq, responses]);
  const extractedBase64 = useMemo(() => responseTab === "base64" ? extractResponseBase64(activeReq ? responses[activeReq.id]?.body || "" : "") : [], [activeReq, responses, responseTab]);
  const template = typeof templates[templateKey] === "string" ? templates[templateKey] : "";
  const extraction = useMemo(() => {
    try { return { ...extractStreamContent(activeReq ? responses[activeReq.id]?.body || "" : "", template), error: "" }; }
    catch (error) { return { content: "", matches: 0, error: error instanceof SyntaxError ? "模板不是有效的 JSON，请填写包含 {{content}} 的 JSON 节点。" : String(error) }; }
  }, [activeReq, responses, template]);
  const saveTemplate = (value: string, key = templateKey) => {
    const next = { ...templates, [key]: value };
    setTemplates(next);
    try {
      const saved = JSON.parse(settingsStorage.getItem("nexusdesk.http.extraction.v1") || "{}");
      settingsStorage.setItem("nexusdesk.http.extraction.v1", JSON.stringify({ ...saved, [key]: value }));
      setStorageError("");
    } catch { setStorageError("本地缓存不可用，模板仅在当前页面保留。"); }
  };

  const sendRequest = async (req: HttpRequest) => {
    const startedAt = performance.now();
    const requestStartedAt = Date.now();
    const requestMessage = formatHttpMessage(`${req.method} ${req.url}`, req.headers, req.body);
    setLoading(prev => ({ ...prev, [req.id]: true }));
    setErrors(prev => ({ ...prev, [req.id]: "" }));
    try {
      const res = await invoke<HttpResponse>("send_http_request", {
        requestId: req.id,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        timeout: timeoutSeconds,
        maxSizeBytes: Math.floor(maxSizeMb * 1024 * 1024),
      });
      recordNetworkRequest({ url: req.url, method: req.method, status: res.status, timeMs: res.timeMs, requestBytes: new TextEncoder().encode(req.body).byteLength, responseBytes: res.sizeBytes,
        startedAt: requestStartedAt, requestMessage,
        responseMessage: formatHttpMessage(`${res.status} ${res.statusText}`, res.headers, (res.isBinary ? "[二进制内容，Base64]\r\n" : "") + res.body + (res.truncated ? "\r\n[响应已按 HTTP 编辑器的大小限制截断，请调大截断大小后重新请求]" : "")) });
      setResponses(prev => ({ ...prev, [req.id]: res }));
    } catch (err) {
      recordNetworkRequest({ url: req.url, method: req.method, status: null, timeMs: Math.round(performance.now() - startedAt), requestBytes: new TextEncoder().encode(req.body).byteLength, responseBytes: 0, failed: true,
        startedAt: requestStartedAt, requestMessage, responseMessage: `请求失败: ${String(err)}` });
      setErrors(prev => ({ ...prev, [req.id]: String(err) }));
    } finally {
      setLoading(prev => ({ ...prev, [req.id]: false }));
    }
  };

  const cancelRequest = async (reqId: string) => {
    try {
      await invoke("cancel_http_request", { requestId: reqId });
    } catch (e) {
      console.error("Failed to cancel request", e);
    }
  };

  const activeResponse = activeReq ? responses[activeReq.id] : undefined;
  const imageType = activeResponse?.headers.find(([key]) => key.toLowerCase() === "content-type")?.[1].split(";")[0].trim().toLowerCase() || "";
  const isImage = imageType.startsWith("image/");
  const saveImage = async () => {
    if (!activeResponse || activeResponse.truncated || !isImage) return;
    setSaving(true);
    setSaveError("");
    try {
      const extension = ({ "image/jpeg": "jpg", "image/svg+xml": "svg", "image/x-icon": "ico" } as Record<string, string>)[imageType] || imageType.slice(6).replace(/[^a-z0-9]/g, "") || "png";
      const path = await save({ defaultPath: `response.${extension}`, filters: [{ name: "图片", extensions: [extension] }] });
      if (path) {
        const bytes = Uint8Array.from(atob(activeResponse.body), char => char.charCodeAt(0));
        await invoke("write_binary_file", { path, bytes: Array.from(bytes) });
      }
    } catch (error) { setSaveError(String(error)); }
    finally { setSaving(false); }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const getStatusColor = (status: number) => {
    if (status >= 200 && status < 300) return "text-green-400";
    if (status >= 300 && status < 400) return "text-blue-400";
    if (status >= 400 && status < 500) return "text-amber-400";
    return "text-red-400";
  };

  return (
    <div className="flex flex-col h-full bg-ide-bg text-sm">
      <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-b border-ide-panel-border text-xs">
        <label className="flex items-center gap-1">超时（秒）<input aria-label="请求超时（秒）" type="number" min={1} step={1} value={timeoutSeconds} onChange={event => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value > 0) setTimeoutSeconds(value); }} className="w-20 rounded border border-ide-panel-border bg-ide-bg px-2 py-1 outline-none focus:border-ide-accent" /></label>
        <label className="flex items-center gap-1">截断大小（MB）<input aria-label="响应截断大小（MB）" type="number" min={1} step={1} value={maxSizeMb} onChange={event => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(value * 1024 * 1024)) setMaxSizeMb(value); }} className="w-20 rounded border border-ide-panel-border bg-ide-bg px-2 py-1 outline-none focus:border-ide-accent" /></label>
      </div>
      <div className="flex-1 flex min-h-0">
        <div className="w-1/3 border-r border-ide-panel-border flex flex-col min-w-[200px]">
          <div className="px-3 py-2 border-b border-ide-panel-border font-semibold text-xs text-gray-400">请求列表 ({requests.length})</div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {requests.map(req => (
              <div
                key={req.id}
                onClick={() => setActiveReqId(req.id)}
                className={`p-2 rounded cursor-pointer border ${activeReqId === req.id ? "bg-ide-selection border-ide-accent text-white" : "border-transparent hover:bg-ide-tree-hover text-gray-300"}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-xs font-bold ${activeReqId === req.id ? "text-white" : "text-ide-accent"}`}>{req.method}</span>
                  {loading[req.id] ? (
                    <button onClick={(e) => { e.stopPropagation(); cancelRequest(req.id); }} className="text-red-400 hover:text-red-300" title="取消请求"><Square size={14} fill="currentColor" /></button>
                  ) : (
                    <button onClick={(e) => { e.stopPropagation(); setActiveReqId(req.id); sendRequest(req); }} className="text-green-400 hover:text-green-300" title="发送请求"><Play size={14} fill="currentColor" /></button>
                  )}
                </div>
                <div className="truncate text-xs" title={req.url}>{req.name}</div>
              </div>
            ))}
            {requests.length === 0 && <div className="text-gray-500 text-xs text-center mt-4">未解析到有效请求</div>}
          </div>
        </div>
        <div className="flex-1 flex flex-col min-w-0">
          {activeReq ? (
            <>
              <div className="p-3 border-b border-ide-panel-border bg-ide-panel-bg flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-bold text-ide-accent shrink-0">{activeReq.method}</span>
                  <span className="truncate text-gray-300 select-text" title={activeReq.url}>{activeReq.url}</span>
                </div>
                <button
                  onClick={() => loading[activeReq.id] ? cancelRequest(activeReq.id) : sendRequest(activeReq)}
                  className="ml-2 shrink-0 flex items-center gap-1 bg-ide-accent text-white px-3 py-1.5 rounded hover:brightness-110 disabled:opacity-50"
                >
                  {loading[activeReq.id] ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
                  {loading[activeReq.id] ? "取消" : "发送"}
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-4">
                {errors[activeReq.id] && (
                  <div className="p-3 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs break-words">
                    <div className="flex items-center gap-1 mb-1 font-bold"><AlertTriangle size={14} /> 请求失败</div>
                    {errors[activeReq.id]}
                  </div>
                )}
                {responses[activeReq.id] && !loading[activeReq.id] && (
                  <div className="flex flex-col gap-3 h-full">
                    <div className="flex flex-wrap items-center gap-4 text-xs bg-ide-panel-bg p-2 rounded border border-ide-panel-border shrink-0">
                      <div className={`font-bold flex items-center gap-1 ${getStatusColor(responses[activeReq.id].status)}`}>
                        <Globe size={14} /> {responses[activeReq.id].status} {responses[activeReq.id].statusText}
                      </div>
                      <div className="flex items-center gap-1 text-gray-400"><Clock size={14} /> {responses[activeReq.id].timeMs} ms</div>
                      <div className="flex items-center gap-1 text-gray-400"><HardDrive size={14} /> {formatSize(responses[activeReq.id].sizeBytes)}</div>
                    </div>
                    {responses[activeReq.id].truncated && (
                      <div className="text-xs text-amber-400 flex items-center gap-1 shrink-0">
                        <AlertTriangle size={14} /> 响应体积过大，已截断显示。
                      </div>
                    )}
                    <div className="flex-1 flex flex-col min-h-0 border border-ide-panel-border rounded overflow-hidden">
                      <div className="bg-ide-panel-bg flex text-xs font-semibold text-gray-400 border-b border-ide-panel-border shrink-0" role="tablist" aria-label="响应内容">
                        <button role="tab" aria-selected={responseTab === "body"} onClick={() => setResponseTab("body")} className={`px-3 py-1.5 ${responseTab === "body" ? "text-ide-accent" : ""}`}>Response Body</button>
                        <button role="tab" aria-selected={responseTab === "extract"} onClick={() => setResponseTab("extract")} className={`px-3 py-1.5 ${responseTab === "extract" ? "text-ide-accent" : ""}`}>流式提取</button>
                        <button role="tab" aria-selected={responseTab === "urls"} onClick={() => setResponseTab("urls")} className={`px-3 py-1.5 ${responseTab === "urls" ? "text-ide-accent" : ""}`}>URL 提取</button>
                        <button role="tab" aria-selected={responseTab === "base64"} onClick={() => setResponseTab("base64")} className={`px-3 py-1.5 ${responseTab === "base64" ? "text-ide-accent" : ""}`}>Base64 提取</button>
                      </div>
                      {responseTab === "extract" && <div className="p-3 flex flex-col gap-2 border-b border-ide-panel-border">
                        <label htmlFor={`extract-${activeReq.id}`} className="text-xs text-gray-400">内容匹配模板（按请求自动保存）</label>
                        <textarea id={`extract-${activeReq.id}`} aria-label="流式提取模板" value={template} onChange={event => saveTemplate(event.target.value)} spellCheck={false} rows={5} placeholder={'data: {"choices":[{"delta":{"content":"{{content}}"}}]}'} className="w-full resize-y bg-ide-bg border border-ide-panel-border rounded p-2 font-mono text-xs text-gray-300" />
                        <p className="text-xs text-gray-400">填写部分 JSON 节点，用 {"{{content}}"} 标记文本位置。响应完成后按顺序拼接 SSE / JSONL 中的内容。</p>
                        {(storageError || extraction.error) && <p role="alert" className="text-xs text-amber-400">{storageError || extraction.error}</p>}
                      </div>}
                      {isImage && <div className="px-3 py-2 text-xs border-b border-ide-panel-border">
                        <button disabled={saving || activeResponse?.truncated} onClick={saveImage} className="text-ide-accent disabled:opacity-50">{saving ? "保存中…" : "保存图片"}</button>
                        {activeResponse?.truncated && <span className="ml-2 text-amber-400">图片已截断，请调大截断大小后重新请求以预览和保存完整图片。</span>}
                        {saveError && <p role="alert" className="text-red-400">{saveError}</p>}
                      </div>}
                      <div className="flex-1 overflow-auto p-3 bg-[#1e1f22] select-text">
                        {responseTab === "base64" ? (
                          <div className="flex flex-col gap-3">
                            {extractedBase64.map(({ url, mimeType, kind }, index) => <figure key={index} className="min-w-0">
                              {kind === "image" && <img src={url} alt={`Base64 图片 ${index + 1}`} loading="lazy" className="max-w-full h-auto" />}
                              {kind === "video" && <video src={url} controls preload="none" className="max-w-full h-auto" />}
                              {kind === "audio" && <audio src={url} controls preload="none" className="max-w-full" />}
                              <figcaption className="mt-1 text-xs text-ide-accent break-all">
                                <a href={url} download={`response-${index + 1}`} >{mimeType} · 下载内容</a>
                              </figcaption>
                              <ResponseText content={url} className="mt-1 text-xs font-mono text-gray-400 whitespace-pre-wrap break-all select-text" />
                            </figure>)}
                            {!extractedBase64.length && <p className="text-xs text-gray-400">未识别到带 data: 前缀的 Base64 内容。</p>}
                          </div>
                        ) : responseTab === "urls" ? (
                          <div className="flex flex-col gap-3">
                            {extractedUrls.map(({ url, kind }, index) => <figure key={url} className="min-w-0">
                              {kind === "image" && <img src={url} alt={`Image ${index + 1}`} referrerPolicy="no-referrer" className="max-w-full h-auto" />}
                              {kind === "video" && <video src={url} controls preload="metadata" className="max-w-full h-auto" />}
                              <figcaption className="mt-1 text-xs text-ide-accent break-all"><a href={url} target="_blank" rel="noopener noreferrer">{url}</a></figcaption>
                            </figure>)}
                            {!extractedUrls.length && <p className="text-xs text-gray-400">未识别到 URL。</p>}

                          </div>
                        ) : responseTab === "extract" ? (
                          <pre className="text-xs font-mono text-gray-300 whitespace-pre-wrap break-words">{extraction.content || (!template.trim() ? "请填写提取模板。" : extraction.error ? "请修正提取模板。" : `未匹配到文本内容（${extraction.matches} 个节点）。`)}</pre>
                        ) : isImage && !responses[activeReq.id].truncated ? (
                          <img src={`data:${imageType};base64,${responses[activeReq.id].body}`} alt="HTTP 响应图片" className="max-w-full h-auto" />
                        ) : responses[activeReq.id].isBinary ? (
                          <div className="text-gray-500 italic text-xs">二进制数据 ({formatSize(responses[activeReq.id].sizeBytes)})</div>
                        ) : (
                          <ResponseText className="text-xs font-mono text-gray-300 whitespace-pre-wrap break-all" content={responses[activeReq.id].body} />
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 max-h-48 flex flex-col border border-ide-panel-border rounded overflow-hidden">
                      <div className="bg-ide-panel-bg px-3 py-1.5 text-xs font-semibold text-gray-400 border-b border-ide-panel-border shrink-0">Response Headers</div>
                      <div className="overflow-auto p-2 bg-[#1e1f22] select-text">
                        <table className="w-full text-xs text-left">
                          <tbody>
                            {responses[activeReq.id].headers.map(([k, v], i) => (
                              <tr key={i} className="border-b border-white/5 last:border-0">
                                <td className="py-1 pr-2 font-semibold text-gray-400 w-1/3 align-top break-all">{k}</td>
                                <td className="py-1 text-gray-300 break-all">{v}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}
                {!responses[activeReq.id] && !errors[activeReq.id] && !loading[activeReq.id] && (
                  <div className="text-gray-500 text-xs text-center mt-10">点击发送按钮执行请求</div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-500 text-xs">请在左侧选择一个请求</div>
          )}
        </div>
      </div>
    </div>
  );
});

export function HttpEditor({ tab, pane, active }: { tab: Tab; pane: "left" | "right"; active: boolean }) {
  const setFocusedPane = useWorkspaceStore(state => state.setFocusedPane);
  const setMode = useWorkspaceStore(state => state.setMarkdownMode);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [sourceWidth, setSourceWidth] = useState(50);
  const [resizing, setResizing] = useState(false);

  const mode: NonNullable<Tab["markdownMode"]> = tab?.markdownMode ?? "split";

  const resizeSplit = (clientX: number) => {
    const bounds = splitContainerRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 4) return;
    setSourceWidth(Math.max(20, Math.min(80, (clientX - bounds.left - 2) / (bounds.width - 4) * 100)));
  };

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col" onFocusCapture={() => setFocusedPane(pane)} onPointerDown={() => setFocusedPane(pane)}>
      <div className="markdown-toolbar" role="group" aria-label="HTTP 显示模式">
        {modes.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" aria-pressed={mode === id}
                  title={id === "preview" ? "图形化调试" : id === "split" ? "左源码，右调试" : "编辑 HTTP 源码"}
                  onClick={() => tab && setMode(tab.id, pane, id)}>
            <Icon size={14} aria-hidden="true" />{label}
          </button>
        ))}
      </div>
      <div ref={splitContainerRef} className="flex min-h-0 flex-1 overflow-hidden" style={resizing ? { cursor: "ew-resize", userSelect: "none" } : undefined}>
        <div className={`relative min-w-0 ${mode === "preview" ? "hidden" : mode === "split" ? "shrink-0" : "w-full"}`}
             style={mode === "split" ? { width: `calc((100% - 4px) * ${sourceWidth / 100})` } : undefined}>
          <CodeMirrorEditor pane={pane} tabId={tab.id} navigationEnabled={active && mode !== "preview"} />
        </div>
        {mode === "split" && <div
          role="separator" aria-label="调整源码与调试器宽度" aria-orientation="vertical"
          aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(sourceWidth)}
          tabIndex={0} title="拖动调整宽度，双击恢复均分"
          className="ide-resize-handle ide-resize-handle-x"
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing(true);
          }}
          onPointerMove={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeSplit(event.clientX);
          }}
          onPointerUp={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            setResizing(false);
          }}
          onPointerCancel={() => setResizing(false)}
          onLostPointerCapture={() => setResizing(false)}
          onDoubleClick={() => setSourceWidth(50)}
          onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            setSourceWidth(width => event.key === "Home" ? 20 : event.key === "End" ? 80 : Math.max(20, Math.min(80, width + (event.key === "ArrowLeft" ? -2 : 2))));
          }}
        />}
        {mode !== "source" && (
          <div className={`ide-content-surface min-w-0 overflow-hidden ${mode === "split" ? "flex-1" : "w-full"}`} tabIndex={0}>
            <HttpDebugger key={tab.path} filePath={tab.path} content={tab?.content ?? ""} />
          </div>
        )}
      </div>
    </div>
  );
}
