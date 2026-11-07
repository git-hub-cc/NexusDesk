import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { fsApi, type LocalHistoryEntry } from "@/lib/api";
import { flushPendingWrites, restoreLocalVersion, useWorkspaceStore } from "@/store/workspaceStore";
import { EditableGitDiff } from "./EditableGitDiff";
import { isBinaryAsset } from "@/lib/assets";

export function LocalHistoryDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const [entries, setEntries] = useState<LocalHistoryEntry[]>([]);
  const [selected, setSelected] = useState<number>();
  const [patch, setPatch] = useState("");
  const [contents, setContents] = useState<[string, string]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const writes = useRef(Promise.resolve());
  const load = async () => {
    if (isBinaryAsset(path)) throw new Error("二进制文件不支持本地文本历史");
    await flushPendingWrites();
    const items = await fsApi.localHistory(path);
    setEntries(items); setSelected(items[0]?.id);
  };
  useEffect(() => { let alive = true;
    void load().catch(e => { if (alive) setError(String(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; request.current++; };
  }, [path]);
  useEffect(() => {
    const token = ++request.current;
    setPatch(""); setContents(undefined); setLoading(true);
    if (isBinaryAsset(path)) { setLoading(false); return; }
    if (selected === undefined) { setLoading(false); return; }
    void Promise.all([fsApi.historyContent(path, selected), fsApi.readFile(path)])
      .then(async ([left, right]) => {
        const diff = await fsApi.compareText(left, right);
        if (token === request.current) { setPatch(diff); setContents([left, right]); }
      })
      .catch(e => { if (token === request.current) setError(String(e)); })
      .finally(() => { if (token === request.current) setLoading(false); });
    return () => { request.current++; };
  }, [path, selected]);
  const restore = async () => {
    if (selected === undefined || busy) return;
    setBusy(true); setError("");
    try {
      const content = await fsApi.historyContent(path, selected);
      await restoreLocalVersion(path, content);
      await load();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const handleChange = (newContent: string) => {
    const state = useWorkspaceStore.getState();
    const tab = [...state.leftTabs, ...state.rightTabs].find(t => t.path === path && !t.revision);
    if (tab) {
      const pane = state.leftTabs.some(t => t.id === tab.id) ? "left" : "right";
      state.updateTabContent(tab.id, newContent, pane);
    } else {
      // Serialize writes so an older edit cannot overwrite a newer one.
      writes.current = writes.current.then(() => fsApi.writeFile(path, newContent))
        .catch(e => setError(String(e)));
    }
  };

  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <Dialog.Content className="fixed inset-8 z-50 flex flex-col border border-ide-panel-border bg-ide-bg shadow-xl" aria-describedby="local-history-description">
        <div className="flex items-center gap-4 border-b border-ide-panel-border p-3 text-sm">
          <Dialog.Title>本地历史</Dialog.Title>
          <span className="flex-1 truncate" title={path}>{path}</span>
          <button disabled={selected === undefined || loading || busy} onClick={() => void restore()} className="disabled:opacity-40">恢复此版本</button>
          <Dialog.Close disabled={busy} aria-label="关闭">×</Dialog.Close>
        </div>
        <Dialog.Description id="local-history-description" className="px-3 py-2 text-xs text-gray-400">保留最近 30 天的保存记录。恢复时也会保留当前版本。</Dialog.Description>
        {error && <div role="alert" className="px-3 py-2 text-red-400">{error}</div>}
        <div className="flex min-h-0 flex-1">
          <div className="w-56 shrink-0 overflow-auto border-r border-ide-panel-border" aria-label="历史版本">
            {!entries.length && <p className="p-3 text-xs text-gray-400">{loading ? "正在加载…" : "暂无本地历史记录。"}</p>}
            {entries.map(entry => <button key={entry.id} disabled={busy} aria-pressed={selected === entry.id} onClick={() => { setError(""); setSelected(entry.id); }} className={`block w-full px-3 py-2 text-left text-xs ${selected === entry.id ? "bg-blue-500/20" : "hover:bg-white/5"}`}>
              {new Date(entry.created_at).toLocaleString()}<span className="ml-2 text-gray-500">#{entry.id}</span>
            </button>)}
          </div>
          <div className="relative min-w-0 flex-1">{loading ? <p className="p-4 text-sm">正在加载…</p> : <EditableGitDiff key={`${path}:${selected}`} path={path} patch={patch} contents={contents} title={path} labels={["历史版本", "当前文件"]} onChange={handleChange} />}</div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
