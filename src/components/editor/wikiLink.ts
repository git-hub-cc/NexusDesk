export function wikiLinkRange(text: string, from: number, to = from) {
  for (const match of text.matchAll(/\[\[([^\[\]\r\n]+)\]\]/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (from >= start && to <= end) {
      const alias = match[1].indexOf("|");
      return { from: start, to: end, existing: true, alias: alias < 0 ? "" : match[1].slice(alias) };
    }
  }
  if (from === to && from >= 2 && text.slice(from - 2, from) === "[[") {
    return { from: from - 2, to: from, existing: false, alias: "" };
  }
  return null;
}

export function wikiCompletionRange(text: string, pos: number) {
  const match = /\[\[([^\[\]#|\r\n]*)$/.exec(text.slice(0, pos));
  if (!match) return null;
  const tail = /^[^\[\]#|\r\n]*/.exec(text.slice(pos))![0];
  const end = pos + tail.length;
  return { from: pos - match[1].length, to: end + (text.slice(end, end + 2) === "]]" ? 2 : 0) };
}
