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

export async function formatCode(view: EditorView, path: string, isCurrent: () => boolean) {
  const original = view.state;
  if (original.readOnly || view.composing) return;
  const parser = parsers[path.split(".").pop()?.toLowerCase() ?? ""];
  if (!parser) throw new Error("当前文件类型暂不支持格式化");
  const { prettier, plugins } = await loadFormatter();
  const source = original.doc.toString();
  const selection = original.selection.main;
  const formatted = await prettier.format(source, {
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
