import * as prettierStandalone from "prettier/standalone";
import babel from "prettier/plugins/babel";
import estree from "prettier/plugins/estree";
import typescript from "prettier/plugins/typescript";
import postcss from "prettier/plugins/postcss";
import html from "prettier/plugins/html";
import markdown from "prettier/plugins/markdown";
import yaml from "prettier/plugins/yaml";
import graphql from "prettier/plugins/graphql";

const plugins = [babel, estree, typescript, postcss, html, markdown, yaml, graphql];
const parsers = { js: "babel", jsx: "babel", mjs: "babel", cjs: "babel", ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", json: "json", jsonc: "jsonc", json5: "json5", css: "css", scss: "scss", less: "less", html: "html", htm: "html", vue: "vue", angular: "angular", md: "markdown", markdown: "markdown", mdown: "markdown", mkd: "markdown", yaml: "yaml", yml: "yaml", graphql: "graphql", gql: "graphql" };

async function formatHttp(source, selection) {
  const boundaries = [0, ...Array.from(source.matchAll(/^(?:###.*|(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\s+https?:\/\/\S+[^\r\n]*)$/gim), match => match.index), source.length];
  let result = "";
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i], end = boundaries[i + 1], block = source.slice(start, end);
    const request = /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\s+\S+.*$/im.exec(block);
    if (!request) { result += block; continue; }
    const afterRequest = request.index + request[0].length, separator = /\r?\n[\t ]*\r?\n/.exec(block.slice(afterRequest));
    if (!separator) { result += block; continue; }
    const bodyStart = afterRequest + separator.index + separator[0].length, match = /^(\s*)([\s\S]*?)(\s*)$/.exec(block.slice(bodyStart));
    if (!match[2] || (!selection.empty && (selection.to <= start + bodyStart || selection.from >= end))) { result += block; continue; }
    try {
      const formatted = await prettierStandalone.format(match[2], { parser: "json-stringify", plugins, tabWidth: 2, endOfLine: source.includes("\r\n") ? "crlf" : "lf" });
      result += block.slice(0, bodyStart) + match[1] + formatted.replace(/\r?\n$/, "") + match[3];
    } catch { result += block; }
  }
  return result;
}

self.onmessage = async ({ data }) => {
  const { id, source, extension, selection } = data;
  const normalizedSelection = { ...selection, empty: selection.from === selection.to };
  console.info("[format-chain-worker] request", { id, extension, sourceLength: source.length, selection });
  try {
    const formatted = extension === "http" || extension === "rest"
      ? await formatHttp(source, normalizedSelection)
      : await prettierStandalone.format(source, { parser: parsers[extension], plugins, tabWidth: 2, endOfLine: "lf", proseWrap: "preserve", ...(!normalizedSelection.empty ? { rangeStart: normalizedSelection.from, rangeEnd: normalizedSelection.to } : {}) });
    console.info("[format-chain-worker] success", { id, extension, formattedLength: formatted.length });
    self.postMessage({ id, type: "formatted", formatted });
  } catch (error) {
    console.error("[format-chain-worker] failure", { id, extension, error: String(error) });
    self.postMessage({ id, type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
