export interface DiffCell {
  number: number;
  text: string;
  changed: boolean;
  noNewline?: boolean;
}
export interface DiffRow { left?: DiffCell; right?: DiffCell; heading?: string }

export interface DiffChange {
  start: number;
  end: number;
  leftLine: number;
  rightLine: number;
  leftCount: number;
  rightCount: number;
  kind: "added" | "removed" | "modified";
}

// A change is a contiguous replacement, insertion or deletion, not an individual line.
export function diffChanges(rows: DiffRow[]): DiffChange[] {
  const changes: DiffChange[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].left?.changed && !rows[i].right?.changed) continue;
    const start = i;
    let leftCount = 0, rightCount = 0;
    while (i < rows.length && (rows[i].left?.changed || rows[i].right?.changed)) {
      if (rows[i].left?.changed) leftCount++;
      if (rows[i].right?.changed) rightCount++;
      i++;
    }
    const end = i - 1;
    const anchor = (side: "left" | "right") => {
      for (let n = start; n < rows.length && !rows[n].heading; n++) if (rows[n][side]) return rows[n][side]!.number;
      for (let n = start - 1; n >= 0; n--) {
        if (rows[n][side]) return rows[n][side]!.number + 1;
        if (rows[n].heading) {
          const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rows[n].heading!);
          if (match) return Number(match[side === "left" ? 1 : 3]) + (match[side === "left" ? 2 : 4] === "0" ? 1 : 0);
          break;
        }
      }
      return 1;
    };
    changes.push({ start, end, leftLine: anchor("left"), rightLine: anchor("right"), leftCount, rightCount,
      kind: leftCount && rightCount ? "modified" : leftCount ? "removed" : "added" });
    i--;
  }
  return changes;
}

// Reverse a unified patch against the complete working text to recover omitted context.
export function originalFromPatch(patch: string, current: string): string {
  const lines = current === "" ? [] : current.replace(/\n$/, "").split("\n");
  const hunks: { start: number; count: number; original: string[] }[] = [];
  let hunk: (typeof hunks)[number] | undefined;
  let previous = "";
  let finalNewline = current.endsWith("\n");
  for (const line of patch.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      const count = Number(match[4] ?? 1);
      hunk = { start: Number(match[3]) - (count ? 1 : 0), count, original: [] };
      hunks.push(hunk);
      previous = "";
    } else if (hunk && /^[ -]/.test(line)) {
      hunk.original.push(line.slice(1)); previous = line[0];
      if (line[0] === "-" && hunk.start + hunk.count >= lines.length) finalNewline = true;
    } else if (hunk && line.startsWith("+")) {
      previous = "+";
    } else if (hunk && line.startsWith("\\") && previous !== "+") {
      finalNewline = false;
    }
  }
  for (const item of hunks.reverse()) lines.splice(item.start, item.count, ...item.original);
  return lines.join("\n") + (lines.length && finalNewline ? "\n" : "");
}

// Expand omitted context using the original texts, including identical versions.
export function fullTextDiffRows(patch: string, left: string, right: string): DiffRow[] {
  const lines = (text: string) => text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const originals = { left: lines(left), right: lines(right) };
  const next = { left: 1, right: 1 };
  const rows: DiffRow[] = [];
  const fill = (leftEnd: number, rightEnd: number) => {
    while (next.left < leftEnd || next.right < rightEnd) {
      const row: DiffRow = {};
      for (const side of ["left", "right"] as const) {
        if (next[side] < (side === "left" ? leftEnd : rightEnd)) {
          const number = next[side]++;
          row[side] = { number, text: originals[side][number - 1], changed: false };
        }
      }
      rows.push(row);
    }
  };
  for (const row of parseGitDiff(patch)) {
    if (row.heading) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row.heading);
      if (hunk) fill(Number(hunk[1]) + (hunk[2] === "0" ? 1 : 0), Number(hunk[3]) + (hunk[4] === "0" ? 1 : 0));
      continue;
    }
    rows.push(row);
    for (const side of ["left", "right"] as const) {
      if (row[side]) next[side] = row[side].number + 1;
    }
  }
  fill(originals.left.length + 1, originals.right.length + 1);
  return rows;
}

// Pair each contiguous deletion/insertion block, preserving real line numbers.
export function parseGitDiff(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0, newLine = 0, inHunk = false;
  let removed: DiffCell[] = [], added: DiffCell[] = [];
  let previous: DiffCell[] = [];
  function flush() {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({ left: removed[i], right: added[i] });
    }
    removed = []; added = [];
  }
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush(); inHunk = true; previous = [];
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]);
      rows.push({ heading: line });
    } else if (inHunk && line.startsWith("-")) {
      const cell = { number: oldLine++, text: line.slice(1), changed: true };
      removed.push(cell); previous = [cell];
    } else if (inHunk && line.startsWith("+")) {
      const cell = { number: newLine++, text: line.slice(1), changed: true };
      added.push(cell); previous = [cell];
    } else if (inHunk && line.startsWith(" ")) {
      flush();
      const left = { number: oldLine++, text: line.slice(1), changed: false };
      const right = { number: newLine++, text: line.slice(1), changed: false };
      rows.push({ left, right }); previous = [left, right];
    } else if (inHunk && line.startsWith("\\")) {
      previous.forEach(cell => { cell.noNewline = true; });
    } else if (line.startsWith("diff --git")) {
      flush(); inHunk = false;
    }
  }
  flush();
  return rows;
}
