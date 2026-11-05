import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { MatchDecorator, Decoration, ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

export const editorHighlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: "#cf8e6d" },
  { tag: [tags.string, tags.regexp], color: "#a5c98b" },
  { tag: [tags.number, tags.bool, tags.null], color: "#8fb8ee" },
  { tag: tags.comment, color: "#92969e", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#e2b974" },
  { tag: [tags.typeName, tags.className], color: "#b7a5df" },
  { tag: [tags.propertyName, tags.attributeName], color: "#c6a1cf" },
  { tag: tags.tagName, color: "#e8bf6a" },
  { tag: tags.heading, color: "#82a8ed", fontWeight: "bold" },
  { tag: tags.strong, fontWeight: "bold", color: "#dfe1e5" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "#7da7ff" },
  { tag: tags.monospace, color: "#a5c98b" },
  { tag: tags.meta, color: "#bbb7a3" },
]));

const httpMethodDeco = Decoration.mark({ class: "cm-http-method", attributes: { style: "color: #3574f0; font-weight: bold;" } });
const httpSeparatorDeco = Decoration.mark({ class: "cm-http-separator", attributes: { style: "color: #e8bf6a; font-weight: bold;" } });
const httpHeaderDeco = Decoration.mark({ class: "cm-http-header", attributes: { style: "color: #c6a1cf;" } });

const httpDecorator = new MatchDecorator({
  regexp: /^(?:(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\b|(###.*)|([\w-]+)(?=:))/gm,
  decoration: (match) => {
    if (match[1]) return httpMethodDeco;
    if (match[2]) return httpSeparatorDeco;
    if (match[3]) return httpHeaderDeco;
    return Decoration.mark({});
  }
});

const httpHighlightPlugin = ViewPlugin.fromClass(class {
  decorations;
  constructor(view: EditorView) { this.decorations = httpDecorator.createDeco(view); }
  update(update: ViewUpdate) { this.decorations = httpDecorator.updateDeco(update, this.decorations); }
}, { decorations: v => v.decorations });

const httpHeaders = ["Accept", "Authorization", "Cache-Control", "Content-Type", "Cookie", "Host", "Origin", "Referer", "User-Agent"].map(h => ({ label: h, type: "property" }));
const httpMimes = ["application/json", "application/xml", "application/x-www-form-urlencoded", "text/plain", "text/html"].map(m => ({ label: m, type: "keyword" }));

function httpCompletion(context: CompletionContext) {
  const word = context.matchBefore(/[\w-]+/);
  if (!word) return null;
  if (word.from === 0 || context.state.sliceDoc(word.from - 1, word.from) === "\n") {
    const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].map(m => ({ label: m, type: "keyword" }));
    return { from: word.from, options: [...methods, ...httpHeaders] };
  }
  const line = context.state.doc.lineAt(context.pos).text;
  if (line.toLowerCase().startsWith("content-type:") || line.toLowerCase().startsWith("accept:")) {
    return { from: word.from, options: httpMimes };
  }
  return null;
}

// Load parsers on demand, including fenced code within Markdown.
export async function languageForPath(path: string): Promise<Extension> {
  if (/\.(md|markdown|mdown|mkd)$/i.test(path)) {
    return markdown({ codeLanguages: languages });
  }
  if (/\.(http|rest)$/i.test(path)) {
    return [httpHighlightPlugin, autocompletion({ override: [httpCompletion] })];
  }
  const language = LanguageDescription.matchFilename(languages, path);
  return language ? language.load() : [];
}
