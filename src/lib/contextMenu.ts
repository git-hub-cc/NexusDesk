import type { KeyboardEvent } from "react";

// Use the same Radix trigger for the menu key and Shift+F10 as for right-clicks.
export function openContextMenuFromKeyboard(event: KeyboardEvent<HTMLElement>, target = event.currentTarget) {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + 8,
    clientY: rect.top + rect.height / 2,
    button: 2,
  }));
}
