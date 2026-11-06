import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { codexProxyLaunchCommand, detectCodexProvider, startCodexProxy, stopCodexProxy, type ProxyInfo } from "@/lib/codexProxy";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useLayoutStore } from "@/store/layoutStore";

export function CodexProxyControls({ info, onChange }: { info: ProxyInfo | null; onChange: (info: ProxyInfo | null) => void }) {
  const [upstream, setUpstream] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [launched, setLaunched] = useState(false);
  const [detecting, setDetecting] = useState(true);
  useEffect(() => {
    let live = true;
    void detectCodexProvider().then(provider => { if (live && provider.upstreamUrl) setUpstream(provider.upstreamUrl); })
      .catch(error => { if (live) setError(`无法读取 Codex 配置：${String(error)}`); })
      .finally(() => { if (live) setDetecting(false); });
    return () => { live = false; };
  }, []);
  const stop = async () => {
    setBusy(true); setError("");
    try { await stopCodexProxy(); onChange(null); setLaunched(false); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  const launch = async () => {
    if (busy) return;
    const root = useWorkspaceStore.getState().rootPath;
    if (root?.startsWith("sftp://")) { setError("请在本机项目中启动捕获会话"); return; }
    setBusy(true); setError("");
    try {
      const capture = info?.running ? info : await startCodexProxy(upstream.trim());
      onChange(capture);
      if (!capture.providerId || !capture.proxyBaseUrl) {
        throw new Error("未找到可用的 Codex 模型提供商，请先完成 Codex 的模型提供商配置，再重试。");
      }
      const store = useTerminalStore.getState();
      if (await store.createSession({ id: "codex-capture", name: "Codex · 请求捕获", command: codexProxyLaunchCommand(capture.providerId, capture.proxyBaseUrl) }, root)) {
        useLayoutStore.getState().openBottomPanel("terminal");
        setLaunched(true);
      } else { setError(useTerminalStore.getState().launchError); }
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  return <div className="space-y-2 border-b border-ide-panel-border p-2 text-[11px]">
    {info?.running ? <>
      <div role="status" className="text-gray-400">捕获已就绪</div>
    </> : <>
      <input aria-label="Codex 上游 API 地址" placeholder="上游 API 地址，例如 https://example.com/v1" value={upstream} onChange={event => setUpstream(event.target.value)} spellCheck={false}
        className="w-full rounded border border-ide-panel-border bg-ide-bg px-1.5 py-1 outline-none focus:border-ide-accent" />
    </>}
    <button type="button" disabled={busy || detecting || (!info?.running && !upstream.trim()) || !isTauri()} onClick={() => void launch()}
      className="w-full rounded bg-ide-accent px-3 py-2 text-white disabled:opacity-50">
      {busy ? "正在处理…" : launched && info?.running ? "再启动一个捕获会话" : "启动捕获会话"}
    </button>
    {!isTauri() && <p className="text-gray-500">请在桌面应用中启动捕获会话。</p>}
    {info?.running && <details className="text-gray-500">
      <summary className="cursor-pointer">捕获设置</summary>
      <div className="mt-2 space-y-2 break-all">
        <p>API 地址：{info.upstreamUrl}</p>
        <p>停止捕获会中断捕获会话的后续请求。</p>
        <button type="button" disabled={busy} onClick={() => void stop()} className="text-gray-400 disabled:opacity-50">停止捕获</button>
      </div>
    </details>}
    {error && <p role="alert" className="break-all text-red-400">{error}</p>}
  </div>;
}
