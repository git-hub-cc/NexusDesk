export const sidebarMaxSize = 80;
export const fileTreeMinWidth = 180;

export function workspacePanelMinSize(groupWidth: number, handleWidth: number, panelCount: number, minWidth = 260): number {
  const availableWidth = groupWidth - handleWidth;
  return availableWidth > 0 ? Math.min(minWidth / availableWidth * 100, 100 / panelCount) : 100 / panelCount;
}

export function sidebarPanelSizing(defaultSize: number, minSize: number) {
  return {
    minSize,
    maxSize: sidebarMaxSize,
    defaultSize: Math.min(sidebarMaxSize, Math.max(minSize, defaultSize)),
  };
}
