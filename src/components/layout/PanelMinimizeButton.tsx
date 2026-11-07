import { Minus } from "lucide-react";
import { useLayoutStore } from "@/store/layoutStore";

const panels = {
  left: { visibility: "leftSidebarVisible", label: "最小化左侧面板" },
  right: { visibility: "rightSidebarVisible", label: "最小化右侧面板" },
  bottom: { visibility: "bottomPanelVisible", label: "最小化底部面板" },
} as const;

export function PanelMinimizeButton({ panel, className = "" }: { panel: keyof typeof panels; className?: string }) {
  const { visibility, label } = panels[panel];
  return <button type="button" title={label} aria-label={label}
    onClick={() => useLayoutStore.setState({ [visibility]: false })}
    className={`pointer-events-none opacity-0 group-hover/panel:pointer-events-auto group-hover/panel:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 ml-auto flex h-6 w-6 items-center justify-center shrink-0 rounded text-gray-400 hover:bg-white/10 hover:text-white active:bg-white/15 ${className}`}><Minus size={14} /></button>;
}
