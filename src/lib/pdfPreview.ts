import type { PDFDocumentProxy } from "pdfjs-dist";

export interface PdfPreviewResource {
  document: PDFDocumentProxy;
  signal: AbortSignal;
}

export interface PdfPageSize {
  width: number;
  height: number;
}

export function pdfPreviewPageSize(size: PdfPageSize, width: number, zoom: number): PdfPageSize {
  const scale = Math.min(2, Math.max(0.1, (width - 48) / size.width)) * zoom;
  return { width: size.width * scale, height: size.height * scale };
}

export function pdfPageAtScrollOffset(pages: readonly (HTMLElement | null)[], offset: number): number {
  let start = 0;
  let end = pages.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if ((pages[middle]?.offsetTop ?? Infinity) <= offset) start = middle + 1;
    else end = middle;
  }
  return Math.max(1, start);
}

export async function renderPdfPreviewPage(
  resource: PdfPreviewResource,
  canvas: HTMLCanvasElement,
  pageNumber: number,
  width: number,
  zoom: number,
  signal: AbortSignal,
): Promise<PdfPageSize | undefined> {
  const cancelled = () => signal.aborted || resource.signal.aborted;
  if (cancelled() || width <= 48) return;
  // getPage 也可能同步抛错，必须在异步函数内调用，交给预览区显示错误。
  const page = await resource.document.getPage(pageNumber);
  if (cancelled()) return;
  const size = page.getViewport({ scale: 1 });
  const display = pdfPreviewPageSize(size, width, zoom);
  const scale = display.width / size.width;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: scale * ratio });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${viewport.width / ratio}px`;
  canvas.style.height = `${viewport.height / ratio}px`;
  const task = page.render({ canvas, viewport, background: "white" });
  const cancel = () => task.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  resource.signal.addEventListener("abort", cancel, { once: true });
  try {
    await task.promise;
    return { width: size.width, height: size.height };
  } finally {
    signal.removeEventListener("abort", cancel);
    resource.signal.removeEventListener("abort", cancel);
  }
}
