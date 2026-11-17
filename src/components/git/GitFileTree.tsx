import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { Tree, type NodeRendererProps, type RowRendererProps } from "react-arborist";
import { buildGitTree, summarizeGitTree, type GitTreeNode } from "@/lib/gitFileTree";

export interface GitTreeTarget { path: string; directory: boolean }

interface Selection<T> {
  checked: (file: T) => boolean;
  eligible: (file: T) => boolean;
  pending: (file: T) => boolean;
  disabled: boolean;
  onChange: (files: T[], checked: boolean) => void;
}

interface Props<T> {
  files: T[];
  rootName?: string;
  rootPath?: string;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>, targets: GitTreeTarget[]) => void;
  onDirectoryContextMenu?: (event: MouseEvent<HTMLDivElement>, path: string) => void;
  renderFile: (file: T, name: string) => ReactNode;
  selection?: Selection<T>;
}

interface RowContext {
  renderFile: (path: string, name: string) => ReactNode;
  summary: ReturnType<typeof summarizeGitTree>;
  selection?: { disabled: boolean; onChange: (node: GitTreeNode, checked: boolean) => void };
  rootPath?: string;
  context: (event: MouseEvent<HTMLDivElement>, node: GitTreeNode, targets: GitTreeTarget[]) => void;
}

const RowContext = createContext<RowContext | null>(null);

function GitTreeRowContainer({ attrs, innerRef, children }: RowRendererProps<GitTreeNode>) {
  return <div {...attrs} style={{ ...attrs.style, minWidth: 0 }} ref={innerRef} onFocus={event => event.stopPropagation()}>{children}</div>;
}

function GitTreeRow({ node, tree, style }: NodeRendererProps<GitTreeNode>) {
  const context = useContext(RowContext)!;
  const data = node.data;
  const counts = context.summary.get(data.id)!;
  const checked = counts.eligible > 0 && counts.checked === counts.eligible;
  const mixed = counts.checked > 0 && !checked;
  return <div style={style} className={`h-full min-w-0 ${node.isSelected && !data.root ? "bg-ide-selection" : "hover:bg-ide-tree-hover"}`}
    onClickCapture={event => {
      if (data.root || (event.target as HTMLElement).closest("input")) return;
      if (event.shiftKey) node.selectContiguous();
      else if (event.ctrlKey || event.metaKey) {
        if (node.isSelected) node.deselect(); else node.selectMulti();
      } else node.select();
      if (event.shiftKey || event.ctrlKey || event.metaKey) { event.preventDefault(); event.stopPropagation(); }
    }}
    onContextMenu={event => {
      if (data.root) { event.preventDefault(); event.stopPropagation(); return; }
      const targets = node.isSelected ? tree.selectedNodes : [node];
      if (!node.isSelected) node.select();
      context.context(event, data, targets.filter(target => !target.data.root).map(target => ({ path: target.data.path, directory: !target.isLeaf })));
    }}>
    {node.isLeaf ? context.renderFile(data.path, data.name) : <div className="flex h-full min-w-0 items-center gap-2">
      {context.selection && <input type="checkbox" className={`shrink-0 accent-blue-500 ${!counts.eligible ? "cursor-not-allowed" : context.selection.disabled || counts.pending > 0 ? "cursor-wait" : "cursor-pointer"}`}
        aria-label={data.root ? `暂存项目 ${data.name}` : `暂存目录 ${data.path}`} aria-checked={mixed ? "mixed" : checked}
        checked={checked} ref={input => { if (input) input.indeterminate = mixed; }}
        disabled={context.selection.disabled || !counts.eligible || counts.pending > 0}
        onChange={event => context.selection!.onChange(data, event.currentTarget.checked)} />}
      <button className="flex min-w-0 flex-1 items-center gap-1 text-gray-400 text-left" aria-expanded={node.isOpen}
        title={data.root ? context.rootPath : data.path} onClick={() => node.toggle()}>
        {node.isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Folder size={13} className="shrink-0" />
        <span className="truncate">{data.name}</span>
        <span className="shrink-0 text-gray-500">{data.root ? `（已暂存 ${counts.checked} / ${counts.eligible}）` : `(${counts.total})`}</span>
      </button>
    </div>}
  </div>;
}

export function GitFileTree<T extends { path: string }>({ files, rootName, rootPath, renderFile, selection, onContextMenu, onDirectoryContextMenu }: Props<T>) {
  const container = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(300);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);
  // 暂存状态变化时保留树结构，避免重复构建和排序。
  const pathsKey = JSON.stringify(files.map(file => file.path));
  const nodes = useMemo(() => buildGitTree(JSON.parse(pathsKey) as string[], rootName), [pathsKey, rootName]);
  const byPath = useMemo(() => new Map(files.map(file => [file.path, file])), [files]);
  const summary = useMemo(() => summarizeGitTree(nodes, path => {
    const file = byPath.get(path)!;
    const eligible = !!selection?.eligible(file);
    return { eligible: Number(eligible), checked: Number(eligible && selection!.checked(file)), pending: Number(eligible && selection!.pending(file)) };
  }), [nodes, byPath, selection]);
  const context: RowContext = {
    summary, rootPath,
    renderFile: (path, name) => renderFile(byPath.get(path)!, name),
    selection: selection && { disabled: selection.disabled, onChange: (node, checked) => {
      const candidates: T[] = [];
      function collect(current: GitTreeNode) {
        if (current.children) current.children.forEach(collect);
        else {
          const file = byPath.get(current.path)!;
          if (selection!.eligible(file)) candidates.push(file);
        }
      }
      collect(node);
      selection!.onChange(candidates, checked);
    } },
    context: (event, node, targets) => {
      if (node.children && onDirectoryContextMenu) onDirectoryContextMenu(event, node.path);
      else onContextMenu?.(event, targets);
    },
  };
  return <div ref={container} className="flex-1 min-h-0 select-none overflow-hidden">
    <RowContext.Provider value={context}>
      <Tree data={nodes} height={height} width="100%" rowHeight={28} indent={14} overscanCount={8} renderRow={GitTreeRowContainer}
        openByDefault={false} initialOpenState={{ "git-project-root": true }} disableDrag disableDrop disableEdit
        disableSelect={node => !!node.root}>
        {GitTreeRow}
      </Tree>
    </RowContext.Provider>
  </div>;
}
