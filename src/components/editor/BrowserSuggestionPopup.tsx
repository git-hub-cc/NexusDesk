import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import menuStyles from "../../native-menu.css?raw";

// Render in the child webview, in its own stacking space.
export function BrowserSuggestionPopup({ anchor, label, children, onSelect, onRemove, onClose }: {
  label: string;
  anchor: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  onSelect: (url: string) => void;
  onRemove: (url: string) => void;
  onClose: () => void;
}) {
  const source = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSelect, onRemove, onClose });
  callbacks.current = { onSelect, onRemove, onClose };
  const sync = useRef(() => {});

  useEffect(() => {
    const owner = getCurrentWindow();
    const request = crypto.randomUUID();
    let disposed = false;
    let queue = Promise.resolve();
    let previous = "";
    const listeners = Promise.all([
      owner.listen(`browser-document-ready-${label}`, () => { previous = ""; sync.current(); }),
      owner.listen<string>(`browser-suggestion-${label}`, event => {
        const data = new URLSearchParams(event.payload);
        if (disposed || data.get("request") !== request) return;
        const id = data.get("id");
        if (id === "close") callbacks.current.onClose();
        else if (id === "browser-history-remove") callbacks.current.onRemove(data.get("value") ?? "");
        else if (id) callbacks.current.onSelect(id);
      }),
    ]);
    const update = () => {
      queue = queue.then(async () => {
        await listeners;
        if (disposed || !source.current || !anchor.current) return;
        const rect = anchor.current.getBoundingClientRect();
        const theme = getComputedStyle(document.documentElement);
        const background = theme.getPropertyValue("--ide-bg") || "#2b2d30";
        const border = theme.getPropertyValue("--ide-panel-border") || "#1e1f22";
        const html = `<style>${menuStyles} :host,body{background:${background};color:#ddd;font:12px system-ui}.native-menu{background:${background};max-height:240px;overflow:auto;border:1px solid ${border};box-sizing:border-box}.native-menu [role=option]{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer}.native-menu [role=option]:hover,.native-menu [aria-selected=true]{background:#ffffff18}.native-menu [role=option]>span{display:block;flex:1 1 0%;min-width:0;overflow:hidden}.native-menu [role=option]>span>span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.native-menu [role=option]>span>span+span{color:#999;margin-top:4px}.native-menu [role=option] button{display:grid!important;place-items:center;flex:0 0 auto!important;width:auto!important;min-width:0;min-height:0;height:auto;padding:4px;border:0;background:transparent;color:#888;border-radius:4px;cursor:pointer}.native-menu [role=option] button:hover{background:#ef444426;color:#f87171}.native-menu>div>div:first-child,.native-menu [role=listbox]+div{padding:8px 12px;color:#999;font-size:11px}</style><div class="native-menu">${source.current.innerHTML}</div>`;
        const viewport = anchor.current.closest("form")?.parentElement?.lastElementChild?.getBoundingClientRect();
        const values = { request, html, x: rect.left - (viewport?.left ?? 0), width: rect.width };
        const key = JSON.stringify(values);
        if (key === previous) return;
        await invoke("browser_suggestions", { label, payload: values });
        previous = key;
      }).catch(error => {
        if (!disposed) { console.error("Browser suggestions failed", error); callbacks.current.onClose(); }
      });
    };
    sync.current = update;
    const resize = new ResizeObserver(update);
    if (anchor.current) resize.observe(anchor.current);
    return () => {
      disposed = true;
      resize.disconnect();
      sync.current = () => {};
      void queue.finally(async () => {
        (await listeners).forEach(stop => stop());
        await invoke("browser_suggestions", { label, payload: { request, html: "" } });
      }).catch(console.error);
    };
  }, [anchor, label]);

  useEffect(() => { sync.current(); }, [children]);

  return <div ref={source} hidden data-browser-suggestions>{children}</div>;
}
