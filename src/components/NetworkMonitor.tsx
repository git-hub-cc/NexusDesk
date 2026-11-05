import React, { useEffect, useRef, useState } from "react";
import { Activity, Trash2, Pause, Play, X } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { type NetworkRequest } from "@/lib/networkMonitor";
import { NetworkInspector } from "./NetworkInspector";
import { watchCodexProxy, type ProxyInfo } from "@/lib/codexProxy";
import { CodexProxyControls } from "./CodexProxyControls";

const size = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;

export const NetworkMonitor: React.FC = () => {
  const [items, setItems] = useState<NetworkRequest[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [selected, setSelected] = useState<NetworkRequest | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [proxyInfo, setProxyInfo] = useState<ProxyInfo | null>(null);
  const copyMessage = async (label: string, message: string) => {
    try { await navigator.clipboard.writeText(message); setCopyStatus(`${label}已复制`); }
    catch { setCopyStatus("复制失败，请选中报文手动复制"); }
  };
  useEffect(() => watchCodexProxy(item => {
    if (!pausedRef.current) {
      setItems(current => [item, ...current.filter(existing => existing.id !== item.id)].slice(0, 12));
      setSelected(current => current?.id === item.id ? item : current);
    }
  }, setProxyInfo), []);
  const visible = items;
  return <div className="group/panel flex flex-col h-full w-full bg-ide-panel-bg">
    <div className="flex items-center gap-1 px-2 py-1 border-b border-ide-panel-border text-xs font-semibold">
      <Activity size={14} /> 请求记录 <span className="text-gray-500 font-normal">({items.length})</span>
      <button type="button" title={paused ? "继续更新列表" : "暂停更新列表"} onClick={() => setPaused(value => !value)} className="ml-auto p-1 text-gray-400 hover:text-white">{paused ? <Play size={13} /> : <Pause size={13} />}</button>
      <button type="button" title="清空记录" onClick={() => { setItems([]); setSelected(null); }} className="p-1 text-gray-400 hover:text-white"><Trash2 size={13} /></button>
    </div>
    <CodexProxyControls info={proxyInfo} onChange={setProxyInfo} />
    <div className="flex-1 min-h-0 overflow-auto text-[11px]">
      <div className="grid min-w-[470px] whitespace-nowrap grid-cols-[42px_minmax(100px,1fr)_42px_80px_72px_72px] gap-1 px-2 py-2 text-gray-500 sticky top-0 bg-ide-panel-bg"><span>方法</span><span>URL</span><span>状态</span><span>耗时</span><span>请求</span><span>响应</span></div>
      {visible.map(item => <button type="button" key={item.id} title={item.url} onClick={() => { setSelected(item); setCopyStatus(""); }} aria-label={`查看请求详情 ${item.method} ${item.url}`} className={`grid w-full text-left min-w-[470px] whitespace-nowrap grid-cols-[42px_minmax(100px,1fr)_42px_80px_72px_72px] gap-1 items-center px-2 py-2 border-0 transition-colors hover:bg-ide-tab-hover focus-visible:outline focus-visible:outline-ide-accent ${selected?.id === item.id ? "bg-ide-selection" : ""}`}>
        <span className="text-blue-300">{item.method}</span><span className="truncate text-gray-300">{item.url}</span><span className={item.failed ? "text-red-400" : item.status && item.status >= 400 ? "text-amber-400" : "text-green-400"}>{item.status ?? (item.inFlight ? "…" : "ERR")}</span><span className="text-gray-400">{item.metricsUnavailable ? "--" : `${item.timeMs}ms`}</span><span className="text-gray-500">{item.metricsUnavailable ? "--" : size(item.requestBytes)}</span><span className="text-gray-500">{item.metricsUnavailable ? "--" : size(item.responseBytes)}</span>
      </button>)}
      {!visible.length && <div className="space-y-1 p-4 text-center text-gray-500">
        <p>{paused ? "列表更新已暂停" : proxyInfo?.running ? "等待捕获会话中的请求" : "尚未启动捕获会话"}</p>
        {!paused && <p>{proxyInfo?.running ? "启动捕获会话后，在终端向 Codex 发送消息，请求和响应将在这里显示。" : "点击上方“启动捕获会话”，开始记录 Codex 的请求和响应。"}</p>}
      </div>}
    </div>
    <Dialog.Root open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="search-overlay" />
        <Dialog.Content className="create-name-dialog network-detail-dialog flex flex-col gap-3 p-4" style={{ top: "5vh", width: "min(1100px, 94vw)", height: "90vh", maxHeight: "90vh" }} onKeyDown={event => event.stopPropagation()} aria-describedby="network-detail-description">
          <div className="flex items-center justify-between gap-2 shrink-0">
            <Dialog.Title className="text-sm font-semibold">请求详情</Dialog.Title>
            <Dialog.Close aria-label="关闭请求详情" className="p-1 text-gray-400 hover:text-white"><X size={16} /></Dialog.Close>
          </div>
          <Dialog.Description id="network-detail-description" className="text-xs text-gray-400 shrink-0">
            {selected && <span className="block break-all text-gray-200">{selected.source === "codex" ? "Codex · " : ""}{selected.method} {selected.url} · {selected.status ?? "ERR"} · {selected.metricsUnavailable ? "耗时未记录" : `${selected.timeMs} ms`}</span>}
            来源：Codex 捕获会话。显示请求正文与响应流，认证头已脱敏；正文中的加密字段保留原值。
            {selected?.truncated && <span className="block text-amber-400">正文超过 16 MiB，面板显示已截断；转发内容不受影响。</span>}
            {selected?.inFlight && <span className="block text-ide-accent">正在接收响应，报文持续更新…</span>}
          </Dialog.Description>
          {selected && <NetworkInspector key={selected.id} item={selected} copy={(label, text) => void copyMessage(label, text)} />}
          <div role="status" className="text-xs text-gray-400 shrink-0 min-h-4">{copyStatus}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
};
