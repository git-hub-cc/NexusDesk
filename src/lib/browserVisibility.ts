const overlaySelector = '[role="dialog"], [role="alertdialog"], [role="menu"]:not([data-panel-menu]), [data-dnd-dragging="true"], [data-mirror-fullscreen="true"]';

export function browserVisibility(active: boolean, width: number, height: number) {
  const overlay = Array.from(document.querySelectorAll<HTMLElement>(overlaySelector)).find(element => {
    if (!element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      if (node.hidden || getComputedStyle(node).opacity === "0") return false;
    }
    return true;
  });
  // The HTML webview's document.hidden can remain true while a native child
  // is in use. The host window already hides its children when minimized.
  const reason = !active ? "inactive-tab" : width <= 0 || height <= 0 ? "empty-bounds"
    : overlay ? `overlay:${overlay.getAttribute("role") ?? "drag"}` : "visible";
  return { visible: reason === "visible", reason, documentHidden: document.hidden };
}
