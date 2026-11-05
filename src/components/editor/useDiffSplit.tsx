import { useRef, useState, type CSSProperties } from "react";
import { useLayoutStore } from "@/store/layoutStore";

export function useDiffSplit() {
  const position = useLayoutStore(state => state.gitDiffSplitRatio);
  const setPosition = useLayoutStore(state => state.setGitDiffSplitRatio);
  const [dragging, setDragging] = useState(false);
  const grabOffset = useRef(0);
  const resize = (value: number) => setPosition(Math.max(15, Math.min(85, value)));
  const splitStyle = { "--diff-left-width": `${position}%` } as CSSProperties;
  const splitHandle = <div
    className={`ide-resize-handle ide-resize-handle-x git-diff-resize-handle${dragging ? " dragging" : ""}`}
    role="separator" tabIndex={0} aria-label="调整对比两侧宽度" aria-orientation="vertical"
    aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(position)}
    title="拖动调整两侧宽度，双击恢复均分"
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
      grabOffset.current = event.clientX - bounds.left - bounds.width * position / 100;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
      setDragging(true);
    }}
    onPointerMove={event => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
      if (bounds.width) resize((event.clientX - bounds.left - grabOffset.current) / bounds.width * 100);
    }}
    onPointerUp={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      setDragging(false);
    }}
    onPointerCancel={() => setDragging(false)}
    onLostPointerCapture={() => setDragging(false)}
    onDoubleClick={() => resize(50)}
    onKeyDown={event => {
      const step = event.shiftKey ? 10 : 1;
      const value = event.key === "ArrowLeft" ? position - step : event.key === "ArrowRight" ? position + step
        : event.key === "Home" ? 15 : event.key === "End" ? 85 : undefined;
      if (value === undefined) return;
      event.preventDefault(); event.stopPropagation(); resize(value);
    }}
  />;
  return { splitStyle, splitHandle };
}
