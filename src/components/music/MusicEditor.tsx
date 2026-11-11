import { settingsStorage } from "@/lib/globalSettings";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { CircleCheck, Download, FolderOpen, Import, ListMusic, LoaderCircle, Music2, Pause, Play, Plus, Repeat, Repeat1, Search, Shuffle, SkipBack, SkipForward, Volume2, Volume1, VolumeX, Trash2, X, AlertTriangle } from "lucide-react";
import { musicApi, type MusicPlaylist, type MusicTrack } from "@/lib/api";
import { resolveGDStudioPlayUrl, searchGDStudio } from "@/lib/gdMusic";
import { rememberPlaylistTracks, removePlaylistTrack, resolvePlaylistTracks } from "@/lib/musicPlaylist";
import { importMedia, importSummary } from "@/lib/mediaImport";
import { useVirtualList } from "@/hooks/useVirtualList";
import { chorusRange, type MusicChorus } from "@/lib/musicChorus";

type LibraryTab = "online" | "local" | `playlist:${string}`;
const LIBRARY_TAB_KEY = "nexusdesk.music.libraryTab";
const PLAYBACK_MODES = [
  { id: "list", label: "列表循环", Icon: Repeat },
  { id: "single", label: "单曲循环", Icon: Repeat1 },
  { id: "shuffle", label: "随机播放", Icon: Shuffle },
] as const;
const SEARCH_PAGE_SIZE = 30;
const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function MusicEditor({ active }: { active: boolean }) {
  const audio = useRef<HTMLAudioElement>(null);
  const playbackRequest = useRef(0);
  const pendingChorusStart = useRef<MusicChorus | null>(null);
  const searchGeneration = useRef(0);
  const queueSearchTerm = useRef("");
  const pageRequest = useRef<number | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const downloadRequests = useRef(new Set<string>());
  const [coverFailed, setCoverFailed] = useState(false);
  const [onlineCover, setOnlineCover] = useState<{ id: string; url: string } | null>(null);
  const [query, setQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [localSearchTerm, setLocalSearchTerm] = useState("");
  const [pageError, setPageError] = useState("");
  const [tab, updateTab] = useState<LibraryTab>("online");
  const tabSelected = useRef(false);
  const setTab = (next: LibraryTab) => {
    tabSelected.current = true;
    updateTab(next);
    try { settingsStorage.setItem(LIBRARY_TAB_KEY, next); } catch { /* Storage may be unavailable. */ }
  };
  const [results, setResults] = useState<MusicTrack[]>([]);
  const [localTracks, setLocalTracks] = useState<MusicTrack[]>([]);
  const [playlists, setPlaylists] = useState<MusicPlaylist[]>([]);
  const [playlistDialogOpen, setPlaylistDialogOpen] = useState(false);
  const [playlistName, setPlaylistName] = useState("");
  const [confirmDialog, setConfirmDialog] = useState<{ kind: "track"; track: MusicTrack } | { kind: "playlist"; playlist: MusicPlaylist } | null>(null);
  const [current, setCurrent] = useState<MusicTrack | null>(null);
  const [selection, setSelection] = useState<{ tab: LibraryTab; id: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [modeIndex, setModeIndex] = useState(0);
  const playbackMode = PLAYBACK_MODES[modeIndex];
  const ModeIcon = playbackMode.Icon;
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [chorus, setChorus] = useState<MusicChorus | null>(null);
  const [volume, setVolume] = useState(0.75);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [searchOffset, setSearchOffset] = useState(0);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importing, setImporting] = useState(false);
  const importInFlight = useRef(false);
  const [queueTracks, setQueueTracks] = useState<MusicTrack[]>([]);
  const [queueSource, setQueueSource] = useState<LibraryTab>("online");

  const downloadedIds = useMemo(() => new Set(localTracks.map(track => track.id)), [localTracks]);
  const selectedPlaylist = tab.startsWith("playlist:") ? playlists.find(item => item.id === tab.slice(9)) : undefined;

  const refreshLocal = async () => {
    try { setLocalTracks(await musicApi.local()); }
    catch (reason) { setError(String(reason)); }
  };

  const importFiles = async () => {
    if (importInFlight.current) return;
    importInFlight.current = true;
    setImporting(true);
    try {
      const result = await importMedia("music");
      if (!result) return;
      setError(""); setNotice("");
      const tracks = await musicApi.local();
      setLocalTracks(tracks);
      setTab("local"); setQuery(""); setLocalSearchTerm("");
      setNotice(importSummary(result));
    } catch (reason) { setError(String(reason)); }
    finally { importInFlight.current = false; setImporting(false); }
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([musicApi.local(), musicApi.playlists()]).then(([tracksResult, playlistsResult]) => {
      if (cancelled) return;
      const tracks = tracksResult.status === "fulfilled" ? tracksResult.value : [];
      const savedLists = playlistsResult.status === "fulfilled" ? playlistsResult.value : [];
      const lists = rememberPlaylistTracks(savedLists, tracks);
      setLocalTracks(tracks);
      setPlaylists(lists);
      if (JSON.stringify(lists) !== JSON.stringify(savedLists)) {
        void musicApi.savePlaylists(lists).catch(reason => { if (!cancelled) setError(String(reason)); });
      }
      for (const result of [tracksResult, playlistsResult]) {
        if (result.status === "rejected") setError(String(result.reason));
      }
      if (tabSelected.current) return;
      let saved: string | null = null;
      try { saved = settingsStorage.getItem(LIBRARY_TAB_KEY); } catch { /* Use the default view. */ }
      const fallback = tracks.length ? "local" : "online";
      updateTab(saved === "local" || saved === "online" ? saved
        : saved?.startsWith("playlist:") && lists.some(playlist => playlist.id === saved.slice(9))
          ? saved as LibraryTab : fallback);
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!audio.current) return;
    audio.current.volume = volume;
  }, [volume]);


  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    const term = query.trim();
    if (tab === "local") {
      setLocalSearchTerm(term);
      setError(""); setNotice("");
      if (trackListRef.current) trackListRef.current.scrollTop = 0;
      return;
    }
    if (!term) return;
    const generation = ++searchGeneration.current;
    pageRequest.current = null;
    setLoadingMore(false); setPageError(""); setSearchTerm(term);
    if (trackListRef.current) trackListRef.current.scrollTop = 0;
    setBusy(true); setError(""); setNotice("");
    setLoadingMore(false);
    setResults([]); setSearchOffset(0); setHasMore(false);
    try {
      const page = await searchGDStudio(term, 0);
      if (generation !== searchGeneration.current) return;
      setResults(page); setSearchOffset(page.length); setHasMore(page.length === SEARCH_PAGE_SIZE);
    }
    catch (reason) { if (generation === searchGeneration.current) { setError(String(reason)); setResults([]); } }
    finally { if (generation === searchGeneration.current) setBusy(false); }
  };

  const loadMore = useCallback(async () => {
    if (!active || tab !== "online" || busy || pageRequest.current !== null || !hasMore || !searchTerm) return;
    const generation = searchGeneration.current;
    pageRequest.current = generation;
    setLoadingMore(true); setPageError("");
    try {
      const page = await searchGDStudio(searchTerm, searchOffset);
      if (generation !== searchGeneration.current) return;
      const ids = new Set(results.map(track => track.id));
      const additions = page.filter(track => { if (ids.has(track.id)) return false; ids.add(track.id); return true; });
      setResults(previous => [...previous, ...additions]);
      if (queueSource === "online" && queueSearchTerm.current === searchTerm) setQueueTracks(previous => previous.length ? [...previous, ...additions.filter(track => !previous.some(item => item.id === track.id))] : previous);
      setSearchOffset(offset => offset + page.length);
      setHasMore(page.length === SEARCH_PAGE_SIZE && additions.length > 0);
    } catch (reason) { if (generation === searchGeneration.current) setPageError(String(reason)); }
    finally { if (generation === searchGeneration.current) { pageRequest.current = null; setLoadingMore(false); } }
  }, [active, tab, busy, hasMore, searchTerm, searchOffset, results, queueSource]);

  useEffect(() => {
    if (!active || tab !== "online" || busy || loadingMore || !hasMore || pageError) return;
    const target = loadMoreRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { root: trackListRef.current, rootMargin: "0px 0px 240px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [active, tab, busy, loadingMore, hasMore, pageError, loadMore]);

  useEffect(() => { setCoverFailed(false); }, [current?.id, current?.coverPath]);
  useEffect(() => {
    if (!current || current.coverPath || !/^\d+$/.test(current.id)) return;
    let cancelled = false;
    void musicApi.coverUrl(current.id).then(url => {
      if (!cancelled && url) { setOnlineCover({ id: current.id, url }); setCoverFailed(false); }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [current?.id, current?.coverPath]);
  useEffect(() => () => { playbackRequest.current++; }, []);
  const trackListRef = useRef<HTMLDivElement>(null);

  const playTrack = async (track: MusicTrack, queue: MusicTrack[], source: LibraryTab = tab) => {
    if (!audio.current) return;
    const request = ++playbackRequest.current;
    pendingChorusStart.current = null;
    setChorus(null);
    audio.current.pause();
    audio.current.removeAttribute("src");
    audio.current.load();
    setQueueTracks(queue);
    setQueueSource(source);
    if (queue !== queueTracks) queueSearchTerm.current = searchTerm;
    setCurrent(track);
    setSelection(null);
    setPosition(0); setDuration(track.duration / 1000 || 0);
    try {
      const saved = track.path ? track : localTracks.find(item => item.id === track.id);
      const [playUrl, nextChorus] = await Promise.all([
        saved?.path ? Promise.resolve(convertFileSrc(saved.path)) : resolveGDStudioPlayUrl(track.id),
        saved?.path || source === "local" ? Promise.resolve(null) : musicApi.chorus(track.id),
      ]);
      if (request !== playbackRequest.current) return;
      if (saved?.path) setCurrent({ ...track, ...saved });
      setChorus(nextChorus);
      // 等实际时长加载后再定位，避免试听音源的时长小于副歌起点。
      pendingChorusStart.current = source === "online" ? nextChorus : null;
      audio.current.src = playUrl;
      await audio.current.play();
      if (request === playbackRequest.current) { setPlaying(true); setError(""); }
    } catch (reason) {
      if (request === playbackRequest.current) { setPlaying(false); setError(reason instanceof Error ? reason.message : "播放失败，请检查网络或尝试其他歌曲"); }
    }
  };

  const handleLoadedMetadata = (event: React.SyntheticEvent<HTMLAudioElement>) => {
    const player = event.currentTarget;
    const range = chorusRange(pendingChorusStart.current, player.duration);
    pendingChorusStart.current = null;
    if (range) { player.currentTime = range.start; setPosition(range.start); }
  };

  const seekTo = (next: number) => {
    pendingChorusStart.current = null;
    setPosition(next);
    if (audio.current) audio.current.currentTime = next;
  };

  const handleProgressPointerUp = (event: React.PointerEvent<HTMLInputElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    const range = chorusRange(chorus, duration);
    if (!range) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 8) return;
    // 以屏幕像素判断附近范围，保持不同曲长和窗口宽度下的点击手感一致。
    const startX = bounds.left + 4 + (bounds.width - 8) * range.start / duration;
    if (Math.abs(event.clientX - startX) <= 12) seekTo(range.start);
  };

  const togglePlayback = async () => {
    if (!audio.current || !current) return;
    if (audio.current.paused) {
      try { await audio.current.play(); setPlaying(true); }
      catch { setError("无法播放当前歌曲"); }
    } else { audio.current.pause(); setPlaying(false); }
  };

  const playNext = (direction: -1 | 1) => {
    if (!queueTracks.length || !current) return;
    const playable = queueTracks.filter(track => queueSource !== "local" || downloadedIds.has(track.id));
    if (!playable.length) { setPlaying(false); return; }
    const index = playable.findIndex(track => track.id === current.id);
    const candidates = playable.filter(track => track.id !== current.id);
    const next = playbackMode.id === "shuffle" && candidates.length
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : playable[(Math.max(index, 0) + direction + playable.length) % playable.length];
    if (next) void playTrack(next, queueTracks, queueSource);
  };

  const persistPlaylists = async (next: MusicPlaylist[]) => {
    const remembered = rememberPlaylistTracks(next, localTracks);
    await musicApi.savePlaylists(remembered);
    setPlaylists(remembered);
  };
  const createPlaylist = async () => {
    const name = playlistName.trim();
    if (!name) return;
    const playlist = { id: crypto.randomUUID(), name, trackIds: [] };
    try { await persistPlaylists([...playlists, playlist]); setTab(`playlist:${playlist.id}`); setQuery(""); setPlaylistName(""); setPlaylistDialogOpen(false); }
    catch (reason) { setError(String(reason)); }
  };
  const addToPlaylist = async (track: MusicTrack, playlist: MusicPlaylist) => {
    if (playlist.trackIds.includes(track.id)) return;
    try { await persistPlaylists(playlists.map(item => item.id === playlist.id ? { ...item, trackIds: [...item.trackIds, track.id] } : item)); setNotice(`已加入歌单：${playlist.name}`); }
    catch (reason) { setError(String(reason)); }
  };
  const removeFromPlaylist = async (track: MusicTrack, playlist: MusicPlaylist) => {
    try {
      await persistPlaylists(playlists.map(item => item.id === playlist.id
        ? removePlaylistTrack(item, track.id) : item));
      setNotice(`已从歌单“${playlist.name}”移除：${track.title}`);
    } catch (reason) { setError(String(reason)); }
  };
  const removeTrack = async (track: MusicTrack) => {
    try {
      if (playlists.some(playlist => playlist.trackIds.includes(track.id))) await persistPlaylists(playlists);
      await musicApi.deleteLocal(track.id);
      await refreshLocal();
      if (current?.id === track.id) { playbackRequest.current++; pendingChorusStart.current = null; setChorus(null); audio.current?.pause(); audio.current?.removeAttribute("src"); setCurrent(null); setPlaying(false); }
      setNotice(`已删除：${track.title}`);
    } catch (reason) { setError(String(reason)); }
  };
  const removePlaylist = async (playlist: MusicPlaylist) => {
    try {
      await persistPlaylists(playlists.filter(item => item.id !== playlist.id));
      if (tab === `playlist:${playlist.id}`) setTab("local");
    } catch (reason) { setError(String(reason)); }
  };

  const download = async (track: MusicTrack) => {
    if (downloadRequests.current.has(track.id) || downloadedIds.has(track.id)) return;
    downloadRequests.current.add(track.id);
    setDownloading(new Set(downloadRequests.current)); setError(""); setNotice("");
    try {
      const saved = await musicApi.download(track);
      await refreshLocal();
      setCurrent(value => value?.id === saved.id ? { ...value, ...saved } : value);
      setNotice(`已保存到本地曲库：${saved.title}`);
    } catch (reason) { setError(String(reason)); }
    finally { downloadRequests.current.delete(track.id); setDownloading(new Set(downloadRequests.current)); }
  };

  const filteredLocalTracks = useMemo(() => {
    const term = localSearchTerm.toLocaleLowerCase();
    return term ? localTracks.filter(track => [track.title, track.artist, track.album].some(value => value.toLocaleLowerCase().includes(term))) : localTracks;
  }, [localTracks, localSearchTerm]);
  const playlistTracks = useMemo(() => {
    return selectedPlaylist ? resolvePlaylistTracks(selectedPlaylist, localTracks) : [];
  }, [selectedPlaylist, localTracks]);
  const visibleTracks = tab === "online" ? results : tab === "local" ? filteredLocalTracks : playlistTracks;
  const trackWindow = useVirtualList(trackListRef, visibleTracks.length, 60, active, `${tab}:${tab === "local" ? localSearchTerm : searchTerm}`);
  const searching = tab === "online" && busy;
  const selectedTrack = visibleTracks.find(track => selection?.tab === tab && track.id === selection.id)
    ?? visibleTracks.find(track => track.id === current?.id);
  const coverSource = current?.coverPath ? convertFileSrc(current.coverPath) : onlineCover?.id === current?.id ? onlineCover?.url : undefined;
  const VolumeIcon = volume === 0 ? VolumeX : volume < .5 ? Volume1 : Volume2;
  const progressPercent = duration ? Math.min(100, position / duration * 100) : 0;
  const highlightedChorus = chorusRange(chorus, duration);
  const chorusLabel = highlightedChorus ? `副歌 ${formatTime(highlightedChorus.start)}–${formatTime(highlightedChorus.end)}` : undefined;

  useEffect(() => {
    if (!active || playlistDialogOpen || confirmDialog || searching) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!["ArrowUp", "ArrowDown", "Enter"].includes(event.key)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], [role="menuitem"]')) return;
      if (target?.closest("button, a, [role=button]") && !target.closest(".music-track-index, .music-track-main")) return;
      const playable = visibleTracks.filter(track => !tab.startsWith("playlist:") || downloadedIds.has(track.id));
      if (!playable.length) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter") {
        if (event.repeat) return;
        const track = playable.find(item => item.id === selectedTrack?.id) ?? playable[0];
        setSelection({ tab, id: track.id });
        if (track.id === current?.id) void togglePlayback();
        else void playTrack(track, visibleTracks, tab === "online" ? "online" : "local");
        return;
      }
      const index = playable.findIndex(track => track.id === selectedTrack?.id);
      const nextIndex = index < 0 ? (event.key === "ArrowDown" ? 0 : playable.length - 1)
        : Math.max(0, Math.min(playable.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      const track = playable[nextIndex];
      setSelection({ tab, id: track.id });
      trackListRef.current?.focus({ preventScroll: true });
      trackWindow.scrollToIndex(visibleTracks.indexOf(track));
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  return <div className={`music-page absolute inset-0 flex flex-col bg-ide-bg text-gray-200 ${active ? "" : "hidden"}`}>
    <audio ref={audio} loop={playbackMode.id === "single"} onLoadedMetadata={handleLoadedMetadata} onTimeUpdate={event => setPosition(event.currentTarget.currentTime)} onDurationChange={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => playNext(1)} onError={() => { if (current && audio.current?.src) { setPlaying(false); setError(`歌曲“${current.title}”加载失败，播放地址可能已失效或当前浏览器无法访问该音源`); } }} />
    <div className="music-search-row flex shrink-0 items-center gap-3 px-5 py-4">
      <form onSubmit={search} className="music-search-form min-w-0 flex-1">
        <Search size={16} className="shrink-0 text-gray-500" />
        <input value={query} onChange={event => { setQuery(event.target.value); if (tab === "local" && !event.target.value.trim()) setLocalSearchTerm(""); }} placeholder={tab === "local" ? "搜索本地歌曲、歌手或专辑" : "搜索歌曲、歌手或专辑"} aria-label={tab === "local" ? "搜索本地歌曲" : "搜索在线歌曲"} />
        <button type="submit" disabled={searching || (tab === "online" && !query.trim())}>{searching ? <LoaderCircle size={15} className="animate-spin" /> : <Search size={15} />}<span>搜索</span></button>
      </form>
      <button type="button" className="media-import-button" disabled={importing} onClick={() => void importFiles()} title="复制音乐到本地曲库，并自动导入源目录内的同名专辑封面">{importing ? <LoaderCircle size={15} className="animate-spin" /> : <Import size={15} />}<span>{importing ? "正在导入…" : "导入音乐"}</span></button>
    </div>

    <div className="music-body flex min-h-0 flex-1">
      <aside className="music-sidebar shrink-0 border-r border-ide-panel-border px-3 py-3">
        <div className="music-section-label px-2">曲库</div>
        <button type="button" className={`music-nav-item ${tab === "online" ? "is-active" : ""}`} onClick={() => setTab("online")}><Search size={15} /><span>在线搜索</span></button>
        <button type="button" className={`music-nav-item ${tab === "local" ? "is-active" : ""}`} onClick={() => setTab("local")}><ListMusic size={15} /><span>本地音乐</span><span className="music-count">{localTracks.length}</span></button>
        <div className="music-section-label pl-2 mt-5 flex items-center justify-between">歌单 <button type="button" title="新建歌单" aria-label="新建歌单" className="px-2 py-1 ml-auto shrink-0 hover:bg-white/10 rounded-sm flex items-center justify-center" onClick={() => setPlaylistDialogOpen(true)}><Plus size={14} /></button></div>
        {playlists.map(playlist => <ContextMenu.Root key={playlist.id}><ContextMenu.Trigger asChild><button type="button" className={`music-nav-item ${tab === `playlist:${playlist.id}` ? "is-active" : ""}`} onClick={() => { setTab(`playlist:${playlist.id}`); setQuery(""); }}><ListMusic size={15} /><span className="truncate">{playlist.name}</span><span className="music-count">{playlist.trackIds.length}</span></button></ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Content data-panel-menu className="music-context-menu"><ContextMenu.Item className="music-context-item is-danger" onSelect={() => setConfirmDialog({ kind: "playlist", playlist })}><Trash2 size={14} />删除歌单</ContextMenu.Item></ContextMenu.Content></ContextMenu.Portal></ContextMenu.Root>)}
        <div className="music-storage"><span className="music-storage-dot" />保存位置<p>~/.nexus/music</p></div>
      </aside>

      <section className="music-results flex min-h-0 min-w-0 flex-1 flex-col">
        {tab !== "online" && <div className="music-list-heading flex items-center justify-between border-b border-ide-panel-border px-5">
          <div><h2>{selectedPlaylist?.name ?? "本地曲库"}</h2><p>{selectedPlaylist ? `${playlistTracks.length} 首歌曲` : localSearchTerm ? `找到 ${filteredLocalTracks.length} 首歌曲，共 ${localTracks.length} 首本地歌曲` : `${localTracks.length} 首本地歌曲`}</p></div>
        </div>}
        <div className={`music-track-header ${tab === "local" ? "has-local-actions" : ""}`}><span>#</span><span>歌曲</span><span className="music-album-col">专辑</span><span>时长</span><span /></div>
        {error && <div role="alert" className="music-message is-error">{error}</div>}
        {notice && <div role="status" className="music-message">{notice}</div>}
        <div ref={trackListRef} tabIndex={0} aria-label="歌曲列表（上下键选择，回车播放或暂停）" className="music-track-list min-h-0 flex-1 overflow-y-auto" onScroll={event => {
          const element = event.currentTarget;
          if (!pageError && element.scrollHeight - element.scrollTop - element.clientHeight < 240) void loadMore();
        }}>
          {searching && <div className="music-empty"><LoaderCircle size={20} className="animate-spin" /><span>正在搜索…</span></div>}
          {!searching && <div className="media-virtual-list" style={{ height: trackWindow.totalHeight }}>
          {visibleTracks.slice(trackWindow.start, trackWindow.end).map((track, offset) => {
            const index = trackWindow.start + offset;
            const isCurrent = current?.id === track.id;
            const isLocal = tab === "local";
            const missing = tab.startsWith("playlist:") && !downloadedIds.has(track.id);
            return <div key={`${track.id}-${index}`} className="media-virtual-row" style={{ height: 60, transform: `translateY(${index * 60}px)` }}><ContextMenu.Root>
            <ContextMenu.Trigger asChild><div className={`music-track-row ${isLocal ? "has-local-actions" : ""} ${isCurrent ? "is-current" : ""} ${selectedTrack?.id === track.id ? "is-selected" : ""} ${missing ? "is-missing" : ""}`} onClick={event => {
              if (missing || (event.target as Element).closest(".music-row-action")) return;
              setSelection({ tab, id: track.id });
              trackListRef.current?.focus({ preventScroll: true });
              void playTrack(track, visibleTracks, tab === "online" ? "online" : "local");
            }}>
              <span className="music-track-index" aria-hidden="true">{isCurrent ? <span className={`music-playing-bars ${playing ? "" : "is-paused"}`}><i /><i /><i /></span> : <><span>{String(index + 1).padStart(2, "0")}</span><Play size={14} /></>}</span>
              <div className="music-track-main"><span className="music-row-cover">{track.coverPath ? <img src={convertFileSrc(track.coverPath)} alt="" /> : <Music2 size={14} />}</span><span className="music-row-copy"><strong>{track.title}</strong><span>{missing ? "本地文件已删除" : track.artist}</span></span></div>
              <span className="music-track-album music-album-col" title={track.album}>{track.album}</span>
              <span className="music-track-duration">{track.duration ? formatTime(track.duration / 1000) : "--:--"}</span>
              {isLocal ? <div className="music-row-actions"><button type="button" title="打开所在目录并选中音频文件" aria-label={`打开 ${track.title} 所在目录并选中音频文件`} className="music-row-action" disabled={!track.path} onClick={() => { if (track.path) void revealItemInDir(track.path).catch(reason => setError(String(reason))); }}><FolderOpen size={14} /></button><button type="button" title="删除歌曲" aria-label="删除歌曲" className="music-row-action" onClick={() => setConfirmDialog({ kind: "track", track })}><Trash2 size={14} /></button></div> : tab.startsWith("playlist:") ? <span className="music-local-mark">{missing ? "已删除" : "本地"}</span> : <button type="button" title={downloadedIds.has(track.id) ? "已下载" : "下载歌曲"} aria-label={downloadedIds.has(track.id) ? "已下载" : "下载歌曲"} className={`music-row-action ${downloadedIds.has(track.id) ? "is-done" : ""}`} disabled={downloading.has(track.id) || downloadedIds.has(track.id)} onClick={() => void download(track)}>{downloadedIds.has(track.id) ? <CircleCheck size={15} /> : downloading.has(track.id) ? <LoaderCircle size={15} className="animate-spin" /> : <Download size={15} />}</button>}
            </div></ContextMenu.Trigger>
            {(selectedPlaylist || (downloadedIds.has(track.id) && playlists.length > 0)) && <ContextMenu.Portal><ContextMenu.Content data-panel-menu className="music-context-menu" sideOffset={4}>
              {downloadedIds.has(track.id) && playlists.length > 0 && <><div className="music-context-label">加入歌单</div>{playlists.map(playlist => <ContextMenu.Item key={playlist.id} className="music-context-item" disabled={playlist.trackIds.includes(track.id)} onSelect={() => void addToPlaylist(track, playlist)}>{playlist.name}{playlist.trackIds.includes(track.id) ? "（已添加）" : ""}</ContextMenu.Item>)}{selectedPlaylist && <ContextMenu.Separator className="music-context-separator" />}</>}
              {selectedPlaylist && <ContextMenu.Item className="music-context-item" onSelect={() => void removeFromPlaylist(track, selectedPlaylist)}><X size={14} />{missing ? "删除记录" : "从歌单移除"}</ContextMenu.Item>}
            </ContextMenu.Content></ContextMenu.Portal>}
            </ContextMenu.Root></div>;
          })}</div>}
          {tab === "online" && hasMore && <div ref={loadMoreRef} className="music-load-more" style={{ minHeight: 1 }} />}
          {tab === "online" && pageError && <div role="alert" className="music-message is-error">{pageError} <button type="button" className="music-text-button" onClick={() => void loadMore()}>重试加载</button></div>}
          {tab === "online" && !busy && results.length > 0 && !hasMore && <div className="music-load-more">已加载全部歌曲</div>}
          {tab === "online" && loadingMore && <div className="music-load-more"><LoaderCircle size={15} className="animate-spin" />正在加载更多歌曲</div>}
          {!searching && !visibleTracks.length && <div className="music-empty"><Music2 size={25} /><strong>{tab === "online" ? "搜索你想听的歌曲" : localSearchTerm ? "没有找到匹配的本地歌曲" : "本地曲库还是空的"}</strong><span>{tab === "online" ? "在线找到歌曲后，可以下载并保存到本机" : localSearchTerm ? "尝试其他关键词，或清空搜索查看全部本地歌曲" : "点击「导入音乐」添加文件，自动匹配源目录中的同名图片作为专辑封面"}</span></div>}
        </div>
      </section>
    </div>

    <Dialog.Root open={playlistDialogOpen} onOpenChange={setPlaylistDialogOpen}>
      <Dialog.Portal><Dialog.Overlay className="search-overlay" /><Dialog.Content className="create-name-dialog music-form-dialog" onKeyDown={event => event.stopPropagation()} onOpenAutoFocus={event => { event.preventDefault(); document.getElementById("music-playlist-name")?.focus(); }}>
        <header className="flex items-center justify-between border-b border-ide-panel-border px-4 py-3"><Dialog.Title className="font-medium">新建歌单</Dialog.Title><Dialog.Close aria-label="关闭" className="rounded p-1 hover:bg-white/10"><X size={16} /></Dialog.Close></header>
        <form className="flex flex-col gap-3 p-4" onSubmit={event => { event.preventDefault(); void createPlaylist(); }}><Dialog.Description className="text-xs text-gray-400">创建一个歌单来整理本地歌曲。</Dialog.Description><label htmlFor="music-playlist-name" className="text-xs">歌单名称</label><input id="music-playlist-name" value={playlistName} onChange={event => setPlaylistName(event.target.value)} maxLength={60} autoComplete="off" className="w-full rounded border border-ide-panel-border bg-ide-bg px-3 py-2 outline-none focus:border-ide-accent" /><footer className="mt-2 flex justify-end gap-2"><Dialog.Close className="rounded border border-ide-panel-border px-4 py-1.5 hover:bg-white/10">取消</Dialog.Close><button type="submit" disabled={!playlistName.trim()} className="rounded bg-ide-accent px-4 py-1.5 text-white disabled:opacity-40">创建</button></footer></form>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    <Dialog.Root open={!!confirmDialog} onOpenChange={open => { if (!open) setConfirmDialog(null); }}>
      <Dialog.Portal><Dialog.Overlay className="search-overlay" /><Dialog.Content className="create-name-dialog delete-confirm-dialog" onKeyDown={event => event.stopPropagation()}>
        <header className="flex items-center gap-3 px-5 pt-5"><span className="delete-confirm-icon"><AlertTriangle size={20} /></span><Dialog.Title className="flex-1 font-medium text-base">{confirmDialog?.kind === "track" ? "删除本地歌曲" : "删除歌单"}</Dialog.Title><Dialog.Close aria-label="取消" className="rounded p-1 text-gray-400 hover:bg-white/10"><X size={16} /></Dialog.Close></header>
        <div className="px-5 py-4"><Dialog.Description className="text-xs leading-6 text-gray-400">{confirmDialog?.kind === "track" ? <>将从本地曲库删除“{confirmDialog.track.title}”。歌单中对应条目会保留为失效状态。</> : <>确定删除歌单“{confirmDialog?.kind === "playlist" ? confirmDialog.playlist.name : ""}”？其中的歌曲文件不会被删除。</>}</Dialog.Description></div>
        <footer className="flex justify-end gap-2 border-t border-ide-panel-border px-5 py-3"><Dialog.Close className="rounded border border-ide-panel-border px-4 py-1.5 hover:bg-white/10">取消</Dialog.Close><button type="button" className="delete-confirm-action" onClick={() => { const request = confirmDialog; setConfirmDialog(null); if (request?.kind === "track") void removeTrack(request.track); else if (request?.kind === "playlist") void removePlaylist(request.playlist); }}>删除</button></footer>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>

    <footer className="music-player shrink-0 border-t border-ide-panel-border">
      <div className="music-now-playing"><div className={`music-cover ${playing ? "is-playing" : ""}`}>{coverSource && current && !coverFailed ? <img src={coverSource} alt={current.album || current.title} onError={() => setCoverFailed(true)} /> : <Music2 size={22} />}</div><div className="min-w-0"><strong>{current?.title ?? "尚未播放"}</strong><span>{current?.artist ?? "从曲库选择一首歌曲"}</span></div></div>
      <div className="music-transport"><div className="music-transport-buttons"><button type="button" title={`${playbackMode.label}（点击切换播放模式）`} aria-label={`播放模式：${playbackMode.label}，点击切换`} onClick={() => setModeIndex(index => (index + 1) % PLAYBACK_MODES.length)}><ModeIcon size={16} /></button><button type="button" title="上一首" aria-label="上一首" onClick={() => playNext(-1)}><SkipBack size={16} /></button><button type="button" title={playing ? "暂停" : "播放"} aria-label={playing ? "暂停" : "播放"} className="music-play-button" onKeyDown={event => { if (event.code === "Space" || event.key === " ") event.preventDefault(); }} disabled={!current} onClick={() => void togglePlayback()}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><button type="button" title="下一首" aria-label="下一首" onClick={() => playNext(1)}><SkipForward size={16} /></button></div><div className="music-progress"><span>{formatTime(position)}</span><label className="music-range" title={chorusLabel} style={{"--value": `${progressPercent}%`} as React.CSSProperties}>{highlightedChorus && <span className="music-chorus-highlight" role="img" aria-label={chorusLabel} style={{ left: `${highlightedChorus.start / duration * 100}%`, width: `${(highlightedChorus.end - highlightedChorus.start) / duration * 100}%` }} />}<input aria-label="播放进度" type="range" min={0} max={duration || 0} step={0.1} value={Math.min(position, duration || 0)} onChange={event => seekTo(Number(event.target.value))} onPointerUp={handleProgressPointerUp} /><output>{formatTime(position)}</output></label><span>{formatTime(duration)}</span></div></div>
      <label className="music-volume"><button type="button" aria-label={volume === 0 ? "恢复音量" : "静音"} onClick={() => setVolume(value => value === 0 ? .75 : 0)}><VolumeIcon size={17} /></button><span className="music-range" style={{"--value": `${volume * 100}%`} as React.CSSProperties}><input type="range" aria-label="音量" min={0} max={1} step={0.01} value={volume} onChange={event => setVolume(Number(event.target.value))} /></span></label>
    </footer>
  </div>;
}
