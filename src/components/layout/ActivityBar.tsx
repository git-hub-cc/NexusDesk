import { FolderTree, PanelRight, PanelBottom, Settings, Mic } from "lucide-react";
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
    leftSidebarVisible, rightSidebarVisible, bottomPanelVisible,
    toggleLeftSidebar, toggleRightSidebar, toggleBottomPanel,
  } = useLayoutStore();

  useEffect(() => {
    const toggle = () => {
      if (speechOpenRef.current) {
        window.dispatchEvent(new CustomEvent("noteide-speech-close"));
        return;
      }
      speechOpenRef.current = true;
      setSpeechOpen(true);
      window.dispatchEvent(new CustomEvent("noteide-speech-state", { detail: { open: true } }));
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
    window.addEventListener("noteide-speech-toggle", toggle);
    window.addEventListener("noteide-speech-close", close);
    window.addEventListener("noteide-speech-state", syncSpeechState);
    window.addEventListener("blur", clearTarget);
    // 原生全局快捷键通过 Tauri 事件送达，统一转交给现有语音开关。
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      void getCurrentWindow().listen<{ stop?: boolean }>("noteide-speech-toggle", event => {
        if (!disposed) window.dispatchEvent(new CustomEvent(
          event?.payload?.stop ? "noteide-speech-close" : "noteide-speech-toggle",
        ));
      }).then(stop => {
        if (disposed) stop();
        else unlisten = stop;
      }).catch(console.error);
    }
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("noteide-speech-toggle", toggle);
      window.removeEventListener("noteide-speech-close", close);
      window.removeEventListener("noteide-speech-state", syncSpeechState);
      window.removeEventListener("blur", clearTarget);
    };
  }, []);

  const closeSpeech = () => {
    speechOpenRef.current = false;
    setSpeechOpen(false);
    window.dispatchEvent(new CustomEvent("noteide-speech-state", { detail: { open: false } }));
  };

  const insertSpeech = (text: string, requestId: string) => {
    return invoke<void>("paste_text", { text, requestId }).catch(error => {
      console.error("语音文本粘贴失败", error);
      window.dispatchEvent(new CustomEvent("noteide-speech-error", {
        detail: { message: `文本已复制到剪贴板，但自动粘贴失败：${String(error)}` },
      }));
    });
  };

  const panels = [
    { label: "文件树", icon: FolderTree, visible: leftSidebarVisible, toggle: toggleLeftSidebar },
    { label: "右侧面板", icon: PanelRight, visible: rightSidebarVisible, toggle: toggleRightSidebar },
    { label: "底部面板", icon: PanelBottom, visible: bottomPanelVisible, toggle: toggleBottomPanel },
  ];

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
        <button
          type="button"
          className="activity-bar-button no-drag-region"
          aria-label="语音转文字"
          aria-pressed={speechOpen}
          title="语音转文字"
          onClick={() => window.dispatchEvent(new CustomEvent("noteide-speech-toggle"))}
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
