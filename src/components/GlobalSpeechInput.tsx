import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SpeechToText } from "./editor/SpeechToText";
import "../App.css";

export function GlobalSpeechInput() {
  const insert = async (text: string) => {
    try {
      await invoke("paste_text", { text });
    } catch (error) {
      throw new Error(`文本已复制到剪贴板，自动填入失败：${String(error)}`);
    }
  };

  return <SpeechToText finishOnClose onInsert={insert} onClose={() => {
    void getCurrentWindow().destroy().catch(console.error);
  }} />;
}
