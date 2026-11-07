import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { gitApi } from "@/lib/api";
import { GitDiffEditor } from "./GitDiffEditor";
import { isBinaryAsset } from "@/lib/assets";

type History = Awaited<ReturnType<typeof gitApi.pathHistory>>;

export function GitHistoryDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const [history, setHistory] = useState<History>();
  const [selected, setSelected] = useState("");
  const [file, setFile] = useState("");
  const [patch, setPatch] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState("");
  const [diffError, setDiffError] = useState("");
  const entry = history?.entries.find(item => item.commit.id === selected);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError("");
    void gitApi.pathHistory(path, limit).then(result => {
      if (!alive) return;
      setHistory(result);
      setSelected(previous => result.entries.some(item => item.commit.id === previous) ? previous : result.entries[0]?.commit.id ?? "");
    }).catch(e => { if (alive) setError(String(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path, limit]);
  useEffect(() => { setFile(entry?.changes[0]?.path ?? ""); }, [entry]);
  useEffect(() => {
    let alive = true;
    setPatch(""); setDiffError("");
    if (!history || !selected || !file) { setDiffLoading(false); return; }
    setDiffLoading(true);
    if (isBinaryAsset(file)) { setPatch("Binary files are not shown as text"); setDiffLoading(false); return; }
    void gitApi.revisionDiff(history.root, selected, file).then(value => { if (alive) setPatch(value); })
      .catch(e => { if (alive) setDiffError(String(e)); }).finally(() => { if (alive) setDiffLoading(false); });
    return () => { alive = false; };
  }, [history, selected, file]);
  const filtered = history?.entries.filter(({ commit }) => `${commit.id} ${commit.author} ${commit.message}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <Dialog.Content className="fixed inset-8 z-50 flex flex-col border border-ide-panel-border bg-ide-bg shadow-xl" aria-describedby="git-history-description">
        <div className="flex items-center gap-4 p-3 border-b border-ide-panel-border text-sm">
          <Dialog.Title className="shrink-0">Git 历史</Dialog.Title>
          <span className="truncate flex-1" title={path}>{path}</span>
          <Dialog.Close aria-label="关闭">×</Dialog.Close>
        </div>
        <Dialog.Description id="git-history-description" className="px-3 py-2 text-xs text-gray-400">当前分支中影响所选路径的提交 · 选择提交和文件查看与父提交的差异 · F7 / Shift+F7 跳转差异</Dialog.Description>
        {error && <p role="alert" className="p-3 text-red-400">{error}</p>}
        <div className="flex min-h-0 flex-1">
          <div className="w-56 shrink-0 min-h-0 flex flex-col border-r border-ide-panel-border">
            <input aria-label="搜索提交" placeholder="搜索提交、作者或哈希…" value={query} onChange={e => setQuery(e.target.value)} className="m-2 min-w-0 p-2 bg-ide-bg border border-ide-panel-border text-xs focus:outline-none" />
            <div className="min-h-0 flex-1 overflow-auto" aria-label="提交历史">
              {filtered.map(({ commit }) => <button key={commit.id} aria-pressed={commit.id === selected} onClick={() => setSelected(commit.id)} className={`block w-full px-3 py-2 text-left text-xs ${commit.id === selected ? "bg-blue-500/20" : "hover:bg-white/5"}`}>
                <div className="truncate" title={commit.message}>{commit.message.split("\n")[0]}</div>
                <div className="mt-1 truncate text-gray-400" title={commit.author}>{commit.author}<span className="ml-2 text-gray-500">{commit.id.slice(0, 8)}</span></div>
                <div className="mt-1 text-gray-500">{new Date(commit.time * 1000).toLocaleString()}</div>
              </button>)}
              {!filtered.length && !loading && !error && <p className="p-3 text-xs text-gray-400">{query ? "没有匹配的提交" : "暂无影响此路径的 Git 提交"}</p>}
              {loading && <p role="status" className="p-3 text-xs">正在加载…</p>}
            </div>
            {!!history?.entries.length && history.entries.length >= limit && limit < 2000 && <button disabled={loading} onClick={() => setLimit(value => value + 100)} className="p-2 text-xs disabled:opacity-40">加载更多</button>}
          </div>
          <div className="flex flex-col flex-1 min-w-0">
            {entry && <>
              <div className="p-3 text-xs border-b border-ide-panel-border max-h-32 overflow-auto whitespace-pre-wrap select-text">{entry.commit.message}<div className="mt-2 text-gray-400">{entry.commit.id}</div></div>
              <div className="max-h-32 overflow-auto border-b border-ide-panel-border" aria-label="受影响文件">{entry.changes.map(change => <button key={change.path} aria-pressed={file === change.path} onClick={() => setFile(change.path)} className={`block w-full text-left px-3 py-1 text-xs ${file === change.path ? "bg-blue-500/20" : "hover:bg-white/5"}`}><span className="mr-3 text-gray-400">{change.status}</span>{change.path}</button>)}</div>
            </>}
            <div className="relative flex-1 min-h-0">
              {diffError ? <p role="alert" className="p-3 text-red-400">{diffError}</p> : diffLoading ? <p role="status" className="p-3 text-xs">正在加载差异…</p> : file && entry ? <GitDiffEditor key={`${selected}:${file}`} patch={patch} title={file} staged={false} labels={[entry.commit.parents[0]?.slice(0, 8) ?? "空版本", selected.slice(0, 8)]} /> : <p className="p-4 text-xs text-gray-400">选择提交查看差异</p>}
            </div>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
