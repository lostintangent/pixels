/** Whole zooms read as a multiplier. Sub-1× power-of-two steps read as a percentage. */
export function formatZoom(zoom: number): string {
  if (zoom >= 1) return `${Math.round(zoom * 100) / 100}×`;
  return `${Math.round(zoom * 1000) / 10}%`;
}

/** The grid appears once each pixel is large enough to read as a cell. */
export const GRID_MIN_ZOOM = 8;
