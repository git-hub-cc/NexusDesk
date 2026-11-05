import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { fsApi } from "@/lib/api";
import { imageUrl } from "@/lib/assets";
import { imagePreviewScale } from "@/lib/imagePreview";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { ZoomIn, ZoomOut } from "lucide-react";

type Tool = "move" | "mark" | "mosaic" | "crop";

const zoomScale = (scale: number, direction: number) =>
  Math.max(0.000001, Math.min(1000, scale * Math.pow(1.2, direction)));

export function ImageEditor({ path, sourceContent, sourceUrl }: { path: string; sourceContent?: string; sourceUrl?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>("move");
  const [color, setColor] = useState("#ff3434");
  const [width, setWidth] = useState(6);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [size, setSize] = useState("");
  const [scale, setScale] = useState(1);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [vectorUrl, setVectorUrl] = useState("");
  const showVector = !!vectorUrl && !dirty && tool === "move";
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !imgSize.w || !imgSize.h) return;
    const fit = () => {
      // The preview has 32px of padding on each side.
      const width = container.clientWidth - 64;
      const height = container.clientHeight - 64;
      if (width <= 0 || height <= 0) return;
      setScale(imagePreviewScale(imgSize.w, imgSize.h, width, height));
      container.scrollLeft = 0;
      container.scrollTop = 0;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container, { box: "border-box" });
    return () => observer.disconnect();
  }, [imgSize.w, imgSize.h]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      if (!ready || busy || event.deltaY === 0) return;
      event.preventDefault();
      setScale(scale => zoomScale(scale, event.deltaY < 0 ? 1 : -1));
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [ready, busy]);
  const history = useRef<ImageData[]>([]);
  const future = useRef<ImageData[]>([]);
  const [historySize, setHistorySize] = useState({ undo: 0, redo: 0 });
  const updateHistorySize = () => setHistorySize({ undo: history.current.length, redo: future.current.length });
  const drag = useRef<{
    x: number; y: number;
    lastX: number; lastY: number;
    before?: ImageData;
    startX?: number; startY?: number;
    startScrollX?: number; startScrollY?: number;
  } | null>(null);

  const updateSize = () => {
    const c = canvasRef.current!;
    setSize(`${c.width} × ${c.height}`);
    setImgSize({ w: c.width, h: c.height });
  };

  useEffect(() => {
    setReady(false); setError(""); setDirty(false); setSize(""); setScale(1); setImgSize({ w: 0, h: 0 }); setVectorUrl("");
    history.current = [];
    future.current = [];
    updateHistorySize();
    drag.current = null;
    let cancelled = false;
    let objectUrl: string | undefined;
      void (async () => {
        const source = sourceContent === undefined
          ? sourceUrl ?? imageUrl(path)
          : (objectUrl = URL.createObjectURL(new Blob([sourceContent], { type: "image/svg+xml" })));
        if (cancelled) return;
        const image = new Image();
        // Asset URLs use a different origin from the editor. Request CORS access
        // so reading pixels for drawing, mosaic, crop and export stays allowed.
        image.crossOrigin = "anonymous";
        image.src = source;
        await image.decode();
        if (cancelled) return;
        // Keep SVG as a vector image for preview. The canvas is only used
        // for raster editing/export, never as the source of SVG zooming.
        if (/\.svg$/i.test(path)) setVectorUrl(source);
        const canvas = canvasRef.current!;
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        canvas.getContext("2d")!.drawImage(image, 0, 0);
        setReady(true); updateSize();
      })().catch(e => { if (!cancelled) setError(`图片加载失败：${String(e)}`); });
    return () => {
      cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, sourceContent, sourceUrl]);

  const publishDraft = () => {
    // Pixels stay on the local canvas; undo snapshots stay in history.current.
    const store = useWorkspaceStore.getState();
    const matches = (tab: typeof store.leftTabs[number]) => tab.path === path && !tab.revision && tab.diff === undefined;
    if ([...store.leftTabs, ...store.rightTabs].some(tab => matches(tab) && !tab.isDirty)) {
      const update = (tabs: typeof store.leftTabs) => tabs.map(tab => matches(tab) && !tab.isDirty ? { ...tab, isDirty: true } : tab);
      useWorkspaceStore.setState({ leftTabs: update(store.leftTabs), rightTabs: update(store.rightTabs) });
    }
    setDirty(true);
  };

  const remember = (before?: ImageData) => {
    const c = canvasRef.current!;
    history.current.push(before ?? c.getContext("2d")!.getImageData(0, 0, c.width, c.height));
    // Keep undo memory bounded for large photographs.
    let bytes = history.current.reduce((total, item) => total + item.data.byteLength, 0);
    while (history.current.length > 1 && (bytes > 128 * 1024 * 1024 || history.current.length > 20)) bytes -= history.current.shift()!.data.byteLength;
    future.current = [];
    updateHistorySize();
    setDirty(true);
  };

  const restore = (data: ImageData) => {
    const c = canvasRef.current!; c.width = data.width; c.height = data.height;
    c.getContext("2d")!.putImageData(data, 0, 0); updateSize();
  };

  const changeHistory = (redo: boolean) => {
    if (!ready || busy || drag.current) return;
    const source = redo ? future.current : history.current;
    const destination = redo ? history.current : future.current;
    if (!source.length) return;
    const c = canvasRef.current!;
    destination.push(c.getContext("2d")!.getImageData(0, 0, c.width, c.height));
    restore(source.pop()!);
    updateHistorySize();
    publishDraft();
  };

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current!, rect = c.getBoundingClientRect();
    return { x: Math.max(0, Math.min(c.width, (event.clientX - rect.left) * c.width / rect.width)), y: Math.max(0, Math.min(c.height, (event.clientY - rect.top) * c.height / rect.height)) };
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current; if (!d) return;
    if (tool === "move") {
      // 修复：增加对 startY 和 startScrollY 的 undefined 检查
      if (containerRef.current && d.startX !== undefined && d.startScrollX !== undefined && d.startY !== undefined && d.startScrollY !== undefined) {
        containerRef.current.scrollLeft = d.startScrollX - (event.clientX - d.startX);
        containerRef.current.scrollTop = d.startScrollY - (event.clientY - d.startY);
      }
      return;
    }
    const c = canvasRef.current!, ctx = c.getContext("2d")!, p = point(event);
    if (tool === "mark") {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(d.lastX, d.lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
    } else if (d.before) {
      ctx.putImageData(d.before, 0, 0);
      const x = Math.floor(Math.min(d.x, p.x)), y = Math.floor(Math.min(d.y, p.y));
      const w = Math.floor(Math.abs(p.x - d.x)), h = Math.floor(Math.abs(p.y - d.y));
      if (tool === "crop") { ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h); }
      else if (w && h) {
        const small = document.createElement("canvas");
        small.width = Math.max(1, Math.ceil(w / 16)); small.height = Math.max(1, Math.ceil(h / 16));
        small.getContext("2d")!.drawImage(c, x, y, w, h, 0, 0, small.width, small.height);
        ctx.imageSmoothingEnabled = false; ctx.drawImage(small, x, y, w, h); ctx.imageSmoothingEnabled = true;
      }
    }
    d.lastX = p.x; d.lastY = p.y;
  };

  const finish = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current; if (!d) return;
    if (tool === "move") {
      drag.current = null;
      return;
    }
    move(event); drag.current = null;
    const p = point(event), c = canvasRef.current!, ctx = c.getContext("2d")!;
    if (tool === "crop" && d.before) {
      ctx.putImageData(d.before, 0, 0);
      const w = Math.floor(Math.abs(p.x - d.x)), h = Math.floor(Math.abs(p.y - d.y));
      if (w < 2 || h < 2) return;
      const result = ctx.getImageData(Math.floor(Math.min(p.x, d.x)), Math.floor(Math.min(p.y, d.y)), w, h);
      remember(d.before); restore(result);
    } else if (d.before) remember(d.before);
    publishDraft();
  };

  const rotate = () => {
    const c = canvasRef.current!, copy = document.createElement("canvas");
    copy.width = c.width; copy.height = c.height; copy.getContext("2d")!.drawImage(c, 0, 0);
    remember(); c.width = copy.height; c.height = copy.width;
    const ctx = c.getContext("2d")!; ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(copy, 0, 0); ctx.resetTransform(); updateSize(); publishDraft();
  };

  const persist = async (asCopy: boolean) => {
    setBusy(true); setError("");
    try {
      const supported = /\.(png|jpe?g|webp)$/i.test(path);
      const target = asCopy || !supported ? await save({ defaultPath: path.replace(/\.[^.]+$/, "") + "-edited.png", filters: [{ name: "PNG 图片", extensions: ["png"] }] }) : path;
      if (!target) return;
      if (!/\.(png|jpe?g|webp)$/i.test(target)) throw new Error("请使用 PNG、JPEG 或 WebP 扩展名保存编辑后的图片");
      const mime = /\.jpe?g$/i.test(target) ? "image/jpeg" : /\.webp$/i.test(target) ? "image/webp" : "image/png";
      const blob = await new Promise<Blob>((resolve, reject) => canvasRef.current!.toBlob(b => b ? resolve(b) : reject(new Error("图片编码失败")), mime, 0.95));
      await fsApi.writeBinaryFile(target, Array.from(new Uint8Array(await blob.arrayBuffer())));
      window.dispatchEvent(new Event("nexusdesk:image-saved"));
      await useWorkspaceStore.getState().loadDirectory(target.replace(/[/\\][^/\\]+$/, ""), false, true);
      if (target === path) {
        setDirty(false);
        const update = (tabs: ReturnType<typeof useWorkspaceStore.getState>["leftTabs"]) => tabs.map(tab => tab.path === path && !tab.revision && tab.diff === undefined ? { ...tab, isDirty: false } : tab);
        useWorkspaceStore.setState(state => ({ leftTabs: update(state.leftTabs), rightTabs: update(state.rightTabs) }));
      }
    } catch (e) { setError(`保存失败：${String(e)}`); }
    finally { setBusy(false); }
  };

  return <div className="image-editor absolute inset-0 flex flex-col bg-ide-bg outline-none" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z") {
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault(); event.stopPropagation();
      changeHistory(event.shiftKey);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); if (ready && !busy) void persist(false); }
  }} tabIndex={0}>
    {/* 强制工具栏靠左对齐，避免宽度变化导致按钮跳动 */}
    <div className="markdown-toolbar flex-wrap gap-2" style={{ justifyContent: 'flex-start', alignItems: 'center' }}>
      {([ ["move", "移动"], ["mark", "标记"], ["mosaic", "马赛克"], ["crop", "裁剪"] ] as const).map(([id, label]) => <button key={id} disabled={!ready || busy} aria-pressed={tool === id} onClick={() => setTool(id)}>{label}</button>)}
      <input aria-label="标记颜色" type="color" value={color} onChange={e => setColor(e.target.value)} />
      <input aria-label="画笔宽度" type="range" min="1" max="40" value={width} onChange={e => setWidth(Number(e.target.value))} className="w-20" />
      <button disabled={!ready || busy} onClick={rotate}>旋转 90°</button>
      <button disabled={!ready || !historySize.undo || busy} title="撤销 (Ctrl+Z)" onClick={() => changeHistory(false)}>撤销</button>
      <button disabled={!ready || !historySize.redo || busy} title="恢复 (Ctrl+Shift+Z)" onClick={() => changeHistory(true)}>恢复</button>
      <button disabled={!ready || busy || !dirty} onClick={() => void persist(false)}>保存{dirty ? " *" : ""}</button>
      <button disabled={!ready || busy} onClick={() => void persist(true)}>另存为 PNG</button>

      <div className="flex shrink-0 items-center gap-1 ml-2 border-l border-ide-panel-border pl-2">
        <button disabled={!ready || busy} onClick={() => setScale(s => zoomScale(s, -1))} title="缩小"><ZoomOut size={14} /></button>
        <button type="button" disabled={!ready || busy} className="text-xs text-gray-400 min-w-[7ch] shrink-0 whitespace-nowrap tabular-nums justify-center" title="双击恢复 100%" aria-label={`缩放比例 ${Math.round(scale * 100)}%，双击恢复 100%`} onDoubleClick={() => setScale(1)}>{Math.round(scale * 100)}%</button>
        <button disabled={!ready || busy} onClick={() => setScale(s => zoomScale(s, 1))} title="放大"><ZoomIn size={14} /></button>
      </div>

      <span className="text-xs text-gray-400 ml-auto">{size} · {tool === "move" ? "拖动以平移图片" : tool === "mark" ? "拖动绘制标记" : "拖动选择区域"}</span>
    </div>
    {error && <div role="alert" className="p-2 text-red-400 text-xs">{error}</div>}

    {/* 使用深色背景，并利用 flex 完美居中 Canvas */}
    <div ref={containerRef} className="flex-1 min-h-0 min-w-0 overflow-auto bg-[#1e1f22]" onPointerDown={event => event.currentTarget.parentElement?.focus()}>
      <div className="min-h-full min-w-full w-max flex items-center justify-center p-8">
        {!ready && !error && <div role="status" className="text-sm text-gray-400">图片加载中…</div>}
        <div className="relative shrink-0" style={{ display: ready ? "block" : "none" }}>
        {showVector && <img src={vectorUrl} alt="SVG 矢量预览" draggable={false}
          className="absolute inset-0 max-w-none pointer-events-none shadow-2xl"
          style={{ width: imgSize.w * scale, height: imgSize.h * scale,
            background: "repeating-conic-gradient(#2b2d30 0% 25%, #3c3f41 0% 50%) 0 / 16px 16px" }} />}
        <canvas
            ref={canvasRef}
            aria-label="图片编辑画布"
            className="max-w-none shadow-2xl touch-none"
            style={{
              display: ready ? "block" : "none",
              opacity: showVector ? 0 : 1,
              cursor: tool === "move" ? "grab" : "crosshair",
              background: "repeating-conic-gradient(#2b2d30 0% 25%, #3c3f41 0% 50%) 0 / 16px 16px",
              width: imgSize.w ? imgSize.w * scale : undefined,
              height: imgSize.h ? imgSize.h * scale : undefined
            }}
            onPointerDown={event => {
              if (!ready || busy || event.button !== 0) return;
              event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);

              if (tool === "move") {
                drag.current = {
                  x: 0, y: 0, lastX: 0, lastY: 0,
                  startX: event.clientX, startY: event.clientY,
                  startScrollX: containerRef.current?.scrollLeft || 0,
                  startScrollY: containerRef.current?.scrollTop || 0
                };
                return;
              }

              const p = point(event), c = event.currentTarget;
              drag.current = { ...p, lastX: p.x, lastY: p.y, before: c.getContext("2d")!.getImageData(0, 0, c.width, c.height) };
              if (tool === "mark") { const ctx = c.getContext("2d")!; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, width / 2, 0, Math.PI * 2); ctx.fill(); }
            }}
            onPointerMove={move}
            onPointerUp={finish}
            onPointerCancel={() => {
              if (drag.current) {
                if (tool !== "move" && drag.current.before) restore(drag.current.before);
                drag.current = null;
              }
            }}
        />
        </div>
      </div>
    </div>
  </div>;
}
