import type { Viewport } from '../../canvas/model';
import { snapZoom } from '../../canvas/model';

/** Whole zooms read as a multiplier. Sub-1× power-of-two steps read as a percentage. */
export function formatZoom(zoom: number): string {
  if (zoom >= 1) return `${Math.round(zoom * 100) / 100}×`;
  return `${Math.round(zoom * 1000) / 10}%`;
}

/** The grid appears once each pixel is large enough to read as a cell. */
export const GRID_MIN_ZOOM = 8;

/** Keep an exact fit label, but quantize a moving pinch to avoid per-frame chrome updates. */
export function displayZoom(view: Pick<Viewport, 'zoom' | 'fittedZoom'>): number {
  return view.fittedZoom === view.zoom ? view.zoom : snapZoom(view.zoom);
}
