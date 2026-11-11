import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { Decoration, EditorView, drawSelection, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { fsApi } from "@/lib/api";
import { diffChanges, originalFromPatch, parseGitDiff, type DiffChange } from "@/lib/gitDiff";
import { DiffOverview } from "./DiffOverview";
import { useDiffSplit } from "./useDiffSplit";

export function EditableGitDiff({ path, patch, contents, title, labels, onChange, initialEdge, onBoundary, navigationBusy }: {
  path: string; patch: string; contents?: [string, string]; title: string;
  labels?: [string, string]; onChange: (text: string) => void;
  initialEdge?: "first" | "last"; onBoundary?: (direction: number) => void; navigationBusy?: boolean;
}) {
  const { splitStyle, splitHandle } = useDiffSplit();
  const hosts = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const callback = useRef(onChange);
  const editorViews = useRef<EditorView[]>([]);
  const changesRef = useRef<DiffChange[]>([]);
  const selectedRef = useRef(-1);
  const cursorLine = useRef<number | null>(null);
  const jumping = useRef(false);
  const [changes, setChanges] = useState<DiffChange[]>([]);
  const [selected, setSelected] = useState(-1);
  const [lineCounts, setLineCounts] = useState([1, 1]);
  const selectChange = (index: number) => {
    const change = changesRef.current[index];
    if (!change) return;
    selectedRef.current = index; setSelected(index);
    cursorLine.current = null;
    jumping.current = true;
    editorViews.current.forEach((view, side) => {
      const line = Math.min(view.state.doc.lines, side ? change.rightLine : change.leftLine);
      const position = view.state.doc.line(line).from;
      view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "center" }) });
    });
    jumping.current = false;
  };
  callback.current = onChange;
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    let views: EditorView[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let scrolling = false;
    let firstRefresh = true;
    setReady(false); setError("");
    const init = async () => {
      const right = contents?.[1] ?? await fsApi.readFile(path);
      const left = contents?.[0] ?? originalFromPatch(patch, right);
      if (disposed) return;
      const refresh = async () => {
        const token = ++generation;
        const text = views[1].state.doc.toString();
        try {
          const diff = await fsApi.compareText(left, text);
          if (disposed || token !== generation) return;
          const rows = parseGitDiff(diff);
          const blocks = diffChanges(rows);
          changesRef.current = blocks; setChanges(blocks);
          setLineCounts(views.map(view => view.state.doc.lines));
          views.forEach((view, index) => {
            const numbers = new Set(rows.flatMap(row => {
              const cell = index ? row.right : row.left;
              return cell?.changed ? [cell.number] : [];
            }));
            view.dispatch({ effects: highlights[index].reconfigure(EditorView.decorations.of(Decoration.set(
              [...numbers].sort((a, b) => a - b).filter(n => n <= view.state.doc.lines).map(n =>
                Decoration.line({ class: index ? "git-diff-added" : "git-diff-removed" }).range(view.state.doc.line(n).from)),
            ))) });
          });
          if (firstRefresh) {
            firstRefresh = false;
            if (initialEdge && blocks.length) selectChange(initialEdge === "last" ? blocks.length - 1 : 0);
          } else {
            selectedRef.current = -1; setSelected(-1);
          }
        } catch (e) { if (!disposed && token === generation) setError(String(e)); }
      };
      const highlights = [new Compartment(), new Compartment()];
      views = [left, right].map((doc, index) => new EditorView({
        parent: hosts[index].current!,
        state: EditorState.create({ doc, extensions: [
          lineNumbers(), drawSelection(), history(), search({ top: true }),
          EditorState.phrases.of({
            "next": "下一个",
            "previous": "上一个",
            "all": "全部",
            "match case": "区分大小写",
            "regexp": "正则表达式",
            "by word": "全词匹配",
            "replace": "替换",
            "replace all": "全部替换",
            "close": "关闭",
            "Find": "查找",
            "Replace": "替换为",
          }),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab, { key: "Mod-f", run: openSearchPanel }, ...searchKeymap]),
          EditorState.readOnly.of(index === 0), EditorView.editable.of(index === 1),
          EditorView.contentAttributes.of(index
            ? { "aria-label": "更改后内容（可编辑）" }
            : { "aria-label": "原始内容（只读）", tabindex: "0" }),
          highlights[index].of([]),
          EditorView.theme({ "&": { height: "100%", fontSize: "12px", backgroundColor: "var(--ide-bg)", color: "var(--ide-text)" },
            "&.cm-focused": { outline: "none" },
            ".cm-scroller": { overflow: "auto", fontFamily: "Consolas, monospace" },
            ".cm-content": { minHeight: "100%" },
            ".cm-gutters": { backgroundColor: "var(--ide-bg)", color: "#777d88", borderRight: "1px solid #43454a" },
            ".cm-cursor": { borderLeftColor: "#82a8ed" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "#4060a060" },
            ".cm-panel.cm-search": { backgroundColor: "var(--ide-panel-bg)", color: "var(--ide-fg)", padding: "8px 12px", borderBottom: "1px solid var(--ide-panel-border)", fontFamily: "inherit", fontSize: "12px", lineHeight: "28px" },
            ".cm-panels-top": { borderBottom: "none" },
            ".cm-search input": { backgroundColor: "var(--ide-bg)", color: "var(--ide-fg)", border: "1px solid var(--ide-panel-border)", borderRadius: "4px", padding: "4px 8px", outline: "none", fontSize: "12px", marginRight: "8px", verticalAlign: "middle" },
            ".cm-search input:focus": { borderColor: "var(--ide-accent)" },
            ".cm-search button": { backgroundColor: "var(--ide-bg)", backgroundImage: "none", color: "var(--ide-fg)", border: "1px solid var(--ide-panel-border)", borderRadius: "4px", padding: "4px 10px", cursor: "pointer", fontSize: "12px", transition: "all 0.2s", marginRight: "8px", verticalAlign: "middle" },
            ".cm-search button:hover": { backgroundColor: "var(--ide-selection-inactive)" },
            ".cm-search label": { display: "inline-flex", position: "relative", alignItems: "center", justifyContent: "center", padding: "4px", borderRadius: "4px", cursor: "pointer", fontSize: "0 !important", lineHeight: "20px", marginRight: "8px", verticalAlign: "middle" },
            ".cm-search label::after": { fontSize: "13px" },
            '.cm-search label:has(input[name="case"])::after': { content: '"Aa"' },
            '.cm-search label:has(input[name="re"])::after': { content: '".*"' },
            '.cm-search label:has(input[name="word"])::after': { content: '"Ab"' },
            ".cm-search label:has(input:checked)": { backgroundColor: "#3574f0", color: "white" },
            ".cm-search label:has(input:focus-visible)": { outline: "2px solid var(--ide-accent)", outlineOffset: "2px" },
            ".cm-search input[type=checkbox]": { position: "absolute", opacity: "0", width: "1px", height: "1px", padding: "0", margin: "0", border: "none" },
            ".cm-search [name=close]": { position: "absolute", top: "8px", right: "8px", display: "flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", padding: "0", border: "none", fontSize: "16px", backgroundColor: "transparent", cursor: "pointer", marginRight: "0" },
            ".cm-search [name=close]:hover": { color: "white" },
          }),
          EditorView.domEventHandlers({ scroll: (_event, view) => {
            if (scrolling) return;
            const other = views[1 - index];
            if (other && other.scrollDOM.scrollTop !== view.scrollDOM.scrollTop) { scrolling = true; other.scrollDOM.scrollTop = view.scrollDOM.scrollTop; scrolling = false; }
          } }),
          EditorView.updateListener.of(update => {
            if (index && update.selectionSet && !jumping.current) {
              cursorLine.current = update.state.doc.lineAt(update.state.selection.main.head).number;
              selectedRef.current = -1; setSelected(-1);
            }
            if (!index || !update.docChanged) return;
            generation++;
            callback.current(update.state.doc.toString());
            clearTimeout(timer); timer = setTimeout(() => void refresh(), 180);
          }),
        ] }),
      }));
      editorViews.current = views;
      setReady(true);
      void refresh();
    };
    void init().catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; clearTimeout(timer); views.forEach(view => view.destroy()); editorViews.current = []; };
    // A comparison owns its editor state; typing must not recreate it or reset undo/selection.
  }, [path]);
  const jump = (direction: number) => {
    const blocks = changesRef.current;
    if (!ready || navigationBusy) return;
    const line = cursorLine.current;
    const target = line !== null ? (direction > 0 ? blocks.findIndex(block => block.rightLine > line)
      : blocks.reduce((found, block, index) => block.rightLine < line ? index : found, -1))
      : selectedRef.current < 0 ? (direction > 0 ? 0 : blocks.length - 1) : selectedRef.current + direction;
    if (target < 0 || target >= blocks.length) { onBoundary?.(direction); return; }
    selectChange(target);
  };
  return <div tabIndex={-1} style={splitStyle} className="git-diff-editor outline-none focus:outline-none" onKeyDown={event => {
    if (event.key === "F7" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault(); event.stopPropagation(); jump(event.shiftKey ? -1 : 1);
    }
  }}>
    <div className="git-diff-toolbar"><span className="truncate">{title}</span><div className="flex shrink-0 items-center gap-3"><span className="text-gray-400">{selected < 0 ? changes.length : `${selected + 1}/${changes.length}`} 处差异</span><button disabled={!ready || navigationBusy || (!onBoundary && (!changes.length || selected === 0))} onClick={() => jump(-1)} title="上一处差异（文件开头继续查看上一文件）" aria-label="上一处差异">↑</button><button disabled={!ready || navigationBusy || (!onBoundary && (!changes.length || selected === changes.length - 1))} onClick={() => jump(1)} title="下一处差异（文件末尾继续查看下一文件）" aria-label="下一处差异">↓</button><span>左侧只读 · 右侧可编辑</span></div></div>
    <div className="git-diff-headings"><span>{labels?.[0] ?? "暂存区 · 修改前"}</span><span>{labels?.[1] ?? "工作区 · 修改后"}</span></div>
    {error && <div role="alert" className="p-2 text-sm text-red-400">{error}</div>}
    {!ready && !error && <div className="p-2 text-sm">正在加载…</div>}
    <div className="git-diff-panes">{hosts.map((ref, i) => <div key={i} className="git-diff-side">
      <div ref={ref} className="min-w-0 h-full flex-1" />
      <DiffOverview selected={selected} onSelect={selectChange} marks={changes.map(change => ({
        top: ((i ? change.rightLine : change.leftLine) - 1) / lineCounts[i],
        height: Math.max(1, i ? change.rightCount : change.leftCount) / lineCounts[i], kind: change.kind,
      }))} />
    </div>)}{splitHandle}</div>
  </div>;
}
