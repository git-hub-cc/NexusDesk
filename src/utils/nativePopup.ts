import menuStyles from "../native-menu.css?raw";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export async function openNativePopup(html: string, x: number, y: number, width: number, onAction: (id: string, value?: string) => void, onClose?: () => void) {
  const theme = getComputedStyle(document.documentElement);
  const variables = ["--ide-bg", "--ide-fg", "--ide-panel-border", "--ide-accent", "--ide-selection", "--ide-selection-inactive"].map(name => `${name}:${theme.getPropertyValue(name)}`).join(";");
  const styles = `${menuStyles} :host,.native-menu{${variables};color-scheme:${theme.colorScheme}}`;
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;visibility:hidden;pointer-events:none`;
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>${styles}</style><div class="native-menu">${html}</div>`;
  document.body.append(host);
  const height = Math.ceil(shadow.querySelector(".native-menu")!.getBoundingClientRect().height);
  host.remove();
  html = `<style>${styles}</style><div class="native-menu" role="menu">${html}</div>`;
  const owner = getCurrentWindow();
  const request = crypto.randomUUID();
  const stop = await owner.listen<{ request: string; id: string; value?: string }>("native-menu-action", event => {
    if (event.payload.request !== request) return;
    if (event.payload.id !== "close") onAction(event.payload.id, event.payload.value);
  });
  const stopClose = await owner.listen<string>("native-menu-closed", event => {
    if (event.payload !== request) return;
    stop(); stopClose(); onClose?.();
  });
  try {
    const [scale, position] = await Promise.all([owner.scaleFactor(), owner.innerPosition()]);
    await invoke("native_menu_open", { request, html, height, x: position.x + x * scale, y: position.y + y * scale, width: width * scale });
  } catch (error) { stop(); stopClose(); onClose?.(); console.error("Native menu failed", error); }
}
