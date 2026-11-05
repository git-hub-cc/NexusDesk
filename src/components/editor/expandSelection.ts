import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

interface Span { from: number; to: number }

/** Pick the smallest strictly enclosing textual unit, independently of language loading. */
export function expandedRange(text: string, from: number, to = from): Span {
  if (from > to) [from, to] = [to, from];
  const candidates: Span[] = [];
  const matchedPairs: Span[] = [];
  const addPair = (start: number, end: number) => {
    matchedPairs.push({ from: start, to: end });
    add(start + 1, end - 1);
    add(start, end);
  };
  const add = (start: number, end: number) => {
    if (start <= from && end >= to && end > start && (start < from || end > to)) {
      candidates.push({ from: start, to: end });
    }
  };
  const matches = (pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) add(match.index!, match.index! + match[0].length);
  };
  // Unicode words, snake_case and camelCase each contribute their own level.
  matches(/[\p{L}\p{N}]+/gu);
  matches(/[\p{Lu}]?[\p{Ll}\p{N}]+|[\p{Lu}]+(?![\p{Ll}])/gu);
  matches(/[\p{L}\p{N}_$]+/gu);

  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", "（": "）", "【": "】", "《": "》", "〈": "〉", "「": "」", "『": "』", "“": "”", "‘": "’" };
  const stack: { char: string; pos: number }[] = [];
  let quote: { char: string; pos: number } | undefined;
  let slashes = 0;
  for (let pos = 0; pos < text.length; pos++) {
    const char = text[pos];
    const escaped = slashes % 2 === 1;
    slashes = char === "\\" ? slashes + 1 : 0;
    if (quote) {
      if (char === quote.char && !escaped) {
        addPair(quote.pos, pos + 1);
        quote = undefined;
      } else if (char === "\n" && quote.char !== "`") quote = undefined;
      continue;
    }
    if (escaped) continue;
    if ('"\'`'.includes(char)) {
      // Apostrophes in natural-language words aren't string delimiters.
      if (char === "'" && /[\p{L}\p{N}]/u.test(text[pos - 1] ?? "") && /[\p{L}\p{N}]/u.test(text[pos + 1] ?? "")) continue;
      quote = { char, pos };
    } else if (pairs[char]) stack.push({ char, pos });
    else {
      let index = stack.length - 1;
      while (index >= 0 && pairs[stack[index].char] !== char) index--;
      if (index >= 0) {
        const open = stack[index];
        stack.length = index;
        addPair(open.pos, pos + 1);
      }
    }
  }

  // Every punctuation level splits the current enclosing region. This gives
  // foo -> foo.txt -> folder/foo.txt -> the complete path, for example.
  const boundaries = [/[\r\n"'`()\[\]{}（）【】《》〈〉「」『』“”‘’]/u, /\s/u,
    /[,;，；]/u, /[=:+!?&|，。！？]/u, /[/\\]/u, /[.\-]/u, /[_$]/u];
  let start = 0, end = text.length;
  for (const boundary of boundaries) {
    for (let i = start; i < from; i++) if (boundary.test(text[i])) start = i + 1;
    for (let i = to; i < end; i++) if (boundary.test(text[i])) { end = i; break; }
    add(start, end);
  }
  // Grow paths one directory at a time, retaining the selected component.
  for (const path of text.matchAll(/[^\s"'`()\[\]{}<>，；,;]+[/\\][^\s"'`()\[\]{}<>，；,;]*/gu)) {
    const base = path.index!;
    const limit = base + path[0].length;
    if (base > from || limit < to) continue;
    add(base, limit);
    for (let i = base; i < limit; i++) {
      if (text[i] !== "/" && text[i] !== "\\") continue;
      if (i < from) add(i + 1, limit);
      if (i >= to) add(base, i);
    }
  }
  let lineStart = text.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  if (from === 0) lineStart = 0;
  let lineEnd = text.indexOf("\n", to);
  if (lineEnd < 0) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  add(lineStart + (line.match(/^\s*/)?.[0].length ?? 0), lineEnd - (line.match(/\s*$/)?.[0].length ?? 0));
  add(lineStart, lineEnd);
  add(lineStart, Math.min(text.length, lineEnd + 1));
  const before = text.slice(0, lineStart);
  const breaks = [...before.matchAll(/\n[\t \r]*\n/g)];
  const last = breaks[breaks.length - 1];
  const after = /\n[\t \r]*\n/g.exec(text.slice(lineEnd));
  add(last ? last.index! + last[0].length : 0, after ? lineEnd + after.index : text.length);
  add(0, text.length);
  // Never grow across just one side of an enclosing pair. Both edges must
  // move together when leaving its contents, including backwards selections.
  const balanced = candidates.filter(candidate => matchedPairs.every(pair => {
    if (pair.from > from || pair.to < to) return true;
    return (candidate.from > pair.from && candidate.to < pair.to)
      || (candidate.from <= pair.from && candidate.to >= pair.to);
  }));
  balanced.sort((a, b) => (a.to - a.from) - (b.to - b.from) || b.from - a.from);
  return balanced[0] ?? { from, to };
}

export function expandSelection(view: EditorView): boolean {
  const text = view.state.doc.toString();
  const ranges = view.state.selection.ranges.map(range => {
    const next = expandedRange(text, range.from, range.to);
    return range.anchor > range.head ? EditorSelection.range(next.to, next.from) : EditorSelection.range(next.from, next.to);
  });
  view.dispatch({ selection: EditorSelection.create(ranges, view.state.selection.mainIndex), scrollIntoView: true, userEvent: "select.expand" });
  return true;
}
