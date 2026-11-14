import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { ChevronLeft, ChevronRight, ExternalLink, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import type { WorkBook } from "@e965/xlsx";
import { fsApi } from "@/lib/api";
import { isRemotePath } from "@/lib/remote";
import { pdfPageAtScrollOffset, pdfPreviewPageSize, renderPdfPreviewPage, type PdfPreviewResource } from "@/lib/pdfPreview";
import { filterSpreadsheetRows, prepareSpreadsheetPreview } from "@/lib/spreadsheetPreview";

function PdfPage({ resource, page, width, zoom, visible }: {
  resource: PdfPreviewResource; page: number; width: number; zoom: number; visible: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 595, height: 842 });
  const [error, setError] = useState("");
  const [rendering, setRendering] = useState(true);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setError("");
    setRendering(true);
    const element = canvas.current;
    if (!element) return () => controller.abort();
    void renderPdfPreviewPage(resource, element, page, width, zoom, controller.signal)
      .then(pageSize => {
        if (pageSize && !controller.signal.aborted && !resource.signal.aborted) setSize(pageSize);
      })
      .catch(reason => {
        if (!controller.signal.aborted && !resource.signal.aborted) setError(`PDF 页面加载失败：${String(reason)}`);
      }).finally(() => {
        if (!controller.signal.aborted && !resource.signal.aborted) setRendering(false);
      });
    return () => {
      controller.abort();
      element.width = element.height = 0;
    };
  }, [resource, page, zoom, width, visible]);
  const display = pdfPreviewPageSize(size, width, zoom);
  return <div className="relative mx-auto bg-white shadow-lg" style={{ width: display.width, height: display.height }} aria-label={`第 ${page} 页`}>
    {visible && <>
      {error && <p role="alert" className="absolute inset-x-4 top-4 text-red-600 text-sm">{error}</p>}
      {rendering && <p role="status" className="absolute inset-x-4 top-4 text-gray-500 text-sm">正在渲染第 {page} 页…</p>}
      <canvas ref={canvas} className={`block ${error || rendering ? "invisible" : ""}`} />
    </>}
  </div>;
}

function PdfPreview({ resource, active }: { resource: PdfPreviewResource; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const pages = useRef<(HTMLDivElement | null)[]>([]);
  const scrollFrame = useRef<number | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(800);
  const [visible, setVisible] = useState(() => new Set([1]));
  useEffect(() => {
    if (!active) return;
    const element = host.current;
    if (!element) return;
    const resize = new ResizeObserver(() => {
      if (element.clientWidth > 0) setWidth(element.clientWidth);
    });
    resize.observe(element);
    const observer = new IntersectionObserver(entries => {
      setVisible(previous => {
        const next = new Set(previous);
        for (const entry of entries) {
          const number = Number((entry.target as HTMLElement).dataset.pdfPage);
          if (entry.isIntersecting) next.add(number);
          else next.delete(number);
        }
        return next;
      });
    }, { root: element, rootMargin: "800px 0px" });
    for (const item of pages.current) if (item) observer.observe(item);
    return () => {
      resize.disconnect();
      observer.disconnect();
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    };
  }, [resource, active]);
  const scrollToPage = (number: number) => {
    const element = pages.current[number - 1];
    if (!element || !host.current) return;
    host.current.scrollTo({ top: element.offsetTop - 24 });
    setPage(number);
  };
  const onScroll = () => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      if (host.current) setPage(pdfPageAtScrollOffset(pages.current, host.current.scrollTop + 24));
    });
  };
  return <div className="flex flex-col h-full min-h-0">
    <div className="flex items-center gap-3 px-3 py-2 border-b border-ide-panel-border text-xs">
      <button title="上一页" disabled={page === 1} onClick={() => scrollToPage(page - 1)}><ChevronLeft size={16} /></button>
      <span>第 {page} / {resource.document.numPages} 页</span>
      <button title="下一页" disabled={page === resource.document.numPages} onClick={() => scrollToPage(page + 1)}><ChevronRight size={16} /></button>
      <button title="缩小" onClick={() => setZoom(value => Math.max(0.25, value / 1.2))}><ZoomOut size={16} /></button>
      <button title="适合宽度" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
      <button title="放大" onClick={() => setZoom(value => Math.min(4, value * 1.2))}><ZoomIn size={16} /></button>
    </div>
    <div ref={host} onScroll={onScroll} className="relative flex-1 min-h-0 overflow-auto p-6">
      {Array.from({ length: resource.document.numPages }, (_, index) => <div key={index + 1} ref={element => { pages.current[index] = element; }} data-pdf-page={index + 1} className="mb-6 last:mb-0 min-w-fit">
        <PdfPage resource={resource} page={index + 1} width={width} zoom={zoom} visible={active && visible.has(index + 1)} />
      </div>)}
    </div>
  </div>;
}

function SpreadsheetPreview({ workbook }: { workbook: WorkBook }) {
  const [sheet, setSheet] = useState(workbook.SheetNames[0] ?? "");
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const container = useRef<HTMLDivElement>(null);
  const [utils, setUtils] = useState<typeof import("@e965/xlsx")["utils"]>();
  useEffect(() => { void import("@e965/xlsx").then(module => setUtils(module.utils)); }, []);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => {
      if (entries[0].contentRect.height > 0) setHeight(entries[0].contentRect.height);
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const data = useMemo(() => {
    return utils ? prepareSpreadsheetPreview(workbook.Sheets[sheet], utils) : { rows: [], columns: 0, truncated: false };
  }, [workbook, sheet, utils]);
  const rows = useMemo(() => filterSpreadsheetRows(data.rows, query), [data.rows, query]);
  const start = Math.max(0, Math.floor(scrollTop / 28) - 5);
  const end = Math.min(rows.length, start + Math.ceil(height / 28) + 12);
  const resetScroll = () => { setScrollTop(0); if (container.current) container.current.scrollTop = 0; };
  return <div className="h-full flex flex-col min-h-0 text-xs">
    <div className="flex gap-3 items-center px-3 py-2 border-b border-ide-panel-border">
      <select aria-label="工作表" className="bg-ide-bg border border-ide-panel-border rounded px-2 py-1" value={sheet} onChange={event => { setSheet(event.target.value); resetScroll(); }}>
        {workbook.SheetNames.map(name => <option key={name}>{name}</option>)}
      </select>
      <input aria-label="搜索表格" placeholder="搜索当前工作表" className="bg-ide-bg border border-ide-panel-border rounded px-2 py-1 min-w-0" value={query} onChange={event => { setQuery(event.target.value); resetScroll(); }} />
      <span className="shrink-0">{rows.length} 行</span>
    </div>
    {data.truncated && <p className="px-3 py-2 text-yellow-400">仅预览前 100,000 行、256 列，完整内容请使用本地应用打开。</p>}
    <div ref={container} className="flex-1 min-h-0 overflow-auto select-text" onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      <table className="border-collapse table-fixed" style={{ width: 64 + data.columns * 160 }}>
        <thead className="sticky top-0 bg-ide-bg z-10"><tr className="h-7"><th className="w-16 border border-ide-panel-border">行号</th>{Array.from({ length: data.columns }, (_, column) => <th key={column} className="w-40 border border-ide-panel-border">{utils?.encode_col(column)}</th>)}</tr></thead>
        <tbody>
          {start > 0 && <tr style={{ height: start * 28 }} aria-hidden="true"><td colSpan={data.columns + 1} /></tr>}
          {rows.slice(start, end).map(row => <tr key={row.index} className="h-7 hover:bg-white/5">
            <td className="border border-ide-panel-border text-center text-gray-500">{row.index + 1}</td>
            {Array.from({ length: data.columns }, (_, column) => <td key={column} className="border border-ide-panel-border px-2"><div className="truncate max-w-[143px]" title={String(row.cells[column] ?? "")}>{row.cells[column] ?? ""}</div></td>)}
          </tr>)}
          {end < rows.length && <tr style={{ height: (rows.length - end) * 28 }} aria-hidden="true"><td colSpan={data.columns + 1} /></tr>}
        </tbody>
      </table>
      {!rows.length && <p className="p-4 text-gray-500">{query ? "没有匹配的内容" : "工作表为空"}</p>}
    </div>
  </div>;
}

export function DocumentPreview({ path, active }: { path: string; active: boolean }) {
  const local = !Boolean(isRemotePath(path)) && !path.startsWith("android://");
  const [attempt, setAttempt] = useState(0);
  const [pdf, setPdf] = useState<PdfPreviewResource>();
  const [workbook, setWorkbook] = useState<WorkBook>();
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const lifetime = new AbortController();
    let task: ReturnType<typeof import("pdfjs-dist")["getDocument"]> | undefined;
    const requestId = crypto.randomUUID();
    const extension = path.split(".").pop()?.toLowerCase();
    setPdf(undefined);
    setWorkbook(undefined);
    setError("");
    setStatus(["doc", "ppt", "xls"].includes(extension ?? "") ? "正在将旧版 Office 转为新版格式并准备预览…" : ["docx", "pptx"].includes(extension ?? "") ? "正在转换为 PDF…" : "正在加载预览…");
    void (async () => {
      const convert = extension !== "pdf" && extension !== "xlsx";
      if (!local) throw new Error("请先将文档保存到本地，再进行预览。");
      const bytes = new Uint8Array(convert
        ? await invoke<number[]>("prepare_document_preview", { path, requestId })
        : await fsApi.readBinaryFile(path));
      if (cancelled) return;
      setStatus("正在加载预览…");
      if (extension === "xls" || extension === "xlsx") {
        const { read } = await import("@e965/xlsx");
        if (!cancelled) setWorkbook(read(bytes, { type: "array", cellHTML: false, cellFormula: false }));
      } else {
        const [pdfjs, { default: workerSrc }] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
        task = pdfjs.getDocument({ data: bytes });
        const document = await task.promise;
        if (!cancelled) setPdf({ document, signal: lifetime.signal });
      }
      if (!cancelled) setStatus("");
    })().catch(reason => {
      if (!cancelled) {
        setStatus("");
        setError(reason?.name === "PasswordException" ? "此 PDF 受密码保护，请先在本地应用中解除密码保护后重试。" : String(reason));
      }
    });
    return () => {
      cancelled = true;
      lifetime.abort();
      void task?.destroy().catch(() => {});
      void invoke("cancel_document_preview", { requestId }).catch(console.error);
    };
  }, [path, attempt, local]);
  return <div className="h-full flex flex-col bg-ide-bg text-ide-fg">
    <div className="flex items-center gap-3 px-3 py-2 border-b border-ide-panel-border text-xs shrink-0">
      <span className="flex-1">文档预览 · 只读</span>
      <button className="flex items-center gap-1 hover:text-white" onClick={() => setAttempt(value => value + 1)}><RotateCw size={14} />重新加载</button>
      <button className="flex items-center gap-1 hover:text-white" disabled={!local} onClick={() => { void openPath(path).catch(reason => setError(String(reason))); }}><ExternalLink size={14} />本地打开</button>
    </div>
    {error ? <div role="alert" className="p-6 text-sm"><p className="text-red-400 whitespace-pre-wrap">{error}</p><button className="mt-4 px-3 py-1 border border-ide-panel-border rounded" onClick={() => setAttempt(value => value + 1)}>重试</button></div>
      : status ? <div role="status" className="p-6 text-sm text-gray-400">{status}</div>
        : <div className="flex-1 min-h-0">{pdf && !pdf.signal.aborted ? <PdfPreview key={`${path}:${attempt}`} resource={pdf} active={active} /> : workbook ? <SpreadsheetPreview key={`${path}:${attempt}`} workbook={workbook} /> : null}</div>}
  </div>;
}
