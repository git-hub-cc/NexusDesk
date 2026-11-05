import { EditorView } from "@codemirror/view";
import { showError } from "@/lib/dialogs";
import { memo, useEffect, useLayoutEffect, useState, useMemo, useRef } from "react";
import { imageUrl, resolveAsset } from "@/lib/assets";
import { SvgEditor } from "./SvgEditor";
import { HtmlEditor } from "./HtmlEditor";
import { openPath } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownRehypePlugins, markdownUrlTransform } from "@/lib/markdownPreview";
import { Code, Eye, Columns2 } from "lucide-react";
import { useWorkspaceStore, type Tab } from "@/store/workspaceStore";
import { TreeGraphPreview } from "./TreeGraphPreview";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { previewPositions } from "./previewPositions";
import { useLayoutStore } from "@/store/layoutStore";
import { writeUI } from "@/lib/uiPersistence";
import { GitComparison } from "./GitComparison";
import { GitImageDiffEditor } from "./GitImageDiffEditor";
import { fsApi } from "@/lib/api";
import Plyr from "plyr";
import "plyr/dist/plyr.css";
import { convertFileSrc } from "@tauri-apps/api/core";

// Keep progress outside the component: switching tabs unmounts the player.
const videoProgress = new Map<string, number>();

function AssetImage({ source, note, alt }: { source: string; note: string; alt?: string }) {
  const [version, setVersion] = useState(0);
  const asset = useMemo(() => {
    try {
      const path = resolveAsset(note, source);
      const url = imageUrl(path);
      const local = !/^(https?:|data:|blob:|tauri:|asset:)/i.test(path);
      return { path, url: local && version ? `${url}?v=${version}` : url, error: "" };
    } catch (error) {
      return { path: "", url: "", error: String(error) };
    }
  }, [note, source, version]);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => setVersion(v => Math.max(Date.now(), v + 1));
    window.addEventListener("noteide:image-saved", refresh);
    return () => window.removeEventListener("noteide:image-saved", refresh);
  }, []);

  return asset.error || failedUrl === asset.url
    ? <span title={asset.error || "图片加载失败"}>图片加载失败: {alt || source}</span>
    : <img src={asset.url} alt={alt} onError={() => setFailedUrl(asset.url)} onDoubleClick={async () => {
      const path = asset.path;
      if (!/^(https?:|data:|blob:|tauri:|asset:)/i.test(path)) {
        try {
          const content = await fsApi.readFile(path);
          useWorkspaceStore.getState().openTab({ id: path, path, title: path.split(/[/\\]/).pop()!, content });
        } catch (error) { showError(String(error)); }
      }
    }} title="双击编辑图片" />;
}

export function AssetVideo({ source, note, alt, fit = false, active = true, playRequest = 0 }: { source: string; note: string; alt?: string; fit?: boolean; active?: boolean; playRequest?: number }) {
  const playerHostRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const asset = useMemo(() => {
    try {
      const path = resolveAsset(note, source);
      return { url: /^(https?:|data:|blob:|tauri:)/i.test(path) ? path : convertFileSrc(path), error: "" };
    } catch (error) {
      return { url: "", error: String(error) };
    }
  }, [note, source]);

  useLayoutEffect(() => {
    const host = playerHostRef.current;
    if (!host || !asset.url) return;
    // Plyr replaces its media with a clone on destroy. Own the media inside
    // this host so every effect setup (including StrictMode) gets a live node.
    const video = document.createElement("video");
    video.preload = "auto";
    video.playsInline = true;
    video.controls = true;
    video.className = "w-full h-auto";
    host.replaceChildren(video);
    setReady(false);
    setError("");
    const player = new Plyr(video, {
      controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen'],
      settings: ['captions', 'quality', 'speed', 'loop'],
    });
    const savedTime = videoProgress.get(asset.url) ?? 0;
    let restored = false;
    let restoringSeek = false;
    const saveProgress = () => {
      if (!restored || restoringSeek || video.readyState < HTMLMediaElement.HAVE_METADATA || !Number.isFinite(video.currentTime)) return;
      videoProgress.set(asset.url, video.currentTime);
    };
    const restoreProgress = () => {
      if (restored) return;
      const time = Number.isFinite(video.duration) ? Math.min(savedTime, video.duration) : savedTime;
      if (time > 0) {
        try {
          restoringSeek = true;
          video.currentTime = time;
        } catch {
          restoringSeek = false;
        }
      }
      restored = true;
    };
    // Listen on the media element so cached first frames are handled too.
    const loaded = () => {
      if (restored && !restoringSeek && !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) setReady(true);
    };
    const seeked = () => {
      restoringSeek = false;
      saveProgress();
      loaded();
    };
    const failed = () => setError(video.error?.message || "无法解码或读取视频");
    const pauseWhenHidden = () => {
      if (!activeRef.current && document.pictureInPictureElement !== video) video.pause();
    };
    video.addEventListener("leavepictureinpicture", pauseWhenHidden);
    video.addEventListener("play", pauseWhenHidden);
    video.addEventListener("loadedmetadata", restoreProgress);
    video.addEventListener("loadeddata", loaded);
    video.addEventListener("seeked", seeked);
    video.addEventListener("timeupdate", saveProgress);
    video.addEventListener("pause", saveProgress);
    video.addEventListener("ended", saveProgress);
    video.addEventListener("error", failed);
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) restoreProgress();
    loaded();
    if (video.error) failed();
    // Set the source only after the player and progress listeners are ready.
    video.src = asset.url;
    return () => {
      // Capture the exact position before Plyr resets the media during destroy.
      saveProgress();
      video.removeEventListener("loadedmetadata", restoreProgress);
      video.removeEventListener("loadeddata", loaded);
      video.removeEventListener("seeked", seeked);
      video.removeEventListener("timeupdate", saveProgress);
      video.removeEventListener("pause", saveProgress);
      video.removeEventListener("ended", saveProgress);
      video.removeEventListener("error", failed);
      video.removeEventListener("leavepictureinpicture", pauseWhenHidden);
      video.removeEventListener("play", pauseWhenHidden);
      video.pause();
      player.destroy();
      host.replaceChildren();
    };
  }, [asset.url]);

  useEffect(() => {
    if (!playRequest || !activeRef.current) return;
    const video = playerHostRef.current?.querySelector("video");
    // Each list click requests playback, including clicks on the current video.
    // Switching sources can cancel an earlier pending play promise.
    void video?.play().catch(() => {});
  }, [asset.url, playRequest]);

  useEffect(() => {
    const video = playerHostRef.current?.querySelector("video");
    if (!active && video && document.pictureInPictureElement !== video) video.pause();
  }, [active]);

  const failure = asset.error || error;
  return (
    <div className={fit ? "asset-video asset-video-fit" : "asset-video my-4 rounded overflow-hidden border border-ide-panel-border bg-black"} aria-busy={!ready && !failure}>
      {(!ready || failure) && <div className="asset-video-status" role="status" title={failure || undefined}>
        {failure ? `视频加载失败：${alt || source}` : "视频加载中…"}
      </div>}
      <div ref={playerHostRef} className="asset-video-player" style={{ visibility: ready && !failure ? "visible" : "hidden" }} />
    </div>
  );
}

export function VideoTabPreview({ tab, active }: { tab: Tab; active: boolean }) {
  // Load only once visited, then retain the media until the tab closes.
  const visited = useRef(false);
  if (active) visited.current = true;
  if (!visited.current) return null;
  return <div className="absolute inset-0 flex flex-col bg-ide-bg outline-none select-none"
    style={{ visibility: active ? "visible" : "hidden", opacity: active ? 1 : 0, pointerEvents: active ? "auto" : "none" }} aria-hidden={!active} inert={!active}>
    <div className="markdown-toolbar flex justify-between items-center px-4 py-2 border-b border-ide-panel-border text-xs text-gray-400">
      <span className="truncate">{tab.path}</span>
      <span>视频预览 · 支持硬件加速解码</span>
    </div>
    <div className="relative flex-1 min-h-0 min-w-0 bg-[#1e1f22] overflow-hidden">
      <AssetVideo source={tab.path} note={tab.path} alt={tab.title} fit active={active} />
    </div>
  </div>;
}

const modes = [
  { id: "source", label: "源码", icon: Code },
  { id: "preview", label: "预览", icon: Eye },
  { id: "split", label: "双栏", icon: Columns2 },
] as const;
const plugins = [remarkGfm];

function MarkdownPreviewPane({ pane, tabId, previewRef, className, children }: {
  pane: "left" | "right";
  tabId: string;
  previewRef: React.RefObject<HTMLDivElement | null>;
  className: string;
  children: React.ReactNode;
}) {
  useLayoutEffect(() => {
    const element = previewRef.current;
    if (!element) return;
    const root = useWorkspaceStore.getState().rootPath;
    const positions = previewPositions[pane];
    const position = positions.get(tabId);
    element.scrollTop = position?.top ?? 0;
    element.scrollLeft = position?.left ?? 0;
    const snapshot = () => {
      if (root) writeUI(root, `preview:${pane}:${tabId}`, { top: element.scrollTop, left: element.scrollLeft });
    };
    window.addEventListener("noteide-snapshot-ui", snapshot);
    return () => {
      // This keyed component cleans up before React removes its scroll container.
      snapshot();
      window.removeEventListener("noteide-snapshot-ui", snapshot);
    };
  }, [pane, tabId, previewRef]);

  return <div ref={previewRef} className={className} tabIndex={0} onScroll={event => {
    previewPositions[pane].set(tabId, { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft });
  }}>{children}</div>;
}

const MarkdownPreview = memo(({ content, path }: { content: string; path: string }) => {
  // 使用 useMemo 缓存 components，避免每次 content 变化时重新创建组件导致全量卸载重绘
  const components = useMemo(() => ({
    img: ({ src, alt }: any) => {
      const isVid = /\.(mp4|webm|ogg|mov)$/i.test(src || "");
      if (isVid) {
        return <AssetVideo source={typeof src === "string" ? src : ""} note={path} alt={alt} />;
      }
      return <AssetImage source={typeof src === "string" ? src : ""} note={path} alt={alt} />;
    },
    a: ({ children, node: _node, ...props }: any) => <a {...props} target={props.href?.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer" onClick={event => {
      if (props.href?.startsWith("#")) {
        event.preventDefault();
        let fragment = props.href.slice(1);
        try { fragment = decodeURIComponent(fragment); } catch { /* Keep literal malformed fragments. */ }
        const preview = event.currentTarget.closest(".markdown-preview");
        // Sanitization prefixes ids/names to prevent DOM clobbering. Search within this pane.
        const target = Array.from(preview?.querySelectorAll<HTMLElement>("[id], [name]") ?? [])
          .find(element => element.id === `user-content-${fragment}` || element.getAttribute("name") === `user-content-${fragment}`);
        target?.scrollIntoView({ block: "start" });
        return;
      }
      if (props.href && !/^(https?:|mailto:|#)/i.test(props.href)) {
        event.preventDefault();
        try { void openPath(resolveAsset(path, props.href)).catch(error => showError(`打开附件失败：${String(error)}`)); }
        catch (error) { showError(String(error)); }
      }
    }}>{children}</a>,
  }), [path]);

  return (
      <article className="markdown-preview" aria-label="Markdown 预览">
        {content ? <ReactMarkdown remarkPlugins={plugins} rehypePlugins={markdownRehypePlugins} urlTransform={markdownUrlTransform} components={components}>{content}</ReactMarkdown>
            : <p className="markdown-empty">暂无内容，在源码模式下开始编写 Markdown。</p>}
      </article>
  );
});

export function MarkdownEditor({ pane, tabId, active }: { pane: "left" | "right"; tabId: string; active: boolean }) {
  const tab = useWorkspaceStore(state => {
    const tabs = pane === "left" ? state.leftTabs : state.rightTabs;
    return tabs.find(tab => tab.id === tabId);
  });
  const setMode = useWorkspaceStore(state => state.setMarkdownMode);
  const setFocusedPane = useWorkspaceStore(state => state.setFocusedPane);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [treeScrollLine, setTreeScrollLine] = useState<number | null>(null);
  const sourceWidth = useLayoutStore(state => state.markdownSplitRatio);
  const setSourceWidth = useLayoutStore(state => state.setMarkdownSplitRatio);
  const [resizing, setResizing] = useState(false);
  const resizeSplit = (clientX: number) => {
    const bounds = splitContainerRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 4) return;
    setSourceWidth(Math.max(20, Math.min(80, (clientX - bounds.left - 2) / (bounds.width - 4) * 100)));
  };
  const isMarkdown = /\.(md|markdown|mdown|mkd)$/i.test(tab?.path ?? "");
  const isTree = /\.tree$/i.test(tab?.path ?? "");
  const mode: NonNullable<Tab["markdownMode"]> = (isMarkdown || isTree) ? tab?.markdownMode ?? "source" : "source";

  useEffect(() => {
    if (mode !== "split" || (!isMarkdown && !isTree)) return;
    const editor = splitContainerRef.current?.querySelector<HTMLElement>(".cm-editor");
    const view = editor ? EditorView.findFromDOM(editor) : null;
    const source = view?.scrollDOM;
    const preview = previewRef.current;
    if (!view || !source || !preview) return;
    const expected = new WeakMap<HTMLElement, number>();
    let frame = 0;
    const sync = (from: HTMLElement, to: HTMLElement) => {
      const previous = expected.get(from);
      expected.delete(from);
      if (previous !== undefined && Math.abs(from.scrollTop - previous) < 1) return;
      if (isTree) {
        const block = view.lineBlockAtHeight(source.scrollTop);
        setTreeScrollLine(view.state.doc.lineAt(block.from).number);
        return;
      }
      const range = from.scrollHeight - from.clientHeight;
      const top = range > 0 ? from.scrollTop / range * Math.max(0, to.scrollHeight - to.clientHeight) : 0;
      to.scrollTop = top;
      expected.set(to, to.scrollTop);
    };
    const fromSource = () => sync(source, preview);
    const fromPreview = () => sync(preview, source);
    source.addEventListener("scroll", fromSource, { passive: true });
    if (!isTree) preview.addEventListener("scroll", fromPreview, { passive: true });
    frame = requestAnimationFrame(fromSource);
    return () => {
      cancelAnimationFrame(frame);
      source.removeEventListener("scroll", fromSource);
      preview.removeEventListener("scroll", fromPreview);
    };
  }, [mode, tab?.id, isMarkdown, isTree]);

  const syncTreeToSource = (line: number) => {
    if (mode !== "split") return;
    const editor = splitContainerRef.current?.querySelector<HTMLElement>(".cm-editor");
    const view = editor ? EditorView.findFromDOM(editor) : null;
    if (!view) return;
    const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
    view.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: "start" }) });
  };

  if (tab?.reverseTree) return <TreeGraphPreview content="" path={tab.path} pane={pane} previewOnly reverseTree={tab.reverseTree} onOpenSource={async (path, line) => {
    const state = useWorkspaceStore.getState();
    const existing = [...state.leftTabs, ...state.rightTabs].find(item => item.path === path && !item.revision && item.diff === undefined);
    const content = existing?.content ?? await fsApi.readFile(path);
    useWorkspaceStore.getState().openTab({ id: path, path, title: path.split(/[\\/]/).pop() || path, content });
    useWorkspaceStore.getState().locateGraph(path, line, useWorkspaceStore.getState().focusedPane);
  }} />;

  const handleDiffChange = (content: string) => {
    if (tab) useWorkspaceStore.getState().updateTabContent(tab.id, content, pane);
  };

  if (tab?.imageDiff) return <GitImageDiffEditor key={tab.id} tab={tab} />;
  if (tab?.diff !== undefined) return <GitComparison key={`${tab.id}:${tab.diffEntry?.token ?? 0}`} tab={tab} pane={pane} onChange={handleDiffChange} />;
  if (tab?.revision) return <div className="absolute inset-0 flex flex-col bg-ide-bg select-text">
    <div className="p-2 text-xs border-b border-ide-panel-border text-blue-400">{tab.path} · {tab.revision.slice(0, 8)} · 历史快照（只读）</div>
    <div className="flex-1 overflow-auto"><pre className="text-xs py-2 min-w-max">{(tab.content ?? "").split("\n").map((line, i) => <div key={i} className="flex leading-5"><span className="w-14 shrink-0 text-right pr-3 text-gray-500 select-none">{i + 1}</span><code className="pr-4">{line || " "}</code></div>)}</pre></div>
  </div>;
  if (tab && /\.html?$/i.test(tab.path)) return <HtmlEditor key={tab.id} tab={tab} pane={pane} active={active} />;
  if (tab && /\.svg$/i.test(tab.path)) return <SvgEditor key={tab.id} tab={tab} pane={pane} active={active} />;

  return (
      <div className="absolute inset-0 flex min-h-0 flex-col" onFocusCapture={() => setFocusedPane(pane)} onPointerDown={() => setFocusedPane(pane)}>
        {(isMarkdown || isTree) && (
            <div className="markdown-toolbar" role="group" aria-label="Markdown 显示模式">
              {modes.map(({ id, label, icon: Icon }) => (
                  <button key={id} type="button" aria-pressed={mode === id}
                          title={id === "preview" ? "所见即所得预览" : id === "split" ? "左源码，右预览" : "编辑 Markdown 源码"}
                          onClick={() => tab && setMode(tab.id, pane, id)}>
                    <Icon size={14} aria-hidden="true" />{label}
                  </button>
              ))}
            </div>
        )}
        <div ref={splitContainerRef} className="flex min-h-0 flex-1 overflow-hidden" style={resizing ? { cursor: "ew-resize", userSelect: "none" } : undefined}>
          {/* Keep the source editor mounted to retain its cursor and undo history. */}
          <div className={`relative min-w-0 ${mode === "preview" ? "hidden" : mode === "split" ? "shrink-0" : "w-full"}`}
               style={mode === "split" ? { width: `calc((100% - 4px) * ${sourceWidth / 100})` } : undefined}>
            <CodeMirrorEditor pane={pane} tabId={tabId} navigationEnabled={active && mode !== "preview"} />
          </div>
          {mode === "split" && <div
            role="separator" aria-label="调整源码与预览宽度" aria-orientation="vertical"
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
              <MarkdownPreviewPane pane={pane} tabId={tab?.id ?? ""} previewRef={previewRef} key={tab?.id} className={`min-w-0 overflow-auto select-text outline-none ${mode === "split" ? "flex-1" : "w-full"}`}>
                {isTree ? <TreeGraphPreview content={tab?.content ?? ""} path={tab?.path ?? ""} pane={pane} previewOnly={mode === "preview"} scrollLine={mode === "split" ? treeScrollLine : null} onScrollLine={syncTreeToSource} /> : <MarkdownPreview content={tab?.content ?? ""} path={tab?.path ?? ""} />}
              </MarkdownPreviewPane>
          )}
        </div>
      </div>
  );
}
