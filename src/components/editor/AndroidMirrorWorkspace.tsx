import { useLayoutEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { MIRROR_HOME, useWorkspaceStore } from "@/store/workspaceStore";
import { AndroidMirrorPanel } from "./AndroidMirrorPanel";

// Keep mirror components under one React parent so moving a tab between panes
// does not unmount its decoder or disconnect the phone.
function MirrorPosition({ pane, active }: { pane: "left" | "right"; active: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = document.querySelector<HTMLElement>(`[data-editor-mirror-host="${pane}"]`);
    const target = element.current;
    if (!host || !target) return;
    let frame: number | null = null;
    const layout = () => {
      frame = null;
      const rect = host.getBoundingClientRect();
      Object.assign(target.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    };
    const scheduleLayout = () => {
      if (frame === null) frame = requestAnimationFrame(layout);
    };
    layout();
    const observer = new ResizeObserver(scheduleLayout);
    // Ancestor changes can move the host without changing its size.
    for (let parent: HTMLElement | null = host; parent; parent = parent.parentElement) observer.observe(parent);
    window.addEventListener("resize", scheduleLayout);
    return () => { observer.disconnect(); window.removeEventListener("resize", scheduleLayout); if (frame !== null) cancelAnimationFrame(frame); };
  }, [pane, active]);
  return <div ref={element} className={`fixed ${active ? "" : "hidden"}`} aria-hidden={!active} inert={!active}
    onPointerDown={() => useWorkspaceStore.getState().setFocusedPane(pane)}>
    <AndroidMirrorPanel active={active} />
  </div>;
}

export function AndroidMirrorWorkspace() {
  const { left, right, activeLeft, activeRight, split } = useWorkspaceStore(useShallow(state => ({
    left: state.leftTabs, right: state.rightTabs, activeLeft: state.activeLeftTabId, activeRight: state.activeRightTabId, split: state.isSplitMode,
  })));
  const seen = new Set<string>();
  return <>{([['left', left, activeLeft], ['right', right, activeRight]] as const).flatMap(([pane, tabs, activeId]) =>
    tabs.filter(tab => tab.browser?.url === MIRROR_HOME).map(tab => {
      const key = seen.has(tab.id) ? `${tab.id}:copy` : tab.id;
      seen.add(tab.id);
      return <MirrorPosition key={key} pane={pane} active={tab.id === activeId && (pane === "left" || split)} />;
    }))}</>;
}
