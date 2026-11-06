import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import * as ContextMenu from "@/lib/nativeMenu";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, useNodesState, type Node, type Edge, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { parseTreeGraph, layoutTreeMindMap, buildReverseTree, countTreeGraphNames, changeTreeNode, getTreeSubtree, type ReverseTreeNode } from "@/lib/treeGraph";
import { fsApi, type GraphCategory } from "@/lib/api";
import { useWorkspaceStore } from "@/store/workspaceStore";

function MindMapNode({ data }: NodeProps) {
  const comment = data.comment ? <span className="ml-1 text-[11px] text-amber-300" title={String(data.comment)}>*</span> : null;
  return <>
    <Handle type="target" position={data.side === -1 ? Position.Right : Position.Left} style={{ opacity: 0, pointerEvents: "none" }} />
    <Handle id="left" type="source" position={Position.Left} style={{ opacity: 0, pointerEvents: "none" }} />
    <Handle id="right" type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: "none" }} />
    <div className="mind-map-label">{String(data.label)}{Number(data.count) > 1 && <span className="ml-1 text-[10px] text-amber-300">×{String(data.count)}</span>}</div>
    {comment}
  </>;
}

const nodeTypes = { mindMap: MindMapNode };
const useTreeClipboard = create<{ content: string }>(() => ({ content: "" }));

// File-qualified IDs preserve source locations and distinguish duplicate labels.
export function buildTreeNetwork(content: string, path: string, color: string, counts = new Map<string, number>()) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  layoutTreeMindMap(parseTreeGraph(content), counts).forEach(({ node, x, y, width, height, depth, side, parent }) => {
    const id = `${path}#${node.id + 1}`;
    nodes.push({ id, type: "mindMap", position: { x, y },
      data: { label: node.name, comment: node.comment, count: counts.get(node.name) ?? 1, filePath: path, line: node.id + 1, side, depth },
      className: `mind-map-node ${depth === 0 ? "mind-map-root" : depth === 1 ? "mind-map-branch" : node.children.length ? "mind-map-topic" : "mind-map-leaf"}`,
      style: { width, height, "--mind-map-accent": color } as React.CSSProperties });
    if (parent !== undefined) {
      const source = `${path}#${parent + 1}`;
      edges.push({ id: `${source}->${id}`, source, target: id, sourceHandle: side === -1 ? "left" : "right", type: "default", style: { stroke: color, strokeWidth: 1, strokeOpacity: 0.35 } });
    }
  });
  return { nodes, edges };
}

export function TreeGraphPreview({ content, path, pane, previewOnly, reverseTree, onOpenSource, scrollLine, onScrollLine }: { content: string; path: string; pane: "left" | "right"; previewOnly: boolean; scrollLine?: number | null; onScrollLine?: (line: number) => void; reverseTree?: ReverseTreeNode; onOpenSource?: (path: string, line: number) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const clipboard = useTreeClipboard(state => state.content);
  const jump = useWorkspaceStore(state => state.graphLocation);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const [location, setLocation] = useState<{ path: string; line: number } | null>(null);
  useEffect(() => {
    if (!jump || jump.path !== path || jump.pane !== pane) return;
    setLocation({ path, line: jump.line });
    // The source editor consumes the shared request in split mode.
    const editorJump = useWorkspaceStore.getState().editorJump;
    if (previewOnly && editorJump?.path === jump.path && editorJump.line === jump.line && editorJump.pane === jump.pane) {
      useWorkspaceStore.setState({ editorJump: null });
    }
  }, [jump, path, pane, previewOnly]);
  const root = useWorkspaceStore(state => state.rootPath);
  const [categories, setCategories] = useState<GraphCategory[]>([]);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [treeSources, setTreeSources] = useState<{ path: string; content: string }[]>([]);
  const [contextNode, setContextNode] = useState<string | null>(null);
  const [nodeDialog, setNodeDialog] = useState<{ node: Node; mode: "edit" | "add"; value: string } | null>(null);
  const [error, setError] = useState("");
  const [commentDialog, setCommentDialog] = useState<{ node: Node; value: string } | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const value = await fsApi.getGraphCategories();
        const paths = [...new Set(value.flatMap(category => category.files))];
        const trees = await Promise.all(paths.map(async file => ({ path: file, content: useWorkspaceStore.getState().leftTabs.concat(useWorkspaceStore.getState().rightTabs).find(tab => tab.path === file && !tab.revision && tab.diff === undefined)?.content ?? await fsApi.readTreeFile(file) })));
        if (live) { setCategories(value); setTreeSources(trees); setCounts(countTreeGraphNames(trees)); setError(""); }
      } catch(cause) { if (live) setError(String(cause)); }
    };
    void refresh();
    window.addEventListener("nexusdesk:graph-colors", refresh);
    return () => { live = false; window.removeEventListener("nexusdesk:graph-colors", refresh); };
  }, [root]);
  const normalize = (value: string) => value.replace(/\\/g, "/").toLocaleLowerCase();
  const color = categories.find(category => category.files.some(file => normalize(file) === normalize(path)))?.color ?? "#60a5fa";
  const graph = useMemo(() => reverseTree ? buildReverseTreeNetwork(reverseTree, color, counts) : buildTreeNetwork(content, path, color, counts), [content, path, color, counts, reverseTree]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  useEffect(() => { setNodes(graph.nodes); }, [graph.nodes, setNodes]);
  useEffect(() => {
    if (!flow || location?.path !== path) return;
    const id = `${path}#${location.line}`;
    const target = nodes.find(node => node.id === id);
    if (!target?.measured?.width || !target.measured.height) return;
    setNodes(current => current.map(node => ({ ...node, selected: node.id === id })));
    void flow.fitView({ nodes: [{ id }], duration: 300, minZoom: 0.8, maxZoom: 1.2, padding: 0.5 });
    setLocation(null);
  }, [flow, location, nodes, path, setNodes]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !flow) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const node = flow.getNodes().find(item => item.selected);
        if (node) void flow.fitView({ nodes: [{ id: node.id }], duration: 0, minZoom: 0.8, maxZoom: 1.2, padding: 0.5 });
      });
    });
    observer.observe(container);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [flow]);
  const userMoving = useRef(false);
  useEffect(() => {
    if (!flow || previewOnly || scrollLine == null || userMoving.current) return;
    const target = flow.getNodes().filter(node => node.data.filePath === path)
      .sort((a, b) => Math.abs(Number(a.data.line) - scrollLine) - Math.abs(Number(b.data.line) - scrollLine))[0];
    if (!target) return;
    void flow.setCenter(target.position.x + (target.measured?.width ?? 0) / 2,
      target.position.y + (target.measured?.height ?? 0) / 2, { zoom: flow.getZoom(), duration: 0 });
  }, [flow, scrollLine, previewOnly, path]);

  const locate = (node: Node) => {
    const filePath = String(node.data.filePath || path);
    useWorkspaceStore.getState().locateGraph(filePath, Number(node.data.line), pane);
  };
  const editComment = () => {
    const node = nodes.find(item => item.id === contextNode);
    if (!node) return;
    setCommentDialog({ node, value: String(node.data.comment ?? "") });
  };
  const updateNode = (node: Node, action: "edit" | "add" | "delete" | "comment" | "paste", value = "") => {
    if (reverseTree) return;
    const state = useWorkspaceStore.getState();
    const tabs = pane === "left" ? state.leftTabs : state.rightTabs;
    const tab = tabs.find(item => item.path === path && !item.revision && item.diff === undefined);
    if (tab) state.updateTabContent(tab.id, changeTreeNode(tab.content ?? content, Number(node.data.line), action, value), pane);
  };
  const saveComment = () => {
    if (!commentDialog) return;
    updateNode(commentDialog.node, "comment", commentDialog.value);
    setCommentDialog(null);
  };
  const selectedNode = nodes.find(item => item.id === contextNode);
  const contextName = selectedNode ? String(selectedNode.data.label) : "";
  return <ContextMenu.Root><ContextMenu.Trigger asChild onContextMenu={event => {
    const id = (event.target as HTMLElement).closest<HTMLElement>(".react-flow__node")?.dataset.id;
    const node = nodes.find(item => item.id === id);
    setContextNode(node?.id ?? null);
    if (!node && (!clipboard || reverseTree)) event.preventDefault();
  }}><div ref={containerRef} className="h-full min-h-0 relative" aria-label="Tree 网状图预览">
    {error && <p role="alert" className="absolute top-2 left-2 z-10 text-xs text-red-400">读取目录颜色失败：{error}</p>}
    {nodes.length ? <ReactFlow key={path} onInit={setFlow}
      onMoveStart={event => { if (event) userMoving.current = true; }}
      onMove={event => {
        if (!event || !flow || previewOnly || !onScrollLine) return;
        const bounds = containerRef.current?.getBoundingClientRect();
        if (!bounds) return;
        const center = flow.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
        const closest = flow.getNodes().filter(node => node.data.filePath === path).sort((a, b) => {
          const distance = (node: Node) => Math.hypot(node.position.x + (node.measured?.width ?? 0) / 2 - center.x, node.position.y + (node.measured?.height ?? 0) / 2 - center.y);
          return distance(a) - distance(b);
        })[0];
        if (closest) onScrollLine(Number(closest.data.line));
      }}
      onMoveEnd={event => { if (event) userMoving.current = false; }} onNodeDoubleClick={(_, node) => onOpenSource && node.data.filePath ? onOpenSource(String(node.data.filePath), Number(node.data.line)) : locate(node)} zoomOnDoubleClick={false} onKeyDown={event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const id = (event.target as HTMLElement).closest<HTMLElement>(".react-flow__node")?.dataset.id;
      const node = nodes.find(item => item.id === id);
      if (node) { event.preventDefault(); onOpenSource && node.data.filePath ? onOpenSource(String(node.data.filePath), Number(node.data.line)) : locate(node); }
    }} nodeTypes={nodeTypes} nodes={nodes} edges={graph.edges} onNodesChange={onNodesChange} fitView minZoom={0.05} maxZoom={3} nodesConnectable={false} colorMode="dark">
      <Background /><Controls /><MiniMap nodeColor={color} pannable zoomable />
    </ReactFlow> : <p className="p-4 text-sm text-gray-500">暂无节点，请在源码中使用缩进编写图谱。</p>}
  </div></ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Content className="ide-menu w-52 text-xs" collisionPadding={8} aria-label="图谱节点操作">
    <ContextMenu.Item className="ide-menu-item" disabled={!contextNode || (counts.get(contextName) ?? 0) < 2} onSelect={() => {
      if (!contextNode) return;
      const reverseTree = buildReverseTree(contextName, treeSources);
      useWorkspaceStore.getState().openTab({ id: `reverse-tree:${root}:${contextName}:${Date.now()}`, path: `reverse-tree:${contextName}`, title: `反向树 · ${contextName}`, content: "", reverseTree, markdownMode: "preview" });
    }}>查看反向生成树</ContextMenu.Item>
    <ContextMenu.Item className="ide-menu-item" disabled={!contextNode || !!reverseTree} onSelect={editComment}>编辑备注</ContextMenu.Item>
    {!reverseTree && <>
      <ContextMenu.Item className="ide-menu-item" disabled={!selectedNode} onSelect={() => {
        if (!selectedNode) return;
        const state = useWorkspaceStore.getState();
        const tabs = pane === "left" ? state.leftTabs : state.rightTabs;
        const tab = tabs.find(item => item.path === path && !item.revision && item.diff === undefined);
        if (!tab) return;
        const subtree = getTreeSubtree(tab.content ?? content, Number(selectedNode.data.line));
        if (!subtree) return;
        useTreeClipboard.setState({ content: subtree });
        updateNode(selectedNode, "delete");
      }}>剪切节点</ContextMenu.Item>
      <ContextMenu.Item className="ide-menu-item" disabled={!clipboard} onSelect={() => {
        if (!clipboard) return;
        const state = useWorkspaceStore.getState();
        const tabs = pane === "left" ? state.leftTabs : state.rightTabs;
        const tab = tabs.find(item => item.path === path && !item.revision && item.diff === undefined);
        if (!tab) return;
        if (selectedNode) updateNode(selectedNode, "paste", clipboard);
        else {
          const source = tab.content ?? content;
          const newline = source.includes("\r\n") ? "\r\n" : "\n";
          state.updateTabContent(tab.id, source + (source && !source.endsWith("\n") ? newline : "") + clipboard.replace(/\n/g, newline), pane);
        }
        useTreeClipboard.setState({ content: "" });
      }}>粘贴节点{selectedNode ? "（作为子节点）" : "（作为根节点）"}</ContextMenu.Item>
      <ContextMenu.Item className="ide-menu-item" onSelect={() => selectedNode && setNodeDialog({ node: selectedNode, mode: "add", value: "" })}>添加子节点</ContextMenu.Item>
      <ContextMenu.Item className="ide-menu-item" onSelect={() => selectedNode && setNodeDialog({ node: selectedNode, mode: "edit", value: String(selectedNode.data.label) })}>编辑节点</ContextMenu.Item>
      <ContextMenu.Item className="ide-menu-item" onSelect={() => selectedNode && updateNode(selectedNode, "delete")}>删除节点及子节点</ContextMenu.Item>
    </>}
  </ContextMenu.Content></ContextMenu.Portal>
  <Dialog.Root open={!!nodeDialog} onOpenChange={open => { if (!open) setNodeDialog(null); }}>
    <Dialog.Portal><Dialog.Overlay className="search-overlay" /><Dialog.Content className="create-name-dialog">
      <header className="flex items-center justify-between border-b border-ide-panel-border px-4 py-3"><Dialog.Title>{nodeDialog?.mode === "add" ? "添加子节点" : "编辑节点"}</Dialog.Title><Dialog.Close aria-label="关闭"><X size={16} /></Dialog.Close></header>
      <form className="flex flex-col gap-3 p-4" onSubmit={event => {
        event.preventDefault();
        if (!nodeDialog?.value.trim() || nodeDialog.value.includes("//")) return;
        updateNode(nodeDialog.node, nodeDialog.mode, nodeDialog.value);
        setNodeDialog(null);
      }}>
        <Dialog.Description className="text-xs text-gray-400">输入节点名称，不能包含 //。</Dialog.Description>
        <input autoFocus aria-label="节点名称" required value={nodeDialog?.value ?? ""} onChange={event => setNodeDialog(current => current ? { ...current, value: event.target.value } : current)} className="rounded border border-ide-panel-border bg-ide-bg px-3 py-2 text-sm" />
        <footer className="flex justify-end gap-2"><Dialog.Close className="rounded border border-ide-panel-border px-4 py-1.5">取消</Dialog.Close><button type="submit" disabled={!nodeDialog?.value.trim() || nodeDialog.value.includes("//")} className="rounded bg-ide-accent px-4 py-1.5 text-white">保存</button></footer>
      </form>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>
  <Dialog.Root open={!!commentDialog} onOpenChange={open => { if (!open) setCommentDialog(null); }}>
    <Dialog.Portal><Dialog.Overlay className="search-overlay" /><Dialog.Content className="create-name-dialog" onOpenAutoFocus={event => { event.preventDefault(); document.getElementById("tree-node-comment")?.focus(); }}>
      <header className="flex items-center justify-between border-b border-ide-panel-border px-4 py-3"><Dialog.Title className="font-medium">编辑节点备注</Dialog.Title><Dialog.Close aria-label="关闭" className="rounded p-1 hover:bg-white/10"><X size={16} /></Dialog.Close></header>
      <form className="flex flex-col gap-3 p-4" onSubmit={event => { event.preventDefault(); saveComment(); }}><Dialog.Description className="text-xs text-gray-400">备注将以 <code>//</code> 写入当前节点行。</Dialog.Description><textarea id="tree-node-comment" value={commentDialog?.value ?? ""} onChange={event => setCommentDialog(current => current ? { ...current, value: event.target.value } : current)} rows={4} maxLength={500} placeholder="输入节点备注（可留空以删除）" className="w-full resize-y rounded border border-ide-panel-border bg-ide-bg px-3 py-2 text-sm outline-none focus:border-ide-accent" /><footer className="flex justify-end gap-2"><Dialog.Close className="rounded border border-ide-panel-border px-4 py-1.5 hover:bg-white/10">取消</Dialog.Close><button type="submit" className="rounded bg-ide-accent px-4 py-1.5 text-white">保存</button></footer></form>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>
  </ContextMenu.Root>;
}

function buildReverseTreeNetwork(root: ReverseTreeNode, color: string, counts: Map<string, number>) {
  let nextId = 0;
  const layoutRoot = (node: ReverseTreeNode): any => ({ ...node, id: nextId++, children: node.children.map(layoutRoot) });
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const tree = layoutTreeMindMap([layoutRoot(root)], counts);
  tree.forEach(({ node, x, y, width, height, depth, side, parent }) => {
    const source = node as ReverseTreeNode;
    const id = `reverse:${node.id}`;
    nodes.push({ id, type: "mindMap", position: { x, y }, data: { label: node.name, count: counts.get(node.name) ?? 1, filePath: source.sourcePath, line: source.sourceLine, side, depth }, className: `mind-map-node ${depth === 0 ? "mind-map-root" : depth === 1 ? "mind-map-branch" : node.children.length ? "mind-map-topic" : "mind-map-leaf"}`, style: { width, height, "--mind-map-accent": color } as React.CSSProperties });
    if (parent !== undefined) {
      const parentNode = tree.find(item => item.node.id === parent)?.node as ReverseTreeNode | undefined;
      if (parentNode) edges.push({ id: `${parent}->${node.id}`, source: `reverse:${parent}`, target: id, sourceHandle: side === -1 ? "left" : "right", type: "default", style: { stroke: color, strokeWidth: 1, strokeOpacity: 0.35 } });
    }
  });
  return { nodes, edges };
}
