import type { IBuffer, ILink } from '@xterm/xterm';

// A soft-wrapped buffer line is one logical line, including after reflow.
export function terminalBufferFileLinks(buffer: IBuffer, lineNumber: number, cols: number, recoverWindowsWrap = false) {
  // ConPTY can repaint a wrapped row using CR/LF or cursor positioning, losing
  // xterm's isWrapped flag. Recover only edge-to-edge Windows path fragments;
  // keep ordinary hard line breaks and indented output separate.
  const continues = (row: number): boolean => {
    const line = buffer.getLine(row);
    if (!line) return false;
    if (line.isWrapped) return true;
    if (!recoverWindowsWrap || row <= 0) return false;
    const next = line.translateToString(true);
    if (!/^[^\s"'<>|():]+/.test(next) || /^[A-Za-z]:/.test(next)) return false;
    const fragment = next.match(/^[^\s"'<>|():]+/)![0];
    if (!/[\\/.]/.test(fragment) && fragment.length < cols) return false;
    let prefix = '';
    for (let previous = row - 1; previous >= 0; previous--) {
      const before = buffer.getLine(previous);
      if (!before || !before.getCell(cols - 1)?.getChars()) break;
      prefix = before.translateToString(false, 0, cols) + prefix;
      if (terminalFileLinks(prefix).some(link => link.start + link.length === prefix.length)) return true;
      if (/\s/.test(before.getCell(0)?.getChars() ?? '')) break;
    }
    return false;
  };
  let first = lineNumber - 1;
  if (first < 0 || cols < 1 || !buffer.getLine(first)) return [];
  while (first > 0 && continues(first)) first--;
  let last = lineNumber - 1;
  while (last + 1 < buffer.length && continues(last + 1)) last++;
  let text = '';
  const starts: { x: number; y: number }[] = [];
  const ends: { x: number; y: number }[] = [];
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row)!;
    // Only continuation rows need their full width: empty cells on the final
    // row are buffer padding, not part of the output or a file name.
    let endCol = cols;
    if (row === last) {
      while (endCol > 0 && !line.getCell(endCol - 1)?.getChars()) endCol--;
      const finalCell = line.getCell(endCol - 1);
      if (finalCell) endCol = Math.min(cols, endCol - 1 + finalCell.getWidth());
    }
    for (let col = 0; col < endCol; col++) {
      const cell = line.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      // xterm can leave a padding cell before a wrapped wide character.
      if (col === cols - 1 && !cell.getChars() && row < last
          && buffer.getLine(row + 1)?.getCell(0)?.getWidth() === 2) continue;
      text += chars;
      for (let i = 0; i < chars.length; i++) {
        starts.push({ x: col + 1, y: row + 1 });
        ends.push({ x: col + cell.getWidth(), y: row + 1 });
      }
    }
  }
  return terminalFileLinks(text).flatMap(link => {
    const range: ILink['range'] = { start: starts[link.start], end: ends[link.start + link.length - 1] };
    if (lineNumber < range.start.y || lineNumber > range.end.y) return [];
    return [{ ...link, text: text.slice(link.start, link.start + link.length), range }];
  });
}

export interface TerminalFileLink {
  start: number;
  length: number;
  path: string;
  line: number;
  column: number;
}

export function terminalFileLinks(text: string): TerminalFileLink[] {
  const links: TerminalFileLink[] = [];
  const patterns = [
    /File "([A-Za-z]:[/\\][^"]+)", line (\d+)/g,
    /(?<![\w/\\:])([A-Za-z]:[/\\][^"<>|\r\n]*?\.[\w]+)(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\)|:line (\d+))/g,
  ];
  for (const [index, pattern] of patterns.entries()) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index!;
      const end = start + match[0].length;
      if (links.some(link => start < link.start + link.length && end > link.start)) continue;
      links.push({ start, length: match[0].length, path: match[1],
        line: Number(index === 0 ? match[2] : match[2] || match[4] || match[6]),
        column: Number(index === 0 ? 1 : match[3] || match[5] || 1) });
    }
  }
  const paths = /"([^"\r\n]+)"|'([^'\r\n]+)'|(?:file:\/\/\/|[A-Za-z]:[/\\]|\\\\|\.{1,2}[/\\]|\/)[^\s"'<>|()]+|[\w@.-]+(?:[/\\][\w@.-]+)+|[\w@-]+\.[A-Za-z][\w]*/g;
  for (const match of text.matchAll(paths)) {
    const path = match[1] ?? match[2] ?? match[0].replace(/[.,;:]+$/, '');
    if (!/^[A-Za-z]:[/\\]/.test(path)) continue;
    const start = match.index! + (match[1] !== undefined || match[2] !== undefined ? 1 : 0);
    if (links.some(link => start < link.start + link.length && start + path.length > link.start)) continue;
    // Invalid source locations must not become plain file links.
    if (/[:(]\d/.test(path)) continue;
    links.push({ start, length: path.length, path, line: 1, column: 1 });
  }
  return links.filter(link => link.line > 0 && link.column > 0).sort((a, b) => a.start - b.start);
}

export function resolveTerminalPath(path: string, cwd: string | null): string {
  if (path.startsWith("file://")) {
    path = decodeURIComponent(new URL(path).pathname).replace(/^\/([A-Za-z]:)/, "$1");
  }
  const absolute = /^(?:[A-Za-z]:[/\\]|[/\\])/.test(path);
  if (!absolute && !cwd) throw new Error("无法解析相对路径：终端没有工作目录");
  const full = (absolute ? path : `${cwd}/${path}`).replace(/\\/g, "/");
  const parts: string[] = [];
  for (const part of full.split("/")) {
    if (part === ".") continue;
    if (part === ".." && parts.length && parts[parts.length - 1] !== "") parts.pop();
    else if (part !== "..") parts.push(part);
  }
  return parts.join("/");
}
