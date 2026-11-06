import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { homeDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Download, FolderOpen, Import, LoaderCircle, Search, Trash2, Video } from "lucide-react";
import { importMedia, importSummary } from "@/lib/mediaImport";
import { fsApi, videoApi, type LocalVideo, type VideoToolStatus } from "@/lib/api";
import { AssetVideo } from "@/components/editor/MarkdownEditor";
import { useVirtualList } from "@/hooks/useVirtualList";

const size = (value: number) => value > 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(0)} MB`;

export function VideoEditor({ active }: { active: boolean }) {
  const [videos, setVideos] = useState<LocalVideo[]>([]);
  const [current, setCurrent] = useState<LocalVideo | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLElement>(null);
  const [playRequest, setPlayRequest] = useState(0);
  const [query, setQuery] = useState("");
  const [destination, setDestination] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInFlight = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [toolStatus, setToolStatus] = useState<VideoToolStatus | null>(null);
  const refresh = useCallback(async () => {
    try { setVideos(await videoApi.local()); }
    catch (reason) { setMessage(String(reason)); setError(true); }
  }, []);
  useEffect(() => {
    void refresh();
    void homeDir().then(dir => join(dir, ".nexus", "video")).then(setDestination).catch(reason => {
      setMessage(String(reason)); setError(true);
    });
  }, [refresh]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const check = () => {
      void videoApi.status().then(status => {
        if (!disposed) setToolStatus(status);
      }).catch(() => { if (!disposed) setToolStatus(null); });
    };
    check();
    window.addEventListener("focus", check);
    return () => { disposed = true; window.removeEventListener("focus", check); };
  }, [active]);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term ? videos.filter(video => video.name.toLocaleLowerCase().includes(term)) : videos;
  }, [videos, query]);
  const videoWindow = useVirtualList(listRef, filtered.length, 58, active, query, 8);
  const selectedVideo = filtered.find(video => video.path === selection)
    ?? filtered.find(video => video.path === current?.path);
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!["ArrowUp", "ArrowDown", "Enter"].includes(event.key)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], [role="menuitem"]')) return;
      if (target?.closest("button, a, [role=button]") && !target.closest(".video-row-select")) return;
      if (!filtered.length) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter") {
        if (event.repeat) return;
        const video = selectedVideo ?? filtered[0];
        setSelection(video.path);
        if (current?.path === video.path) {
          const media = playerRef.current?.querySelector("video");
          if (media && !media.paused && !media.ended) media.pause();
          else setPlayRequest(request => request + 1);
        } else {
          setCurrent(video); setPlayRequest(request => request + 1);
        }
        return;
      }
      const index = filtered.findIndex(video => video.path === selectedVideo?.path);
      const nextIndex = index < 0 ? (event.key === "ArrowDown" ? 0 : filtered.length - 1)
        : Math.max(0, Math.min(filtered.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      setSelection(filtered[nextIndex].path);
      listRef.current?.focus({ preventScroll: true });
      videoWindow.scrollToIndex(nextIndex);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, filtered, selectedVideo, current, videoWindow.scrollToIndex]);
  const download = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setMessage(""); setError(false);
    try {
      const result = await videoApi.download(url, destination);
      setMessage(result); setUrl(""); await refresh();
    } catch (reason) {
      setMessage(String(reason).replace(/^Error: /, "")); setError(true);
    } finally { setBusy(false); }
  };
  const deleteVideo = async (video: LocalVideo) => {
    try {
      await fsApi.deleteEntry(video.path);
      if (current?.path === video.path) setCurrent(null);
      setMessage(`已删除：${video.name}`); setError(false);
      await refresh();
    } catch (reason) {
      setMessage(String(reason).replace(/^Error: /, "")); setError(true);
    }
  };
  const importFiles = async () => {
    if (importInFlight.current) return;
    importInFlight.current = true;
    setImporting(true);
    try {
      const result = await importMedia("video");
      if (!result) return;
      setMessage(importSummary(result)); setError(result.errors.length > 0);
      setQuery(""); await refresh();
    } catch (reason) { setMessage(String(reason)); setError(true); }
    finally { importInFlight.current = false; setImporting(false); }
  };
  return <div className={`music-page video-library absolute inset-0 bg-ide-bg text-gray-200 ${active ? "" : "hidden"}`}>
    <div className="video-library-layout">
      <aside className="video-list-panel">
        <div className="video-search-row">
          <form className="music-search-form" onSubmit={event => event.preventDefault()}>
            <Search size={15} className="shrink-0 text-gray-500" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索视频文件名" aria-label="搜索视频" />
          </form>
        </div>
        <div className="music-list-heading flex shrink-0 items-center justify-between gap-2 border-b border-ide-panel-border px-5">
          <div><h2>视频</h2><p>{query ? `找到 ${filtered.length} 个视频` : `${videos.length} 个视频`}</p></div>
          <button type="button" className="media-import-button" disabled={importing || busy} onClick={() => void importFiles()} title="复制视频到 ~/.nexus/video">{importing ? <LoaderCircle size={14} className="animate-spin" /> : <Import size={14} />}<span>{importing ? "正在导入…" : "导入视频"}</span></button>
        </div>
        <div className="video-list" ref={listRef} tabIndex={0} aria-label="视频列表">
          <div className="media-virtual-list" style={{ height: videoWindow.totalHeight }}>
          {filtered.slice(videoWindow.start, videoWindow.end).map((video, offset) => <div key={video.path} className="media-virtual-row" style={{ height: 58, transform: `translateY(${(videoWindow.start + offset) * 58}px)` }}><div className={`video-list-row ${current?.path === video.path ? "is-current" : ""} ${selectedVideo?.path === video.path ? "is-selected" : ""}`} onClick={event => {
            if ((event.target as Element).closest(".video-row-action")) return;
            setSelection(video.path); setCurrent(video); setPlayRequest(request => request + 1);
          }}>
            <button type="button" aria-label={`播放 ${video.name}`} aria-current={current?.path === video.path ? "true" : undefined} aria-pressed={selectedVideo?.path === video.path} className="video-row-select">
            <span className="video-thumb"><Video size={17} /></span>
            <span className="video-list-copy"><strong title={video.name}>{video.name}</strong><small>{size(video.size)}</small></span>
            </button>
            <button type="button" title="打开所在目录并选中视频文件" aria-label={`打开 ${video.name} 所在目录并选中视频文件`} className="video-row-action video-row-reveal" onClick={() => { void revealItemInDir(video.path).catch(reason => { setMessage(String(reason)); setError(true); }); }}><FolderOpen size={14} /></button>
            <button type="button" title={`删除 ${video.name}`} aria-label={`删除 ${video.name}`} className="video-row-action video-row-delete" onClick={() => void deleteVideo(video)}><Trash2 size={14} /></button>
          </div></div>)}
          </div>
          {!filtered.length && <div className="video-list-empty">
            <Video size={24} /><strong>{query ? "没有匹配的视频" : "视频库还是空的"}</strong>
            <span>{query ? "试试其他关键词" : "点击「导入视频」添加本地文件，或使用下方链接下载"}</span>
          </div>}
        </div>
        <footer className="video-library-footer">
          <form onSubmit={download} className="music-search-form video-url-form">
            <input type="text" required value={url} onChange={event => setUrl(event.target.value)} placeholder={toolStatus?.ytDlpAvailable ? "粘贴 YouTube、m3u8 或其他视频链接" : "粘贴视频链接或抖音分享文案"} aria-label="视频链接" aria-describedby="video-download-support" />
            <button type="submit" disabled={busy || importing || !destination}>
              {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Download size={14} />}下载
            </button>
          </form>
          <p id="video-download-support" className="video-download-support" role="status">
            {toolStatus?.ytDlpAvailable
              ? toolStatus.ffmpegAvailable
                ? "支持 YouTube、m3u8 等链接；已检测到 FFmpeg，优先下载独立音视频并合并"
                : "支持 YouTube、m3u8 等链接；未检测到 FFmpeg，仅下载自带音频的视频"
              : toolStatus
                ? "支持视频直链和抖音分享；安装 yt-dlp 可下载 YouTube、m3u8 等链接"
                : "可通过 yt-dlp 支持 YouTube、m3u8 等更多视频链接"}
          </p>
          {message && <p role={error ? "alert" : "status"} className={`music-message ${error ? "is-error" : ""}`}>{message}</p>}
          <div className="music-storage" title={destination || undefined}>
            <span className="music-storage-dot" />保存位置<p>~/.nexus/video</p>
          </div>
        </footer>
      </aside>
      <section className="video-view-panel" ref={playerRef} aria-label="视频播放器">
        {current && <AssetVideo source={current.path} note={current.path} alt={current.name} fit active={active} playRequest={playRequest} />}
      </section>
    </div>
  </div>;
}
