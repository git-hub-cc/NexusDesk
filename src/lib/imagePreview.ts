/** Keep the whole image visible, enlarging small images when space permits. */
export function imagePreviewScale(width: number, height: number, availableWidth: number, availableHeight: number): number {
  if (width <= 0 || height <= 0 || availableWidth <= 0 || availableHeight <= 0) return 1;
  const fit = Math.min(availableWidth / width, availableHeight / height);
  const minimum = 100 / Math.min(width, height);
  // Very narrow images can hit the viewport limit before their short side reaches 100px.
  return Math.min(fit, Math.max(1, minimum));
}
