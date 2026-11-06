import { useEffect, useMemo, useRef, useState } from "react";
import { diffChanges, fullTextDiffRows, parseGitDiff } from "@/lib/gitDiff";
import { ChevronUp, ChevronDown } from "lucide-react";
import { DiffOverview } from "./DiffOverview";
import { useDiffSplit } from "./useDiffSplit";

export function GitDiffEditor({ patch, title, staged, labels, contents, initialEdge, onBoundary, navigationBusy }: { patch: string; title: string; staged: boolean; labels?: [string, string]; contents?: [string, string]; initialEdge?: "first" | "last"; onBoundary?: (direction: number) => void; navigationBusy?: boolean }) {
  const { splitStyle, splitHandle } = useDiffSplit();
  const rows = useMemo(() => contents ? fullTextDiffRows(patch, ...contents) : parseGitDiff(patch), [patch, contents]);
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const binary = /^(?:Binary files |GIT binary patch)/m.test(patch);

  const changes = useMemo(() => diffChanges(rows), [rows]);
  const [selected, setSelected] = useState(-1);

  const getLeftOffset = (rowIndex: number) => {
    let offset = 0;
    for (let i = 0; i < rowIndex; i++) {
      offset += rows[i].heading ? 26 : 22;
    }
    return offset;
  };

  const selectChange = (index: number) => {
    const change = changes[index];
    if (!change) return;
    setSelected(index);
    for (const pane of [left.current, right.current]) {
      if (pane) pane.scrollTop = Math.max(0, getLeftOffset(change.start) - pane.clientHeight / 2 + 22);
    }
  };
  useEffect(() => {
    if (initialEdge && changes.length) selectChange(initialEdge === "last" ? changes.length - 1 : 0);
  }, [initialEdge, changes]);
  const jumpToDiff = (direction: number) => {
    if (navigationBusy) return;
    const target = selected < 0 ? (direction > 0 ? 0 : changes.length - 1) : selected + direction;
    if (target < 0 || target >= changes.length) { onBoundary?.(direction); return; }
    selectChange(target);
  };

  return <div tabIndex={-1} style={splitStyle} className="git-diff-editor outline-none focus:outline-none" aria-label="Git 双栏差异" onKeyDown={event => {
    if (event.key === "F7" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault(); event.stopPropagation(); jumpToDiff(event.shiftKey ? -1 : 1);
    }
  }}>
    <div className="git-diff-toolbar">
      <span className="truncate">{title}</span>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1">
          <span className="text-gray-400">{selected < 0 ? changes.length : `${selected + 1}/${changes.length}`} 处差异</span>
          <button disabled={navigationBusy || (!onBoundary && (!changes.length || selected === 0))} onClick={() => jumpToDiff(-1)} className="p-1 hover:bg-white/10 rounded text-gray-400 hover:text-white" title="上一处差异（文件开头继续查看上一文件）" aria-label="上一处差异"><ChevronUp size={14} /></button>
          <button disabled={navigationBusy || (!onBoundary && (!changes.length || selected === changes.length - 1))} onClick={() => jumpToDiff(1)} className="p-1 hover:bg-white/10 rounded text-gray-400 hover:text-white" title="下一处差异（文件末尾继续查看下一文件）" aria-label="下一处差异"><ChevronDown size={14} /></button>
        </div>
        <span className="shrink-0 text-gray-400">只读 · 左右同步滚动</span>
      </div>
    </div>
    <div className="git-diff-headings"><span>{labels?.[0] ?? (staged ? "HEAD · 提交前" : "暂存区 · 修改前")}</span><span>{labels?.[1] ?? (staged ? "暂存区 · 即将提交" : "工作区 · 修改后")}</span></div>
    {!rows.length ? <div className="p-4 text-sm text-gray-400">{binary ? "二进制文件已更改，无法显示文本对比。" : patch ? "文件属性已更改，无文本差异。" : "没有文本差异。"}</div> :
      <div className="git-diff-panes">
        {(["left", "right"] as const).map(side => <div key={side} className="git-diff-side"><div ref={side === "left" ? left : right} className="git-diff-pane outline-none" tabIndex={0} aria-label={side === "left" ? "原始内容" : "更改后内容"} onScroll={e => {
          const other = side === "left" ? right.current : left.current;
          if (other && other.scrollTop !== e.currentTarget.scrollTop) other.scrollTop = e.currentTarget.scrollTop;
        }}>
          <div className="git-diff-lines">{rows.map((row, i) => {
            const cell = row[side];
            return row.heading ? <div key={i} className="git-diff-hunk" title={row.heading}>{row.heading}</div> :
              <div key={i} className={`git-diff-line ${selected >= 0 && i >= changes[selected]?.start && i <= changes[selected]?.end ? "git-diff-current " : ""}${!cell ? "git-diff-placeholder" : cell.changed ? side === "left" ? "git-diff-removed" : "git-diff-added" : ""}`}>
                <span className="git-diff-number">{cell?.number}</span>
                <span className="git-diff-marker">{cell?.changed ? side === "left" ? "−" : "+" : ""}</span>
                <code>{cell?.text ?? " "}</code>
                {cell?.noNewline && <span className="text-gray-500" title="文件末尾无换行"> ⏎̸</span>}
              </div>;
          })}</div>
        </div><DiffOverview selected={selected} onSelect={selectChange} marks={changes.map(change => ({ top: getLeftOffset(change.start) / Math.max(1, getLeftOffset(rows.length)), height: (getLeftOffset(change.end + 1) - getLeftOffset(change.start)) / Math.max(1, getLeftOffset(rows.length)), kind: change.kind }))} /></div>)}
        {splitHandle}
      </div>}
  </div>;
}
