import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

export const highlightLinkTarget = StateEffect.define<number | null>();
export const linkTargetDecoration = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(highlightLinkTarget)) {
        value = effect.value === null ? Decoration.none : Decoration.set([
          Decoration.line({ attributes: { class: "cm-link-target" } }).range(effect.value),
        ]);
      }
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});

// Read headings from the document, never from rendered HTML (which is virtualized).
export function headingAt(view: EditorView, position: number) {
  const target = view.state.doc.lineAt(position);
  let fence = "";
  for (let number = 1; number <= target.number; number++) {
    const line = view.state.doc.line(number);
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line.text)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(line.text)) fence = "";
      if (number === target.number) return null;
      continue;
    }
    if (number !== target.number || fence) continue;
    const atx = /^ {0,3}#{1,6}\s+(.+?)\s*$/.exec(line.text);
    const next = number < view.state.doc.lines ? view.state.doc.line(number + 1).text : "";
    const title = atx ? atx[1].replace(/\s+#+\s*$/, "")
      : line.text.trim() && /^ {0,3}(=+|-+)\s*$/.test(next) ? line.text.trim() : null;
    return title ? { from: line.from, title } : null;
  }
  return null;
}

export function relativeNotePath(source: string, target: string) {
  const from = source.replace(/\\/g, "/").split("/");
  const to = target.replace(/\\/g, "/").split("/");
  from.pop();
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
  return [...from.map(() => ".."), ...to].join("/");
}

export const linkEditors = new Map<EditorView, () => { id: string; path: string } | undefined>();

export function fileHeadings(content: string) {
  const lines = content.split(/\r?\n/);
  const headings: { title: string; level: number }[] = [];
  let fence = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(line)) fence = "";
      continue;
    }
    if (fence) continue;
    const atx = /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    const underline = /^ {0,3}(=+|-+)\s*$/.exec(lines[i + 1] ?? "");
    if (atx) headings.push({ title: atx[2].replace(/\s+#+\s*$/, ""), level: atx[1].length });
    else if (line.trim() && underline) {
      headings.push({ title: line.trim(), level: underline[1][0] === "=" ? 1 : 2 });
      i++;
    }
  }
  return headings;
}

// A body-level overlay spans split panes without intercepting hit testing.
export function createLinkWire(x: number, y: number) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("aria-hidden", "true");
  Object.assign(svg.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", pointerEvents: "none", zIndex: "2147483647", overflow: "visible" });
  const path = document.createElementNS(ns, "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke-width", "3");
  path.style.filter = "drop-shadow(0 0 4px #60a5fa)";
  const dot = document.createElementNS(ns, "circle");
  dot.setAttribute("r", "5");
  svg.append(path, dot);
  document.body.append(svg);
  const update = (toX: number, toY: number, snapped = false) => {
    const bend = Math.max(60, Math.abs(toX - x) * 0.45);
    const direction = toX >= x ? 1 : -1;
    const color = snapped ? "#34d399" : "#60a5fa";
    path.setAttribute("d", `M ${x} ${y} C ${x + bend * direction} ${y}, ${toX - bend * direction} ${toY}, ${toX} ${toY}`);
    path.setAttribute("stroke", color);
    dot.setAttribute("cx", String(toX));
    dot.setAttribute("cy", String(toY));
    dot.setAttribute("fill", color);
  };
  update(x, y);
  return { update, remove: () => svg.remove() };
}
