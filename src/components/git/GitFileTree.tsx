import { useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";

interface Node<T> { name: string; path: string; children: Map<string, Node<T>>; descendants: T[]; file?: T }

export interface GitTreeTarget { path: string; directory: boolean }

export function GitFileTree<T extends { path: string }>({ files, renderFile, selection, onContextMenu, onDirectoryContextMenu }: {
  files: T[];
  onContextMenu?: (event: MouseEvent<HTMLDivElement>, targets: GitTreeTarget[]) => void;
  onDirectoryContextMenu?: (event: MouseEvent<HTMLDivElement>, path: string) => void;
  renderFile: (file: T, name: string) => ReactNode;
  selection?: { checked: (file: T) => boolean; eligible: (file: T) => boolean; pending: (file: T) => boolean; disabled: boolean; onChange: (files: T[], checked: boolean) => void };
}) {
  const tree = useMemo(() => {
    const root: Node<T> = { name: "", path: "", children: new Map(), descendants: [] };
    for (const file of files) {
      let node = root;
      for (const name of file.path.split("/")) {
        let child = node.children.get(name);
        if (!child) { child = { name, path: node.path ? `${node.path}/${name}` : name, children: new Map(), descendants: [] }; node.children.set(name, child); }
        child.descendants.push(file);
        node = child;
      }
      node.file = file;
    }
    return root;
  }, [files]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const sorted = (node: Node<T>) => [...node.children.values()].sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
  const visible: GitTreeTarget[] = [];
  function collect(node: Node<T>) {
    for (const child of sorted(node)) {
      visible.push({ path: child.path, directory: !child.file });
      if (!child.file && expanded.has(child.path)) collect(child);
    }
  }
  collect(tree);
  function select(event: MouseEvent, path: string) {
    if (!onContextMenu || (event.target as HTMLElement).closest('input')) return;
    const additive = event.ctrlKey || event.metaKey;
    let next = additive ? new Set(selectedPaths) : new Set<string>();
    if (event.shiftKey) {
      const from = visible.findIndex(row => row.path === anchor.current);
      const to = visible.findIndex(row => row.path === path);
      for (const row of visible.slice(from < 0 ? to : Math.min(from, to), Math.max(from, to) + 1)) next.add(row.path);
    } else {
      if (additive && next.has(path)) next.delete(path); else next.add(path);
      anchor.current = path;
    }
    setSelectedPaths(next);
    if (additive || event.shiftKey) { event.preventDefault(); event.stopPropagation(); }
  }
  function context(event: MouseEvent<HTMLDivElement>, path: string) {
    if (!onContextMenu) return;
    const paths = selectedPaths.has(path) ? selectedPaths : new Set([path]);
    setSelectedPaths(paths);
    if (!selectedPaths.has(path)) anchor.current = path;
    onContextMenu(event, visible.filter(row => paths.has(row.path)));
  }
  function render(node: Node<T>, depth: number): ReactNode {
    return sorted(node).map(child => {
      const eligible = selection ? child.descendants.filter(selection.eligible) : [];
      const selected = selection ? eligible.filter(selection.checked).length : 0;
      const checked = eligible.length > 0 && selected === eligible.length;
      const mixed = selected > 0 && !checked;
      const rowClass = `hover:bg-ide-tree-hover ${onContextMenu && selectedPaths.has(child.path) ? "bg-ide-selection" : ""}`;
      return child.file ? <div key={child.path} className={rowClass} onClickCapture={event => select(event, child.path)} onContextMenu={event => context(event, child.path)} style={{ paddingLeft: depth * 14 }}>{renderFile(child.file, child.name)}</div> :
        <div key={child.path}>
          <div onClickCapture={event => select(event, child.path)} onContextMenu={event => {
            if (onDirectoryContextMenu) onDirectoryContextMenu(event, child.path);
            else context(event, child.path);
          }} className={`flex items-center gap-2 py-1 ${rowClass}`} style={{ paddingLeft: depth * 14 }}>
          {selection && <input type="checkbox" className="shrink-0 accent-blue-500 cursor-pointer" aria-label={`暂存目录 ${child.path}`} aria-checked={mixed ? "mixed" : checked} checked={checked} ref={input => { if (input) input.indeterminate = mixed; }} disabled={selection.disabled || !eligible.length || eligible.some(selection.pending)} onChange={e => selection.onChange(eligible, e.currentTarget.checked)} />}
          <button className="flex min-w-0 flex-1 items-center gap-1 text-gray-400 text-left" aria-expanded={expanded.has(child.path)} onClick={() => setExpanded(prev => {
            const next = new Set(prev); if (next.has(child.path)) next.delete(child.path); else next.add(child.path); return next;
          })}>{expanded.has(child.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Folder size={13} /><span className="truncate">{child.name}</span><span className="text-gray-500">({child.descendants.length})</span></button>
          </div>
          {expanded.has(child.path) && render(child, depth + 1)}
        </div>;
    });
  }
  return <div className={onContextMenu ? "select-none" : undefined}>{render(tree, 0)}</div>;
}
