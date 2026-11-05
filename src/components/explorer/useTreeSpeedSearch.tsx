import React, { useEffect, useRef, useState } from "react";
import type { NodeApi, TreeApi } from "react-arborist";
import { Filter } from "lucide-react";

// Prefer contiguous matches, then allow abbreviated names such as "PT".
export function matchTreeName(name: string, query: string): number[] | null {
  if (!query) return null;
  const text = name.toLowerCase();
  const term = query.toLowerCase();
  const start = text.indexOf(term);
  if (start >= 0) return Array.from({ length: term.length }, (_, i) => start + i);
  const positions: number[] = [];
  let cursor = 0;
  for (const letter of term) {
    const index = text.indexOf(letter, cursor);
    if (index < 0) return null;
    positions.push(index);
    cursor = index + 1;
  }
  return positions;
}

export function useTreeSpeedSearch(treeRef: React.RefObject<TreeApi<any> | null>, workspace: string | null) {
  const search = useNameSpeedSearch({
    entries: () => (treeRef.current?.visibleNodes ?? []).map(node => ({ id: node.id, name: node.data.name })),
    selectedId: () => treeRef.current?.mostRecentNode?.id,
    select: id => treeRef.current?.select(id, { focus: false }),
    activate: id => treeRef.current?.activate(id),
    focus: () => treeRef.current?.listEl.current?.closest<HTMLElement>('[role="tree"]')?.focus(),
  }, workspace);
  return {
    ...search,
    treeSearchProps: {
      searchTerm: search.filterTerm,
      searchMatch: (node: NodeApi<any>, term: string) => matchTreeName(node.data.name, term) !== null,
    },
  };
}

type NameSearchOptions = {
  entries: () => { id: string; name: string }[];
  selectedId: () => string | null | undefined;
  select: (id: string) => void;
  activate: (id: string) => void;
  focus: () => void;
  label?: string;
};

export function useNameSpeedSearch(options: NameSearchOptions, workspace: string | null) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterEnabled, setFilterEnabled] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = () => options.entries().filter(node => matchTreeName(node.name, query));
  const close = () => { setSearchOpen(false); setQuery(""); setFilterEnabled(false); options.focus(); };

  useEffect(() => { setSearchOpen(false); setQuery(""); setFilterEnabled(false); }, [workspace]);
  useEffect(() => {
    if (!searchOpen) return;
    inputRef.current?.focus();
    if (!query) return;
    const nodes = matches();
    const node = nodes.find(node => node.id === options.selectedId()) ?? nodes[0];
    if (node) options.select(node.id);
  }, [searchOpen, query, filterEnabled]);

  const onKeyDownCapture = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing || event.key.length !== 1 || event.key === " ") return;
    event.preventDefault();
    event.stopPropagation();
    setSearchOpen(true);
    setQuery(event.key);
  };

  const searchBox = searchOpen ? (
    <div className="absolute right-2 top-1 z-20 flex max-w-[calc(100%-16px)] items-center gap-2 rounded border border-ide-panel-border bg-ide-panel-bg px-2 py-1 text-xs shadow-lg">
      <input ref={inputRef} aria-label={options.label ?? "文件树快速搜索"} value={query}
        className="min-w-0 w-36 bg-transparent outline-none" onChange={event => setQuery(event.target.value)}
        onBlur={() => { if (!filterEnabled) { setSearchOpen(false); setQuery(""); } }}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); close(); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const nodes = matches();
            if (!nodes.length) return;
            const index = nodes.findIndex(node => node.id === options.selectedId());
            const next = (index + (event.key === "ArrowDown" ? 1 : -1) + nodes.length) % nodes.length;
            options.select(nodes[next].id);
          }
          if (event.key === "Enter") {
            event.preventDefault();
            const node = matches().find(node => node.id === options.selectedId());
            close();
            if (node) options.activate(node.id);
          }
        }} />
      <span aria-live="polite" className="whitespace-nowrap text-gray-400">{query ? matches().length || "无匹配" : null}</span>
      <button type="button" aria-label="仅显示匹配项" aria-pressed={filterEnabled}
        title={filterEnabled ? "显示全部文件" : "仅显示匹配项"}
        className={`shrink-0 rounded p-1 ${filterEnabled ? "bg-ide-selection text-white" : "text-gray-400 hover:bg-white/10"}`}
        onMouseDown={event => event.preventDefault()}
        onClick={() => setFilterEnabled(enabled => !enabled)}>
        <Filter size={14} />
      </button>
    </div>
  ) : null;

  const highlight = (name: string) => {
    const positions = matchTreeName(name, query);
    if (!positions) return name;
    const matched = new Set(positions);
    return name.split("").map((letter, index) => matched.has(index)
      ? <mark key={index} className="rounded-sm bg-yellow-300/30 text-yellow-200">{letter}</mark>
      : <React.Fragment key={index}>{letter}</React.Fragment>);
  };
  return {
    search: (text: string) => { setSearchOpen(true); setQuery(text); },
    onKeyDownCapture, searchBox, highlight,
    filterTerm: filterEnabled ? query : "",
  };
}
