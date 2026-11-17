/** Only the displayed text is shortened; offsets retain the original response. */
export function compactResponseBase64(source: string) {
  const omissions: { start: number; end: number; originalStart: number; originalEnd: number }[] = [];
  let cursor = 0;
  let text = "";
  for (const match of source.matchAll(/[A-Za-z0-9+/_-]{512,}={0,2}/g)) {
    const start = match.index + 64;
    const end = match.index + match[0].length - 64;
    text += source.slice(cursor, start);
    const marker = `…[Base64 已省略 ${end - start} 字符]…`;
    omissions.push({ start: text.length, end: text.length + marker.length, originalStart: start, originalEnd: end });
    text += marker;
    cursor = end;
  }
  text += source.slice(cursor);
  const originalOffset = (offset: number, end: boolean) => {
    let delta = 0;
    for (const omission of omissions) {
      if (offset <= omission.start) break;
      if (offset < omission.end) return end ? omission.originalEnd : omission.originalStart;
      delta = omission.originalEnd - omission.end;
    }
    return offset + delta;
  };
  return {
    text,
    copySelection: (start: number, end: number) => source.slice(originalOffset(start, false), originalOffset(end, true)),
  };
}
