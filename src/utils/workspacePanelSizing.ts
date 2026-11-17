export const sidebarMaxSize = 80;

export function workspacePanelMinSize(groupWidth: number, handleWidth: number, panelCount: number): number {
  const availableWidth = groupWidth - handleWidth;
  // If the window cannot fit every panel at 260px, share the available space.
  return availableWidth > 0 ? Math.min(260 / availableWidth * 100, 100 / panelCount) : 100 / panelCount;
}
