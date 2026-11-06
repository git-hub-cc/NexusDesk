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

const httpMethodDeco = Decoration.mark({ class: "cm-http-method", attributes: { style: "color: #82a8ed; font-weight: bold;" } });
const httpUrlDeco = Decoration.mark({ class: "cm-http-url", attributes: { style: "color: #7fc8a9; text-decoration: underline;" } });
const httpDescriptionDeco = Decoration.mark({ class: "cm-http-description", attributes: { style: "color: #e8bf6a; font-weight: bold;" } });
const httpHeaderNameDeco = Decoration.mark({ class: "cm-http-header-name", attributes: { style: "color: #c6a1cf;" } });

const httpDecorator = new MatchDecorator({
  regexp: /^(?:(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\s+(\S+)|(###.*)|([\w-]+)(?=:))/gim,
  decorate: (add, from, _to, match, _view) => {
    if (match[1]) {
      const methodStart = from + match.index;
      const urlStart = match[0].indexOf(match[2], match[1].length);
      add(methodStart, methodStart + match[1].length, httpMethodDeco);
      add(methodStart + urlStart, methodStart + urlStart + match[2].length, httpUrlDeco);
      return;
    }
    if (match[3]) add(from + match.index, from + match.index + match[3].length, httpDescriptionDeco);
    else if (match[4]) add(from + match.index, from + match.index + match[4].length, httpHeaderNameDeco);
  }
});

export const httpHighlightPlugin = ViewPlugin.fromClass(class {
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
    return autocompletion({ override: [httpCompletion] });
  }
  const language = LanguageDescription.matchFilename(languages, path);
  return language ? language.load() : [];
}
