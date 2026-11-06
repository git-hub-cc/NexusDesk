import "./lib/logging";
import React from "react";
import ReactDOM from "react-dom/client";
import { flushGlobalSettings, initializeGlobalSettings } from "./lib/globalSettings";
import { flushUIState } from "./lib/uiPersistence";
import { invoke, isTauri } from "@tauri-apps/api/core";

// Cancel the native menu after application context-menu handlers have run.
document.addEventListener("contextmenu", event => event.preventDefault());

// Run after application handlers so implemented shortcuts keep their behavior.
window.addEventListener("keydown", event => {
  // 如果事件已经被应用内的组件（如编辑器、全局快捷键钩子）处理，则直接放行
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  if (event.target instanceof Element && event.target.closest(".xterm")) return;

  const key = event.key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;

  if (isTauri() && event.altKey && !command && !event.shiftKey && key === "a") {
    event.preventDefault();
    void invoke("capture_start").catch(error => console.error("无法启动截图:", error));
  }

  // 保留 F12 的 WebView2 原生开发者工具快捷键，便于查看元素和调试页面。
  const isFunctionKey = /^f(1[0-2]|[1-9])$/.test(key) && key !== "f12";

  // 2. 拦截带有 Ctrl/Cmd 的组合键，但放行系统原生文本编辑键 (A, C, V, X, Z, Y)
  // 防止触发浏览器的 Ctrl+P(打印), Ctrl+S(保存网页), Ctrl+O(打开文件), Ctrl+T(新标签页) 等
  const isUnhandledCommand = command && !["a", "c", "v", "x", "z", "y"].includes(key);

  // 3. 拦截 Alt + 导航键，防止触发浏览器历史记录前进/后退
  const isBrowserNavigation = event.altKey && ["arrowleft", "arrowright", "home", "end"].includes(key);

  if (isFunctionKey || isUnhandledCommand || isBrowserNavigation) {
    event.preventDefault();
  }
});

async function boot() {
  // Hydrate the shared cache before importing stores with synchronous persist.
  await initializeGlobalSettings();
  if (isTauri() && new URLSearchParams(window.location.search).get("speech") === "global") {
    const { GlobalSpeechInput } = await import("./components/GlobalSpeechInput");
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().onCloseRequested(event => {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent("nexusdesk-speech-close"));
    });
    document.body.classList.add("global-speech-input");
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<GlobalSpeechInput />);
    return;
  }
  const [{ default: App }, { CaptureResult }, { useWorkspaceStore }, { useTerminalStore }, { useBrowserHistoryStore }] = await Promise.all([
    import("./App"), import("./components/CaptureResult"), import("./store/workspaceStore"),
    import("./store/terminalStore"), import("./store/browserHistoryStore"),
  ]);
  window.addEventListener("global-settings-changed", () => {
    void useWorkspaceStore.persist?.rehydrate();
    void useTerminalStore.persist.rehydrate();
    void useBrowserHistoryStore.persist.rehydrate();
  });
  const snapshotUI = () => {
    window.dispatchEvent(new Event("nexusdesk-snapshot-ui"));
    flushUIState();
  };
  window.addEventListener("blur", () => { snapshotUI(); void flushGlobalSettings().catch(console.error); });
  window.addEventListener("pagehide", snapshotUI);
  if (isTauri()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    let closing = false;
    let closeReady = false;
    await getCurrentWindow().onCloseRequested(async event => {
      if (closeReady) return;
      event.preventDefault();
      if (closing) return;
      closing = true;
      try {
        snapshotUI();
        const { flushPendingWrites } = await import("./store/workspaceStore");
        await flushPendingWrites();
        snapshotUI();
        await flushGlobalSettings();
        closeReady = true;
        await getCurrentWindow().close();
      }
      catch (error) {
        closeReady = false;
        const { showError } = await import("./lib/dialogs");
        showError(`全局配置保存失败，请重试关闭窗口。\n${String(error)}`);
      } finally { closing = false; }
    });
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode><App /><CaptureResult /></React.StrictMode>,
  );
}
void boot().catch(async error => {
  console.error("Cannot load global settings:", error);
  document.getElementById("root")!.textContent = `无法加载全局配置，请重启重试。\n${String(error)}`;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().show();
});

