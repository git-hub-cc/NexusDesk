import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { FileText, Search, X } from "lucide-react";
import { fsApi, searchApi, type SearchResult, type SearchOptions } from "@/lib/api";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { HighlightedText } from "./HighlightedText";

export function SearchEverywhere({ onClose, recent = false }: { onClose: () => void; recent?: boolean }) {
    const root = useWorkspaceStore(state => state.rootPath);
    const mode = useWorkspaceStore(state => state.sidebarMode);
    const logicalTree = useWorkspaceStore(state => state.logicalTreeData);
    const partitionSelection = useWorkspaceStore(state => state.partitionSearchPaths);
    const [partitionPaths, setPartitionPaths] = useState<string[]>([]);
    useEffect(() => {
        let active = true;
        setPartitionPaths([]);
        if (mode === "logical") setPartitionPaths(partitionSelection ?? logicalTree.flatMap(category => (category.children ?? []).filter((entry: any) => !entry.missing).map((entry: any) => entry.id)));
        if (mode === "graph") void fsApi.getGraphCategories().then(categories => {
            if (active) setPartitionPaths(partitionSelection ?? categories.flatMap(category => category.files.filter(path => !category.missingFiles.includes(path))));
        }).catch(cause => { if (active) setError(String(cause)); });
        return () => { active = false; };
    }, [mode, logicalTree, partitionSelection, root]);
    const selectedScope = useWorkspaceStore(state => state.searchScopePath);
    const scope = mode === "physical" && !recent && selectedScope && root && (selectedScope === root || selectedScope.replace(/\\/g, "/").startsWith(root.replace(/\\/g, "/").replace(/\/$/, "") + "/")) ? selectedScope : null;
    const searchRoot = scope ?? root;
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<SearchResult[]>([]);
    const [selected, setSelected] = useState(0);
    const [loading, setLoading] = useState(false);
    const [opening, setOpening] = useState(false);
    const [error, setError] = useState("");
    const [options, setOptions] = useState<SearchOptions>({ extensions: "", caseSensitive: false, regex: false, wholeWord: false, includeIgnored: false });
    const cancelCurrent = useRef<(() => void) | null>(null);
    const [stopped, setStopped] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const alive = useRef(true);
    const previousFocus = useRef<HTMLElement | null>(null);

    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
    }, []);

    useEffect(() => {
        let cancelled = false;
        let started = false;
        const requestId = crypto.randomUUID();
        setStopped(false);
        setResults([]);
        setSelected(0);
        setError("");
        setLoading(!!searchRoot && (recent || !!query.trim()));
        if (!searchRoot || (!recent && (!query.trim() || (mode !== "physical" && !partitionPaths.length)))) { setLoading(false); return; }
        const search = () => {
            started = true;
            (recent ? fsApi.recentFiles().then(paths => paths.filter(path => path.toLowerCase().includes(query.toLowerCase())).map(path => ({ path, title: path.split(/[\\/]/).pop()!, relativePath: path, snippet: "", score: 0 }))) : searchApi.search(searchRoot, query, requestId, options, mode === "physical" ? undefined : partitionPaths)).then(data => {
                if (!cancelled) setResults(data);
            }).catch(cause => {
                if (!cancelled) setError(String(cause));
            }).finally(() => { if (!cancelled) setLoading(false); });
        };
        const timer = recent ? undefined : window.setTimeout(search, 180);
        if (recent) search();
        const cancel = () => {
            cancelled = true;
            if (timer !== undefined) window.clearTimeout(timer);
            if (!recent && started) void searchApi.cancel(requestId).catch(() => {});
        };
        cancelCurrent.current = () => { cancel(); setLoading(false); setStopped(true); };
        return () => { cancel(); cancelCurrent.current = null; };
    }, [query, root, searchRoot, recent, options, mode, partitionPaths]);

    useEffect(() => {
        list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    }, [selected]);

    const open = async (result: SearchResult) => {
        if (opening) return;
        setOpening(true);
        const project = root;
        try {
            const state = useWorkspaceStore.getState();
            const existing = [...state.leftTabs, ...state.rightTabs].find(tab => tab.path.replace(/\\/g, "/") === result.path.replace(/\\/g, "/"));
            const content = existing?.content ?? await fsApi.readFile(result.path);
            if (!alive.current || useWorkspaceStore.getState().rootPath !== project) return;
            useWorkspaceStore.getState().openTab(existing ?? {
                id: result.path, path: result.path, title: result.title, content, isDirty: false,
            });
            onClose();
        } catch (cause) { if (alive.current) setError(String(cause)); }
        finally { if (alive.current) setOpening(false); }
    };

    return (
        <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
            <Dialog.Portal>
                <Dialog.Overlay className="search-overlay" />
                <Dialog.Content className="search-dialog" aria-describedby={undefined}
                                onOpenAutoFocus={event => {
                                    event.preventDefault();
                                    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                                    input.current?.focus();
                                }}
                                onCloseAutoFocus={event => {
                                    event.preventDefault();
                                    if (previousFocus.current?.isConnected) previousFocus.current.focus();
                                }}
                                onKeyDown={event => {
                                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                                        event.preventDefault();
                                        setSelected(index => results.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length : 0);
                                    }
                                    if (event.key === "Enter" && document.activeElement === input.current && results[selected]) {
                                        event.preventDefault(); void open(results[selected]);
                                    }
                                }}>
                    <header><Dialog.Title asChild><span>{recent ? "最近打开的文件" : "Search Everywhere"}</span></Dialog.Title><span className="search-scope">{recent ? "最近文件" : `搜索范围：${mode !== "physical" ? `${mode === "logical" ? "\u903b\u8f91\u5206\u533a" : "\u56fe\u8c31\u5206\u533a"}${partitionSelection ? "\u6240\u9009\u76ee\u5f55" : "\u5168\u90e8\u5185\u5bb9"}` : scope ? scope.slice(root!.length).replace(/^[\\/]+/, "") || scope : "当前项目"} · ${options.includeIgnored ? "包含 .gitignore 文件与目录" : "忽略 .gitignore 文件与目录"}`}</span><Dialog.Close asChild><button aria-label="关闭搜索"><X size={16} /></button></Dialog.Close></header>
                    <div className="search-input"><Search size={20} /><input ref={input} value={query} maxLength={256}
                                                                             placeholder="搜索文件名或正文…" aria-label="搜索文件名或正文"
                                                                             role="combobox" aria-expanded={results.length > 0} aria-controls="search-results"
                                                                             aria-autocomplete="list" aria-activedescendant={results[selected] ? `search-result-${selected}` : undefined}
                                                                             onChange={event => setQuery(event.target.value)} />{recent && <kbd>Ctrl / Cmd + E</kbd>}</div>
                    {!recent && <div className="search-options">
                        <input aria-label="限制文件后缀" placeholder="文件后缀：.md, .ts, .tsx" value={options.extensions}
                               onChange={event => setOptions(value => ({ ...value, extensions: event.target.value }))} />
                        {([['caseSensitive', 'Aa', '区分大小写'], ['regex', '.*', '正则表达式'], ['wholeWord', 'Ab', '全词匹配']] as const).map(([key, label, title]) =>
                            <button key={key} type="button" title={title} aria-label={title} aria-pressed={options[key]}
                                    onClick={() => setOptions(value => ({ ...value, [key]: !value[key] }))}>{label}</button>)}
                        <button type="button" title="包含 .gitignore 忽略的文件" aria-label="包含 .gitignore 忽略的文件" aria-pressed={options.includeIgnored}
                                onClick={() => setOptions(value => ({ ...value, includeIgnored: !value.includeIgnored }))}>含忽略项</button>
                        {loading && <button type="button" onClick={() => cancelCurrent.current?.()}>取消搜索</button>}
                        {stopped && <span role="status">已取消</span>}
                    </div>}
                    <div className="search-results" ref={list} id="search-results" role="listbox" aria-label="搜索结果" aria-busy={loading}>
                        {results.map((result, index) => <div key={result.path} id={`search-result-${index}`} role="option"
                                                             aria-selected={selected === index} className="search-result" onMouseMove={() => setSelected(index)}
                                                             onClick={() => void open(result)}>
                            <FileText size={18} /><div className="search-result-text">
                            <div className="search-result-heading">
                                <strong><HighlightedText text={result.title} query={query} options={recent ? undefined : options} /></strong>
                                <span title={result.relativePath}><HighlightedText text={result.relativePath} query={query} options={recent ? undefined : options} /></span>
                            </div>
                            <p title={result.snippet}><HighlightedText text={result.snippet} query={query} options={recent ? undefined : options} /></p>
                        </div>
                        </div>)}
                        {!results.length && <div className="search-empty" role="status">{!root ? "请先打开项目目录" : stopped ? "搜索已取消" : loading ? "正在搜索…" : recent ? "暂无最近文件" : query.trim() ? "没有匹配的文件" : "输入关键词，搜索当前项目的文件名和正文"}</div>}
                    </div>
                    {error && <div className="search-error" role="alert">{error}</div>}
                    <footer><span>{opening ? "正在打开…" : loading ? "正在搜索…" : `最多显示 50 条 · 当前 ${results.length} 条`}</span><span>↑ ↓ 选择　Enter 打开　Esc 关闭</span></footer>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
