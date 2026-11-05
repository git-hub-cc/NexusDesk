import { useEffect, useMemo, useState } from "react";
import { Code, Globe, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { type Tab, useWorkspaceStore } from "@/store/workspaceStore";
import { CodeMirrorEditor } from "./CodeMirrorEditor";

export function HtmlEditor({ tab, pane, active }: { tab: Tab; pane: "left" | "right"; active: boolean }) {
  const [mode, setMode] = useState<"text" | "deploy">("text");
  const [version, setVersion] = useState(0);
  const setFocusedPane = useWorkspaceStore(state => state.setFocusedPane);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const directories = useMemo(() => {
    const result: string[] = [];
    let directory = tab.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
    while (directory) {
      result.push(/^[A-Za-z]:$/.test(directory) ? directory + "/" : directory);
      const index = directory.lastIndexOf("/");
      if (index < 0) break;
      const parent = directory.slice(0, index);
      if (!parent) { result.push("/"); break; }
      if (directory.startsWith("//") && parent.split("/").filter(Boolean).length < 2) break;
      directory = parent;
    }
    return result;
  }, [tab.path]);
  const root = tab.htmlRoot && directories.includes(tab.htmlRoot) ? tab.htmlRoot : directories[0];
  const setRoot = (htmlRoot: string) => {
    useWorkspaceStore.setState(state => pane === "left"
      ? { leftTabs: state.leftTabs.map(t => t.id === tab.id ? { ...t, htmlRoot } : t) }
      : { rightTabs: state.rightTabs.map(t => t.id === tab.id ? { ...t, htmlRoot } : t) });
  };
  useEffect(() => {
    if (mode !== "deploy") return;
    let disposed = false;
    let port: number | undefined;
    const stop = (port: number) => { void invoke("stop_html_preview", { port }).catch(console.error); };
    setUrl(""); setError("");
    void invoke<string>("start_html_preview", { root, path: tab.path, content: tab.content ?? "" }).then(url => {
      port = Number(new URL(url).port);
      if (disposed) stop(port); else setUrl(url);
    }).catch(error => { if (!disposed) setError(String(error)); });
    return () => { disposed = true; if (port !== undefined) stop(port); };
  }, [mode, root, tab.path, tab.content, version]);

  return <div className="absolute inset-0 flex min-h-0 flex-col"
    onFocusCapture={() => setFocusedPane(pane)} onPointerDown={() => setFocusedPane(pane)}>
    <div className="markdown-toolbar flex-wrap items-center" role="group" aria-label="HTML 显示模式">
      <button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")}>
        <Code size={14} aria-hidden="true" />文本
      </button>
      <button type="button" aria-pressed={mode === "deploy"} onClick={() => setMode("deploy")}>
        <Globe size={14} aria-hidden="true" />部署
      </button>
      {mode === "deploy" && <label className="flex min-w-0 items-center gap-2 text-xs text-gray-400">根目录
        <select aria-label="部署根目录" value={root} title={root}
          className="min-w-0 max-w-80 rounded border border-ide-panel-border bg-ide-bg px-2 py-1 outline-none focus:border-ide-accent"
          onChange={event => setRoot(event.target.value)}>
          {directories.map((directory, level) => <option key={directory} value={directory}>
            {level === 0 ? "当前目录" : `上 ${level} 级`} · {directory}
          </option>)}
        </select>
      </label>}
      {mode === "deploy" && <button type="button" title="重新加载网页" onClick={() => setVersion(value => value + 1)}>
        <RefreshCw size={14} aria-hidden="true" />刷新
      </button>}
    </div>
    <div className="relative flex-1 min-h-0">
      <div className={`absolute inset-0 ${mode === "text" ? "" : "hidden"}`}>
        <CodeMirrorEditor pane={pane} tabId={tab.id} navigationEnabled={active && mode === "text"} />
      </div>
      {mode === "deploy" && (error ? <div role="alert" className="p-4 text-sm text-red-400">{error}</div>
        : url ? <iframe title={`HTML 部署：${tab.title}`} className="absolute inset-0 h-full w-full border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads" src={url} />
        : <div role="status" className="p-4 text-sm text-gray-400">正在部署…</div>)}
    </div>
  </div>;
}
