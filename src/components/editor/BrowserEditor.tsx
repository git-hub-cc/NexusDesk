import { reserveBrowser } from "@/lib/browserPool";
import { browserVisibility } from "@/lib/browserVisibility";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, ArrowRight, RotateCw, House, Globe } from "lucide-react";
import { useWorkspaceStore, type Tab } from "@/store/workspaceStore";
import { MUSIC_HOME, VIDEO_HOME, CHAT_HOME } from "@/store/workspaceStore";
import { MusicEditor } from "@/components/music/MusicEditor";
import { VideoEditor } from "@/components/video/VideoEditor";
import { ChatEditor } from "@/components/chat/ChatEditor";
import { BrowserPasswords } from "./BrowserPasswords";
import { BrowserDownloads } from "./BrowserDownloads";
import { BrowserExtensions, CHROME_EXTENSION_STORE_URL } from "./BrowserExtensions";

export const BROWSER_HOME = "nexusdesk:nav";

export function validateBrowserAddress(value: string): string {
  const trimmed = value.trim();
  const input = /^(?:https?:\/\/|chrome-extension:\/\/)/i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (/\s/.test(input)) {
    throw new Error("请输入有效的网址，例如 example.com");
  }
  const url = new URL(input);
  if (!url.hostname) throw new Error("请输入有效的网址");
  return url.href;
}

function browserDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch { return "invalid-url"; }
}

function updateBrowserTabs(tabs: Tab[], id: string, url: string, title?: string): Tab[] {
  const fallback = new URL(url).hostname || "网页";
  return tabs.map(item => item.id === id && item.browser ? {
    ...item,
    title: title !== undefined ? title.trim() || fallback : item.title,
    browser: { ...item.browser, url },
  } : item);
}

export function BrowserEditor({ tab, pane, active }: { tab: Tab; pane: "left" | "right"; active: boolean }) {
  if (tab.browser?.url === MUSIC_HOME) return <MusicEditor active={active} />;
  if (tab.browser?.url === VIDEO_HOME) return <VideoEditor active={active} />;
  if (tab.browser?.url === CHAT_HOME) return <ChatEditor active={active} />;
  return tab.browser?.url === BROWSER_HOME ? <NavigationEditor tab={tab} pane={pane} active={active} /> : <NativeBrowserEditor tab={tab} pane={pane} active={active} />;
}

function NavigationEditor({ tab, pane, active }: { tab: Tab; pane: "left" | "right"; active: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin) return;
      if (event.data?.type === "nexusdesk:export-navigation") {
        const { requestId, filename, content } = event.data;
        if (typeof requestId !== "string" || typeof filename !== "string" || typeof content !== "string") return;
        void (async () => {
          try {
            const file = await save({
              title: "导出导航数据",
              defaultPath: filename,
              filters: [{ name: "JSON", extensions: ["json"] }],
            });
            if (!file) return;
            await invoke("navigation_export_data", { file, content });
            frame.current?.contentWindow?.postMessage({ type: "nexusdesk:export-complete", requestId }, window.location.origin);
          } catch (reason) {
            frame.current?.contentWindow?.postMessage({ type: "nexusdesk:export-failed", requestId, message: String(reason) }, window.location.origin);
          }
        })();
        return;
      }
      if (event.data?.type !== "nexusdesk:navigate") return;
      try {
        const url = new URL(event.data.url);
        if (!["https:", "http:"].includes(url.protocol)) return;
        const state = useWorkspaceStore.getState();
        state.setFocusedPane(pane);
        const id = `browser:${crypto.randomUUID()}`;
        state.openTab({ id, path: id, title: url.hostname, browser: { root: tab.browser!.root, url: url.href } });
      } catch { /* Ignore invalid website addresses. */ }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [tab.id, tab.browser!.root, active, pane]);
  return <div className={`absolute inset-0 flex flex-col bg-ide-bg ${active ? "" : "hidden"}`}><iframe ref={frame} title="导航工作台" src={`${import.meta.env.BASE_URL}navigation/index.html`} className="min-h-0 w-full flex-1 border-0 bg-ide-bg" /></div>;
}

function NativeBrowserEditor({ tab, pane, active }: { tab: Tab; pane: "left" | "right"; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const currentUrl = useRef(tab.browser!.url);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [address, setAddress] = useState(tab.browser!.url === "about:blank" ? "" : tab.browser!.url);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const editingRef = useRef(false);
  const labelRef = useRef("");
  const syncLayout = useRef<() => void>(() => {});
  const [viewGeneration, setViewGeneration] = useState(0);
  const pendingView = useRef<ReturnType<typeof reserveBrowser> | undefined>(undefined);
  const retainedViews = useRef<string[]>([]);
  const retainedIndex = useRef(-1);
  const switching = useRef(false);

  useEffect(() => () => {
    for (const label of retainedViews.current) {
      void invoke("browser_action", { label, action: "close" }).catch(() => {});
    }
    retainedViews.current = [];
    pendingView.current = undefined;
  }, []);

  useEffect(() => { syncLayout.current(); }, [active, error]);

  useEffect(() => {
    let disposed = false;
    setReady(false);
    let cleanupLayout: (() => void) | undefined;
    let unlisten: (() => void) | undefined;
    let unlistenTitle: (() => void) | undefined;
    let unlistenNewTab: (() => void) | undefined;
    let unlistenFullscreen: (() => void) | undefined;
    let unlistenLoad: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;
    let fullscreen = false;
    const { label, warm, loaded } = pendingView.current ?? reserveBrowser(tab.browser!.url);
    const setupStarted = performance.now();
    const logStage = (stage: string, started: number, details = "") => {
      console.info("[browser]", `label=${label}`, `stage=${stage}`, `elapsed_ms=${Math.round(performance.now() - started)}`, details);
    };
    pendingView.current = undefined;
    if (!retainedViews.current.includes(label)) {
      retainedViews.current.push(label);
      retainedIndex.current = retainedViews.current.length - 1;
    }
    labelRef.current = label;
    console.info("[browser]", `label=${label}`, "stage=open-start", `url=${browserDiagnosticUrl(tab.browser!.url)}`, `warm=${warm}`, `loaded=${loaded ?? false}`);
    const setup = async () => {
      const listenersStarted = performance.now();
      const updatePage = (url: string, title?: string) => {
        if (disposed) return;
        currentUrl.current = url;
        if (!editingRef.current) setAddress(url === "about:blank" ? "" : url);
        useWorkspaceStore.setState(state => ({
          leftTabs: updateBrowserTabs(state.leftTabs, tab.id, url, title),
          rightTabs: updateBrowserTabs(state.rightTabs, tab.id, url, title),
        }));
      };
      unlisten = await getCurrentWindow().listen<string>(`browser-url-${label}`, event => updatePage(event.payload));
      if (disposed) { unlisten(); return; }
      unlistenTitle = await getCurrentWindow().listen<{ url: string; title: string }>(`browser-title-${label}`, event => {
        updatePage(event.payload.url, event.payload.title);
      });
      if (disposed) { unlistenTitle(); return; }
      unlistenNewTab = await getCurrentWindow().listen<string>(`browser-new-tab-${label}`, event => {
        if (disposed) return;
        const url = new URL(event.payload);
        if (!['http:', 'https:', 'chrome-extension:'].includes(url.protocol)) return;
        const state = useWorkspaceStore.getState();
        state.setFocusedPane(pane);
        const id = `browser:${crypto.randomUUID()}`;
        state.openTab({
          id, path: id, title: url.hostname,
          browser: { root: tab.browser!.root, url: url.href },
        });
      });
      if (disposed) { unlistenNewTab(); return; }
      unlistenFullscreen = await getCurrentWindow().listen<boolean>(`browser-fullscreen-${label}`, event => {
        if (!disposed) { fullscreen = event.payload; syncLayout.current(); }
      });
      if (disposed) { unlistenFullscreen(); return; }
      unlistenLoad = await getCurrentWindow().listen<string>(`browser-load-result-${label}`, event => {
        if (!disposed) setError(event.payload);
      });
      if (disposed) { unlistenLoad(); return; }
      logStage("listeners-ready", listenersStarted);
      const initialRect = host.current?.getBoundingClientRect();
      const nativeStarted = performance.now();
      if (warm && !loaded) {
        await invoke("browser_action", { label, action: "navigate", url: tab.browser!.url });
      } else if (!warm) await invoke("create_browser", { label, url: tab.browser!.url, x: initialRect?.x ?? 0, y: initialRect?.y ?? 0, width: initialRect?.width ?? 1, height: initialRect?.height ?? 1, visible: browserVisibility(activeRef.current, initialRect?.width ?? 0, initialRect?.height ?? 0).visible, suppressInitialDownloads: !!tab.suppressInitialDownloads });
      logStage(warm ? (loaded ? "reuse-view" : "navigate-view") : "create-view", nativeStarted, `url=${browserDiagnosticUrl(tab.browser!.url)}`);
      if (disposed) {
        if (!retainedViews.current.includes(label)) await invoke("browser_action", { label, action: "close" });
        return;
      }
      if (loaded) {
        const syncStarted = performance.now();
        await invoke("browser_action", { label, action: "sync" });
        logStage("sync-view", syncStarted);
      }
      // The component may have closed or promoted another retained view while
      // native creation/synchronization was still in flight.
      if (disposed) return;
      switching.current = false;
      setReady(true);
      logStage("editor-ready", setupStarted, `url=${browserDiagnosticUrl(tab.browser!.url)}`);
      let previousX = NaN, previousY = NaN, previousWidth = NaN, previousHeight = NaN;
      let previousVisible: boolean | undefined;
      let previousReason: string | undefined;
      let frame: number | undefined;
      let fallback: number | undefined;
      let pending = false;
      let dirty = false;
      const overlaySelector = '[role="dialog"], [role="alertdialog"], [role="menu"], [data-dnd-dragging="true"], [data-mirror-fullscreen="true"]';
      const layout = () => {
        if (disposed) return;
        if (pending) { dirty = true; return; }
        const rect = host.current?.getBoundingClientRect();
        if (!rect) return;
        // Native views sit above HTML; hide them while application menus/dialogs are open.
        const { visible, reason, documentHidden } = browserVisibility(activeRef.current, rect.width, rect.height);
        // The native observer switches the host to fullscreen. Resize events
        // resync these bounds once that transition reaches the monitor size.
        const x = fullscreen ? 0 : rect.x;
        const y = fullscreen ? 0 : rect.y;
        const width = fullscreen ? window.innerWidth : rect.width;
        const height = fullscreen ? window.innerHeight : rect.height;
        if (x === previousX && y === previousY && width === previousWidth
          && height === previousHeight && visible === previousVisible && reason === previousReason) return;
        previousX = x; previousY = y;
        previousWidth = width; previousHeight = height;
        previousVisible = visible;
        previousReason = reason;
        pending = true;
        void invoke("browser_layout", { label, x, y, width, height, visible, reason, documentHidden }).catch(reason => {
          previousX = NaN;
          if (!disposed) setError(String(reason));
        }).finally(() => {
          pending = false;
          if (dirty) { dirty = false; scheduleLayout(); }
        });
      };
      const scheduleLayout = () => {
        if (disposed || frame !== undefined) return;
        const run = () => {
          if (frame !== undefined) cancelAnimationFrame(frame);
          if (fallback !== undefined) window.clearTimeout(fallback);
          frame = undefined; fallback = undefined;
          layout();
        };
        frame = requestAnimationFrame(run);
        // A hidden HTML document can suspend animation frames even though its
        // native browser tab needs to be shown again.
        fallback = window.setTimeout(run, 100);
      };
      const restoreLayout = () => { previousX = NaN; scheduleLayout(); };
      syncLayout.current = restoreLayout;
      const resizeObserver = new ResizeObserver(scheduleLayout);
      if (host.current) resizeObserver.observe(host.current);
      const containsOverlay = (node: Node) => node instanceof Element && (node.matches(overlaySelector) || node.querySelector(overlaySelector));
      const overlayObserver = new MutationObserver(records => {
        if (records.some(record => record.type === "attributes"
          || Array.from(record.addedNodes).some(containsOverlay)
          || Array.from(record.removedNodes).some(containsOverlay))) scheduleLayout();
      });
      overlayObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "data-dnd-dragging", "data-mirror-fullscreen", "data-panel-menu", "class", "style", "hidden", "data-state"] });
      window.addEventListener("resize", scheduleLayout);
      window.addEventListener("focus", restoreLayout);
      window.addEventListener("pageshow", restoreLayout);
      document.addEventListener("visibilitychange", restoreLayout);
      cleanupLayout = () => {
        syncLayout.current = () => {};
        if (frame !== undefined) cancelAnimationFrame(frame);
        if (fallback !== undefined) window.clearTimeout(fallback);
        resizeObserver.disconnect();
        overlayObserver.disconnect();
        window.removeEventListener("resize", scheduleLayout);
        window.removeEventListener("focus", restoreLayout);
        window.removeEventListener("pageshow", restoreLayout);
        document.removeEventListener("visibilitychange", restoreLayout);
      };
      scheduleLayout();
      unlistenFocus = await getCurrentWindow().onFocusChanged(event => {
        if (!disposed && event.payload) restoreLayout();
      }).catch(reason => { console.warn("Browser focus observer unavailable", reason); return undefined; });
      if (disposed) unlistenFocus?.();
    };
    void setup().catch(reason => {
      console.error("[browser]", `label=${label}`, "stage=setup-failed", `elapsed_ms=${Math.round(performance.now() - setupStarted)}`, reason);
      if (disposed) return;
      void invoke("browser_action", { label, action: "close" }).catch(() => {});
      if (!disposed) { switching.current = false; setError(String(reason)); }
    });
    return () => {
      disposed = true;
      cleanupLayout?.();
      unlisten?.();
      unlistenTitle?.();
      unlistenNewTab?.();
      unlistenFullscreen?.();
      unlistenLoad?.();
      unlistenFocus?.();
      // Retain the previous native history when promoting a speculative view.
      // All retained views are destroyed by the component's unmount cleanup.
      if (retainedViews.current.includes(label)) {
        void invoke("browser_layout", { label, x: 0, y: 0, width: 0, height: 0, visible: false }).catch(() => {});
      }
    };
  }, [tab.id, tab.browser!.root, viewGeneration, pane]);

  const action = async (name: string, url?: string) => {
    try {
      setError("");
      if (switching.current) return;
      const activate = (view: ReturnType<typeof reserveBrowser>) => {
        switching.current = true;
        setReady(false);
        pendingView.current = view;
        setViewGeneration(value => value + 1);
      };
      if (name === "back" || name === "forward") {
        const forward = name === "forward";
        const available = await invoke<boolean>("browser_can_go", { label: labelRef.current, forward });
        const next = retainedIndex.current + (forward ? 1 : -1);
        if (!available && next >= 0 && next < retainedViews.current.length) {
          retainedIndex.current = next;
          activate({ label: retainedViews.current[next], warm: true, loaded: true });
          return;
        }
      }
      if (name === "navigate" && url) {
        // A new navigation invalidates the retained forward chain.
        for (const old of retainedViews.current.splice(retainedIndex.current + 1)) {
          void invoke("browser_action", { label: old, action: "close" }).catch(() => {});
        }
      }
      // Failed redirects can leave the native view on its previous document.
      const retryUrl = name === "reload" && error ? address : undefined;
      await invoke("browser_action", { label: labelRef.current, action: retryUrl ? "navigate" : name, url: retryUrl ?? url });
    } catch (reason) { setError(String(reason)); }
  };
  const navigate = (value: string) => {
    if (!ready) return;
    try {
      const input = validateBrowserAddress(value);
      const url = new URL(input);
      if (!['http:', 'https:', 'chrome-extension:'].includes(url.protocol)) throw new Error("请输入网页或扩展页面地址");
      setAddress(url.href);
      addressInput.current?.blur();
      void action("navigate", url.href);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "请输入有效的网址"); }
  };

  return <div className={`absolute inset-0 flex flex-col bg-ide-bg ${active ? "" : "hidden"}`}>
    <form className="flex h-10 shrink-0 items-center gap-1 border-b border-ide-panel-border px-2 text-gray-400" onSubmit={event => { event.preventDefault(); navigate(address); }}>
      <BrowserPasswords onImported={async () => { await action("autofill"); }} />
      <BrowserExtensions getLabel={() => labelRef.current} currentUrl={currentUrl.current} onOpenStore={async () => { await action("navigate", CHROME_EXTENSION_STORE_URL); }} onInstalled={async () => { await action("reload"); }} />
      {([
        ["后退", ArrowLeft, () => void action("back")],
        ["前进", ArrowRight, () => void action("forward")],
        ["刷新", RotateCw, () => void action("reload")],
        ["主页", House, () => {
          const update = (tabs: Tab[]) => tabs.map(item => item.id === tab.id && item.browser ? {
            ...item, title: "导航", browser: { ...item.browser, url: BROWSER_HOME },
          } : item);
          useWorkspaceStore.setState(state => ({ leftTabs: update(state.leftTabs), rightTabs: update(state.rightTabs) }));
        }],
      ] as const).map(([title, Icon, onClick]) => <button key={title} type="button" title={title} aria-label={title} disabled={!ready} onClick={onClick} className="rounded p-1.5 hover:bg-white/10 hover:text-white disabled:opacity-40"><Icon size={15} /></button>)}
      <div className="relative ml-1 flex h-7 min-w-0 flex-1 items-center gap-2 rounded border border-ide-panel-border bg-ide-tab-bg px-2 focus-within:border-ide-accent">
        <Globe size={14} className="shrink-0" />
        <input ref={addressInput} aria-label="网页地址"
          placeholder="输入网址，例如 example.com 或 https://example.com" disabled={!ready}
          className="min-w-0 flex-1 bg-transparent text-xs text-gray-200 outline-none" value={address}
          onChange={event => setAddress(event.target.value)}
          onFocus={event => { editingRef.current = true; event.target.select(); }}
          onBlur={() => { editingRef.current = false; }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              setAddress(currentUrl.current === "about:blank" ? "" : currentUrl.current);
              event.currentTarget.select();
            }
          }} />
      </div>
    </form>
    {error && <div data-browser-error role="status" className="px-3 py-2 text-xs text-red-400 border-b border-ide-panel-border">{error} <button type="button" className="ml-2 underline" onClick={() => void action("reload")}>重新加载</button> <button type="button" className="ml-2 underline" onClick={() => {
      try {
        const url = new URL(address);
        if (["https:", "http:"].includes(url.protocol)) void openUrl(url.href).catch(reason => setError(String(reason)));
      } catch { setError("请输入有效的网页地址"); }
    }}>在系统浏览器中打开</button></div>}
    <BrowserDownloads labels={retainedViews.current} />
    <div ref={host} className="min-h-0 flex-1">{!ready && !error && <div className="p-4 text-sm text-gray-500">正在打开网页…</div>}</div>
  </div>;
}
