import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

/** Fixed row sizes include spacing; only the viewport and six buffer rows mount. */
export function useVirtualList(
  ref: RefObject<HTMLDivElement | null>,
  count: number,
  rowHeight: number,
  active: boolean,
  resetKey: string,
  padding = 0,
) {
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const measure = useCallback(() => {
    const element = ref.current;
    if (!element || !element.clientHeight) return;
    const top = Math.max(0, element.scrollTop - padding);
    const height = Math.max(0, element.clientHeight - padding * 2);
    setViewport(previous => previous.top === top && previous.height === height ? previous : { top, height });
  }, [ref, padding]);

  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
    setViewport(previous => ({ ...previous, top: 0 }));
  }, [ref, resetKey]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; measure(); });
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    element.addEventListener("scroll", schedule, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [ref, active, measure]);

  // Filtering/deletion can shorten the list while its viewport is near the end.
  useLayoutEffect(() => { if (active) measure(); }, [active, count, measure]);

  const scrollToIndex = useCallback((index: number) => {
    const element = ref.current;
    if (!element || index < 0 || index >= count) return;
    const top = padding + index * rowHeight;
    const bottom = top + rowHeight;
    if (top < element.scrollTop + padding) element.scrollTop = top - padding;
    else if (bottom > element.scrollTop + element.clientHeight - padding) {
      element.scrollTop = bottom - element.clientHeight + padding;
    }
    measure();
  }, [ref, count, rowHeight, padding, measure]);

  const totalHeight = count * rowHeight;
  const top = Math.min(viewport.top, Math.max(0, totalHeight - viewport.height));
  const start = Math.max(0, Math.floor(top / rowHeight) - 6);
  const end = Math.min(count, Math.ceil((top + viewport.height) / rowHeight) + 6);
  return { start, end, totalHeight, scrollToIndex };
}
