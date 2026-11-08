import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";

const parsers: Record<string, string> = { js: "babel", jsx: "babel", mjs: "babel", cjs: "babel", ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", json: "json", jsonc: "jsonc", json5: "json5", css: "css", scss: "scss", less: "less", html: "html", htm: "html", vue: "vue", angular: "angular", md: "markdown", markdown: "markdown", mdown: "markdown", mkd: "markdown", yaml: "yaml", yml: "yaml", graphql: "graphql", gql: "graphql" };
type FormatResponse = { id: number; type: "formatted"; formatted: string } | { id: number; type: "error"; message: string };
type Pending = { resolve: (value: string) => void; reject: (error: Error) => void };
let formatterWorker: Worker | undefined;
let requestId = 0;
const pending = new Map<number, Pending>();

async function formatWithoutWorker(source: string, extension: string, selection: { from: number; to: number; empty: boolean }) {
  const [prettier, ...plugins] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/babel"), import("prettier/plugins/estree"),
    import("prettier/plugins/typescript"), import("prettier/plugins/postcss"),
    import("prettier/plugins/html"), import("prettier/plugins/markdown"),
    import("prettier/plugins/yaml"), import("prettier/plugins/graphql"),
  ]);
  const loadedPlugins = plugins.map(plugin => plugin.default);
  if (extension === "http" || extension === "rest") {
    const boundaries = [0, ...Array.from(source.matchAll(/^(?:###.*|(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\s+https?:\/\/\S+[^\r\n]*)$/gim), match => match.index!), source.length];
    let result = "";
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i], end = boundaries[i + 1], block = source.slice(start, end);
      const request = /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\s+\S+.*$/im.exec(block);
      if (!request) { result += block; continue; }
      const afterRequest = request.index + request[0].length, separator = /\r?\n[\t ]*\r?\n/.exec(block.slice(afterRequest));
      if (!separator) { result += block; continue; }
      const bodyStart = afterRequest + separator.index + separator[0].length, match = /^(\s*)([\s\S]*?)(\s*)$/.exec(block.slice(bodyStart))!;
      if (!match[2] || (!selection.empty && (selection.to <= start + bodyStart || selection.from >= end))) { result += block; continue; }
      try {
        const formatted = await prettier.format(match[2], { parser: "json-stringify", plugins: loadedPlugins, tabWidth: 2, endOfLine: source.includes("\r\n") ? "crlf" : "lf" });
        result += block.slice(0, bodyStart) + match[1] + formatted.replace(/\r?\n$/, "") + match[3];
      } catch { result += block; }
    }
    return result;
  }
  return prettier.format(source, { parser: parsers[extension], plugins: loadedPlugins, tabWidth: 2, endOfLine: "lf", proseWrap: "preserve", ...(!selection.empty ? { rangeStart: selection.from, rangeEnd: selection.to } : {}) });
}

function getFormatterWorker() {
  if (formatterWorker) return formatterWorker;
  console.info("[format-chain] worker create");
  formatterWorker = new Worker(new URL("../../workers/formatter.worker.js", import.meta.url), { type: "module" });
  formatterWorker.onmessage = ({ data }: MessageEvent<FormatResponse>) => {
    console.info("[format-chain] worker response", { id: data.id, type: data.type, formattedLength: data.type === "formatted" ? data.formatted.length : undefined, message: data.type === "error" ? data.message : undefined });
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.type === "formatted") request.resolve(data.formatted);
    else request.reject(new Error(data.message));
  };
  formatterWorker.onerror = event => {
    console.error("[format-chain] worker error", { message: event.message, pending: pending.size });
    const error = new Error(event.message || "格式化 worker 加载失败");
    pending.forEach(request => request.reject(error));
    pending.clear();
    formatterWorker?.terminate();
    formatterWorker = undefined;
  };
  return formatterWorker;
}

function formatInWorker(source: string, extension: string, selection: { from: number; to: number; empty: boolean }) {
  const id = ++requestId;
  console.info("[format-chain] worker request", { id, extension, sourceLength: source.length, selectionFrom: selection.from, selectionTo: selection.to, selectionEmpty: selection.empty });
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // SelectionRange 的 empty 是 getter，结构化克隆后不会保留，显式传递布尔值。
    getFormatterWorker().postMessage({ id, source, extension, selection: { from: selection.from, to: selection.to, empty: selection.from === selection.to } });
  });
}

export async function formatCode(view: EditorView, path: string, isCurrent: () => boolean) {
  const original = view.state;
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  console.info("[format-chain] start", { path, extension, docLength: original.doc.length, readOnly: original.readOnly, composing: view.composing, selectionFrom: original.selection.main.from, selectionTo: original.selection.main.to });
  if (original.readOnly || view.composing) {
    console.warn("[format-chain] skipped", { path, reason: original.readOnly ? "read-only" : "composing" });
    return;
  }
  if (!parsers[extension] && extension !== "http" && extension !== "rest") throw new Error("当前文件类型暂不支持格式化");
  const source = original.doc.toString();
  const selection = original.selection.main;
  const normalizedSelection = { from: selection.from, to: selection.to, empty: selection.from === selection.to };
  let formatted: string;
  if (typeof Worker === "undefined") {
    console.info("[format-chain] formatter path", { mode: "main-thread", extension });
    formatted = await formatWithoutWorker(source, extension, normalizedSelection);
  } else {
    try {
      formatted = await formatInWorker(source, extension, normalizedSelection);
    } catch (error) {
      console.warn("[format-chain] worker failed, fallback", { extension, error: String(error) });
      // worker 加载或解析失败时回退，避免快捷键执行后无可见结果。
      formatted = await formatWithoutWorker(source, extension, normalizedSelection).catch(() => { throw error; });
    }
  }
  const current = isCurrent();
  const unchanged = formatted === source;
  console.info("[format-chain] result", { path, sourceLength: source.length, formattedLength: formatted.length, changed: !unchanged, current, sameDocument: view.state.doc === original.doc, readOnly: view.state.readOnly, composing: view.composing });
  if (!current || view.state.doc !== original.doc || view.state.readOnly || view.composing || unchanged) return;
  let from = 0, oldEnd = source.length, newEnd = formatted.length;
  while (from < oldEnd && from < newEnd && source[from] === formatted[from]) from++;
  while (oldEnd > from && newEnd > from && source[oldEnd - 1] === formatted[newEnd - 1]) { oldEnd--; newEnd--; }
  view.dispatch({ changes: { from, to: oldEnd, insert: formatted.slice(from, newEnd) }, annotations: isolateHistory.of("full"), userEvent: "input.format" });
  console.info("[format-chain] dispatched", { path, replaceFrom: from, replaceTo: oldEnd, insertedLength: newEnd - from });
}
