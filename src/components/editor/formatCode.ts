import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";

const parsers: Record<string, string> = {
  js: "babel", jsx: "babel", mjs: "babel", cjs: "babel",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  json: "json", jsonc: "jsonc", json5: "json5",
  css: "css", scss: "scss", less: "less",
  html: "html", htm: "html", vue: "vue", angular: "angular",
  md: "markdown", markdown: "markdown", mdown: "markdown", mkd: "markdown",
  yaml: "yaml", yml: "yaml", graphql: "graphql", gql: "graphql",
};

async function loadFormatter() {
  const [prettier, ...plugins] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/babel"), import("prettier/plugins/estree"),
    import("prettier/plugins/typescript"), import("prettier/plugins/postcss"),
    import("prettier/plugins/html"), import("prettier/plugins/markdown"),
    import("prettier/plugins/yaml"), import("prettier/plugins/graphql"),
  ]);
  return { prettier, plugins: plugins.map(plugin => plugin.default) };
}

async function formatHttp(source: string, selection: { from: number; to: number; empty: boolean }, prettier: typeof import("prettier/standalone"), plugins: object[]) {
  const boundaries = [0, ...Array.from(source.matchAll(/^(?:###.*|(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\s+https?:\/\/\S+[^\r\n]*)$/gim), match => match.index!), source.length];
  let result = "";
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i], end = boundaries[i + 1];
    const block = source.slice(start, end);
    const request = /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\s+\S+.*$/im.exec(block);
    if (!request) { result += block; continue; }
    const afterRequest = request.index + request[0].length;
    const separator = /\r?\n[\t ]*\r?\n/.exec(block.slice(afterRequest));
    if (!separator) { result += block; continue; }
    const bodyStart = afterRequest + separator.index + separator[0].length;
    const body = block.slice(bodyStart);
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(body)!;
    if (!match[2] || (!selection.empty && (selection.to <= start + bodyStart || selection.from >= end))) { result += block; continue; }
    try {
      const formatted = await prettier.format(match[2], { parser: "json-stringify", plugins, tabWidth: 2, endOfLine: source.includes("\r\n") ? "crlf" : "lf" });
      result += block.slice(0, bodyStart) + match[1] + formatted.replace(/\r?\n$/, "") + match[3];
    } catch { result += block; }
  }
  return result;
}

export async function formatCode(view: EditorView, path: string, isCurrent: () => boolean) {
  const original = view.state;
  if (original.readOnly || view.composing) return;
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const parser = parsers[extension];
  const isHttp = extension === "http" || extension === "rest";
  if (!parser && !isHttp) throw new Error("当前文件类型暂不支持格式化");
  const { prettier, plugins } = await loadFormatter();
  const source = original.doc.toString();
  const selection = original.selection.main;
  const formatted = isHttp ? await formatHttp(source, selection, prettier, plugins) : await prettier.format(source, {
    parser, plugins, tabWidth: 2, endOfLine: "lf", proseWrap: "preserve",
    ...(!selection.empty ? { rangeStart: selection.from, rangeEnd: selection.to } : {}),
  });
  // Never overwrite typing or a document switch while the formatter loads.
  if (!isCurrent() || view.state.doc !== original.doc || view.state.readOnly || view.composing) return;
  if (formatted === source) return;
  let from = 0, oldEnd = source.length, newEnd = formatted.length;
  while (from < oldEnd && from < newEnd && source[from] === formatted[from]) from++;
  while (oldEnd > from && newEnd > from && source[oldEnd - 1] === formatted[newEnd - 1]) { oldEnd--; newEnd--; }
  view.dispatch({
    changes: { from, to: oldEnd, insert: formatted.slice(from, newEnd) },
    annotations: isolateHistory.of("full"), userEvent: "input.format",
  });
}
