import { useState } from "react";
import { Code, Image } from "lucide-react";
import { type Tab, useWorkspaceStore } from "@/store/workspaceStore";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { ImageEditor } from "./ImageEditor";

export function SvgEditor({ tab, pane, active }: { tab: Tab; pane: "left" | "right"; active: boolean }) {
  const [mode, setMode] = useState<"text" | "image">("text");
  const setFocusedPane = useWorkspaceStore(state => state.setFocusedPane);

  return <div className="absolute inset-0 flex min-h-0 flex-col"
    onFocusCapture={() => setFocusedPane(pane)} onPointerDown={() => setFocusedPane(pane)}>
    <div className="markdown-toolbar" role="group" aria-label="SVG 显示模式">
      <button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")}>
        <Code size={14} aria-hidden="true" />文本
      </button>
      <button type="button" aria-pressed={mode === "image"} onClick={() => setMode("image")}>
        <Image size={14} aria-hidden="true" />图片
      </button>
    </div>
    <div className="relative flex-1 min-h-0">
      <div className={`absolute inset-0 ${mode === "text" ? "" : "hidden"}`}>
        <CodeMirrorEditor pane={pane} tabId={tab.id} navigationEnabled={active && mode === "text"} />
      </div>
      {mode === "image" && <ImageEditor path={tab.path} sourceContent={tab.content ?? ""} />}
    </div>
  </div>;
}
