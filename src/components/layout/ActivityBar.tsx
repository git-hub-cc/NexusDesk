import { PanelRight, PanelBottom, PanelBottomDashed, Settings, Mic, PanelLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SpeechToText } from "@/components/editor/SpeechToText";
import { setSpeechTarget } from "@/lib/speechTarget";
import { useLayoutStore } from "@/store/layoutStore";
import * as Dialog from "@radix-ui/react-dialog";

export function ActivityBar({ settingsOpen, onLeaveSettings }: { settingsOpen: boolean; onLeaveSettings: () => void }) {
  const [speechOpen, setSpeechOpen] = useState(false);
  const speechOpenRef = useRef(false);
  speechOpenRef.current = speechOpen;
  const {
    leftSidebarVisible, rightSidebarVisible, bottomPanelVisible, bottomPanelWidth,
    toggleLeftSidebar, toggleRightSidebar, toggleBottomPanel, setBottomPanelWidth,
  } = useLayoutStore();

  useEffect(() => {
    const toggle = () => {
      if (speechOpenRef.current) {
        window.dispatchEvent(new CustomEvent("nexusdesk-speech-close"));
        return;
      }
      speechOpenRef.current = true;
      setSpeechOpen(true);
      window.dispatchEvent(new CustomEvent("nexusdesk-speech-state", { detail: { open: true } }));
    };
    const close = () => {
      speechOpenRef.current = false;
      setSpeechOpen(false);
    };
    const syncSpeechState = (event: Event) => {
      const open = (event as CustomEvent<{ open?: boolean }>).detail?.open === true;
      speechOpenRef.current = open;
      setSpeechOpen(open);
    };
    const clearTarget = () => {
      setSpeechTarget(null);
    };
    const handleShortcut = (event: MouseEvent) => {
      if (event.altKey && event.button === 0) {
        if ((event.target as HTMLElement | null)?.closest?.('[aria-label="语音转文字"]')) return;
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("nexusdesk-speech-toggle"));
      }
    };
    window.addEventListener("nexusdesk-speech-toggle", toggle);
    window.addEventListener("nexusdesk-speech-close", close);
    window.addEventListener("nexusdesk-speech-state", syncSpeechState);
    window.addEventListener("blur", clearTarget);
    window.addEventListener("mousedown", handleShortcut);
    // 原生全局快捷键通过 Tauri 事件送达，统一转交给现有语音开关。
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      void getCurrentWindow().listen<{ stop?: boolean }>("nexusdesk-speech-toggle", event => {
        if (!disposed) window.dispatchEvent(new CustomEvent(
          event?.payload?.stop ? "nexusdesk-speech-close" : "nexusdesk-speech-toggle",
        ));
      }).then(stop => {
        if (disposed) stop();
        else unlisten = stop;
      }).catch(console.error);
    }
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("nexusdesk-speech-toggle", toggle);
      window.removeEventListener("nexusdesk-speech-close", close);
      window.removeEventListener("nexusdesk-speech-state", syncSpeechState);
      window.removeEventListener("blur", clearTarget);
      window.removeEventListener("mousedown", handleShortcut);
    };
  }, []);

  const closeSpeech = () => {
    speechOpenRef.current = false;
    setSpeechOpen(false);
    window.dispatchEvent(new CustomEvent("nexusdesk-speech-state", { detail: { open: false } }));
  };

  const insertSpeech = (text: string, requestId: string) => {
    return invoke<void>("paste_text", { text, requestId }).catch(error => {
      console.error("语音文本粘贴失败", error);
      window.dispatchEvent(new CustomEvent("nexusdesk-speech-error", {
        detail: { message: `文本已复制到剪贴板，但自动粘贴失败：${String(error)}` },
      }));
    });
  };

  const panels = [
    { label: "左侧面板", icon: PanelLeft, visible: leftSidebarVisible, toggle: toggleLeftSidebar },
    { label: "右侧面板", icon: PanelRight, visible: rightSidebarVisible, toggle: toggleRightSidebar },
    { label: "底部面板", icon: PanelBottom, visible: bottomPanelVisible, toggle: toggleBottomPanel },
  ];
  const bottomPanelModes = [
    { mode: "full", label: "底部面板占满宽度", icon: PanelBottom },
    { mode: "sidebar", label: "底部面板与左侧面板等宽", icon: PanelBottomDashed },
  ] as const;

  return (
    <aside data-tauri-drag-region aria-label="工具窗口" className="activity-bar drag-region">
      <div data-tauri-drag-region className="drag-region flex flex-col gap-1">
        {panels.map(({ label, icon: Icon, visible, toggle }) => (
          <button
            key={label}
            type="button"
            className="activity-bar-button no-drag-region"
            aria-label={label}
            aria-pressed={visible}
            title={`${visible ? "隐藏" : "显示"}${label}`}
            onClick={() => { toggle(); onLeaveSettings(); }}
          >
            <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ))}
      </div>

      <div data-tauri-drag-region className="drag-region mt-auto flex flex-col gap-1">
        {bottomPanelModes.map(({ mode, label, icon: Icon }) => (
          <button key={mode} type="button" className="activity-bar-button no-drag-region"
            aria-label={label} title={label} aria-pressed={bottomPanelWidth === mode}
            onClick={() => {
              setBottomPanelWidth(mode);
              const layout = useLayoutStore.getState();
              if (mode === "sidebar" && !layout.leftSidebarVisible) layout.toggleLeftSidebar();
              layout.openBottomPanel(layout.bottomPanelTab);
              onLeaveSettings();
            }}>
            <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ))}
        <button
          type="button"
          className="activity-bar-button no-drag-region"
          aria-label="语音转文字"
          aria-pressed={speechOpen}
          title="语音转文字 (Alt+鼠标左键)"
          onClick={() => window.dispatchEvent(new CustomEvent("nexusdesk-speech-toggle"))}
        >
          <Mic size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <Dialog.Trigger asChild>
          <button type="button" className="activity-bar-button no-drag-region" aria-label="设置" title="设置" aria-pressed={settingsOpen}>
            <Settings size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Dialog.Trigger>
      </div>
      {speechOpen && <SpeechToText onClose={closeSpeech} onInsert={insertSpeech} />}
    </aside>
  );
}
