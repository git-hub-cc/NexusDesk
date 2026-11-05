import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "@/store/workspaceStore";
import { useDiffSplit } from "./useDiffSplit";

export function GitImageDiffEditor({ tab }: { tab: Tab }) {
  const { splitStyle, splitHandle } = useDiffSplit();
  const [images, setImages] = useState<(string | null)[] | null>(null);
  const [error, setError] = useState("");
  const comparison = tab.imageDiff!;
  useEffect(() => {
    let disposed = false;
    const urls: string[] = [];
    setImages(null); setError("");
    const ext = tab.path.split(".").pop()?.toLowerCase();
    const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : ext === "ico" ? "image/x-icon" : `image/${ext}`;
    void invoke<[number[] | null, number[] | null]>("get_git_image_diff", {
      repoPath: comparison.repoPath, path: tab.path, staged: comparison.staged, commitId: comparison.commitId ?? null,
    }).then(pair => {
      if (disposed) return;
      setImages(pair.map(bytes => {
        if (bytes === null) return null;
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
        urls.push(url); return url;
      }));
    }).catch(error => { if (!disposed) setError(String(error)); });
    return () => { disposed = true; urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [tab.path, comparison.repoPath, comparison.staged, comparison.commitId]);
  const labels = tab.diffLabels ?? (comparison.staged ? ["HEAD · 修改前", "暂存区 · 修改后"] : ["暂存区 · 修改前", "工作区 · 修改后"]);
  return <div tabIndex={-1} style={splitStyle} className="git-image-diff-editor absolute inset-0 flex min-h-0 flex-col outline-none focus:outline-none">
    <div className="border-b border-ide-panel-border px-3 py-2 text-xs text-gray-400 truncate" title={tab.path}>{tab.title}</div>
    {error ? <div role="alert" className="p-4 text-red-400 text-sm">{error}</div>
      : !images ? <div role="status" className="p-4 text-gray-400 text-sm">正在加载图片对比…</div>
      : <div className="git-diff-panes">
        {images.map((url, index) => <section key={index} aria-label={labels[index]}
          className="flex min-w-0 min-h-0 flex-col">
          <div className={`px-3 py-2 text-xs border-b border-ide-panel-border ${index === 0 ? "text-red-400" : "text-green-400"}`}>{labels[index]}</div>
          <div className="flex-1 min-h-0 overflow-auto p-4" style={{ background: "repeating-conic-gradient(#2b2d30 0% 25%, #3c3f41 0% 50%) 0 / 16px 16px" }}>
            {url ? <DiffImage url={url} label={labels[index]} />
              : <div className="h-full flex items-center justify-center text-sm text-gray-400">{index === 0 ? "无图片（新增文件）" : "无图片（文件已删除）"}</div>}
          </div>
        </section>)}
        {splitHandle}
      </div>}
  </div>;
}

function DiffImage({ url, label }: { url: string; label: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <div role="alert" className="text-sm text-red-400">图片加载失败</div>
    : <img src={url} alt={label} className="block max-w-full h-auto mx-auto" onError={() => setFailed(true)} />;
}
