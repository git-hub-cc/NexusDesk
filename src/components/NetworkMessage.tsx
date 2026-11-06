import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// Decode serialization layers rather than replacing escapes, which would corrupt
// legitimate quotes, newlines and backslashes inside JSON string values.
function parseJsonValue(source: string): { value: JsonValue } | null {
  let text = source.trim().replace(/^\uFEFF/, "");
  let original: { value: JsonValue } | null = null;
  for (let layer = 0; layer < 8; layer++) {
    try {
      const value = JSON.parse(text) as JsonValue;
      original ??= { value };
      if (typeof value !== "string") return value !== null && typeof value === "object" ? { value } : original;
      if (value === text) break;
      text = value.trim().replace(/^\uFEFF/, "");
    } catch {
      // Some responses contain escaped JSON without the outer string quotes.
      try {
        const decoded: unknown = JSON.parse(`"${text}"`);
        if (typeof decoded !== "string" || decoded === text || !['{', '[', '"'].includes(decoded.trim()[0])) break;
        text = decoded.trim();
      } catch { break; }
    }
  }
  return original;
}

function parseJsonMessage(message: string) {
  let separator = /\r?\n\r?\n/.exec(message);
  if (!separator) {
    // Also accept a serialized complete message with escaped line separators.
    try {
      const decoded: unknown = JSON.parse(message.startsWith('"') ? message : `"${message}"`);
      if (typeof decoded === "string") {
        const decodedSeparator = /\r?\n\r?\n/.exec(decoded);
        if (decodedSeparator) { message = decoded; separator = decodedSeparator; }
      }
    } catch { /* not a serialized message */ }
  }
  if (!separator) return null;
  const bodyStart = separator.index + separator[0].length;
  const parsed = parseJsonValue(message.slice(bodyStart));
  return parsed ? { headers: message.slice(0, bodyStart), value: parsed.value } : null;
}

type Expansion = { mode: "initial" | "all" | "none"; overrides: Map<string, boolean> };

function JsonNode({ value, path, depth, name, comma, expansion, toggle }: {
  value: JsonValue; path: string; depth: number; name?: string; comma: boolean;
  expansion: Expansion; toggle: (path: string, open: boolean) => void;
}) {
  if (typeof value === "string") {
    const parsed = parseJsonValue(value);
    // Only embedded objects and arrays become nodes; ordinary strings stay strings.
    if (parsed?.value !== null && typeof parsed?.value === "object") value = parsed.value;
  }
  const prefix = name === undefined ? null : <><span className="text-blue-300">{JSON.stringify(name)}</span>: </>;
  const suffix = comma ? "," : "";
  const style = { paddingLeft: depth * 16 };
  if (value === null || typeof value !== "object") return <div style={style} className="pl-4 whitespace-pre-wrap break-all">
    <span className="inline-block w-4" />{prefix}<span className={typeof value === "string" ? "text-green-300" : "text-amber-300"}>{JSON.stringify(value)}</span>{suffix}
  </div>;

  const array = Array.isArray(value);
  const entries = Object.entries(value);
  const open = expansion.overrides.get(path) ?? (expansion.mode === "all" || (expansion.mode === "initial" && depth < 2));
  const start = array ? "[" : "{";
  const end = array ? "]" : "}";
  if (!entries.length) return <div style={style}><span className="inline-block w-4" />{prefix}{start}{end}{suffix}</div>;
  return <>
    <div style={style}>
      <button type="button" aria-expanded={open} aria-label={`${open ? "折叠" : "展开"} ${name ?? (depth === 0 ? "根节点" : "数组项")}（${entries.length} 项）`}
        onClick={() => toggle(path, !open)} className="text-left rounded hover:bg-ide-tab-hover focus-visible:outline focus-visible:outline-ide-accent">
        {open ? <ChevronDown size={14} className="inline-block w-4" /> : <ChevronRight size={14} className="inline-block w-4" />}
        {prefix}{start}{!open && <><span className="text-gray-500"> … {entries.length} 项 </span>{end}{suffix}</>}
      </button>
    </div>
    {open && <>
      {entries.map(([key, child], index) => <JsonNode key={key} value={child} path={`${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`} depth={depth + 1}
        name={array ? undefined : key} comma={index < entries.length - 1} expansion={expansion} toggle={toggle} />)}
      <div style={style}><span className="inline-block w-4" />{end}{suffix}</div>
    </>}
  </>;
}

export function NetworkMessage({ message, label, formatJson = false }: { message: string; label: string; formatJson?: boolean }) {
  const json = useMemo(() => formatJson ? parseJsonMessage(message) : null, [message, formatJson]);
  const [view, setView] = useState<"json" | "raw">("json");
  const [expansion, setExpansion] = useState<Expansion>({ mode: "initial", overrides: new Map() });
  const toggle = (path: string, open: boolean) => setExpansion(current => ({ ...current, overrides: new Map(current.overrides).set(path, open) }));
  return <>
    {json && <div className="flex flex-wrap items-center gap-3 px-3 py-1 border-b border-ide-panel-border text-xs shrink-0">
      <button type="button" aria-pressed={view === "json"} onClick={() => setView("json")} className={view === "json" ? "text-ide-accent" : "text-gray-400"}>JSON 格式化</button>
      <button type="button" aria-pressed={view === "raw"} onClick={() => setView("raw")} className={view === "raw" ? "text-ide-accent" : "text-gray-400"}>原始报文</button>
      {view === "json" && <>
        <button type="button" onClick={() => setExpansion({ mode: "all", overrides: new Map() })} className="text-gray-400 hover:text-white">展开全部</button>
        <button type="button" onClick={() => setExpansion({ mode: "none", overrides: new Map() })} className="text-gray-400 hover:text-white">折叠全部</button>
      </>}
    </div>}
    {json && view === "json" ? <div tabIndex={0} aria-label={`${label} JSON 格式化`} className="ide-content-surface flex-1 min-h-0 overflow-auto p-3 text-xs font-mono text-gray-200 select-text bg-ide-bg">
      <pre className="whitespace-pre-wrap break-all">{json.headers}</pre>
      <JsonNode value={json.value} path="" depth={0} comma={false} expansion={expansion} toggle={toggle} />
    </div> : <pre tabIndex={0} aria-label={label} className="ide-content-surface flex-1 min-h-0 overflow-auto p-3 text-xs font-mono text-gray-200 whitespace-pre-wrap break-all select-text bg-ide-bg">{message}</pre>}
  </>;
}
