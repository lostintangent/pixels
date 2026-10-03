import type { Viewport } from '../../canvas/model';
import { MIN_ZOOM, snapZoomWithin } from '../../canvas/model';

/** Whole zooms read as a multiplier. Sub-1× power-of-two steps read as a percentage. */
export function formatZoom(zoom: number): string {
  if (zoom >= 1) return `${Math.round(zoom * 100) / 100}×`;
  return `${Math.round(zoom * 1000) / 10}%`;
}

/** The grid appears once each pixel is large enough to read as a cell. */
export const GRID_MIN_ZOOM = 8;

/**
 * Keep an exact fit label, but quantize a moving pinch to avoid per-frame chrome updates. A pinch
 * near the zoom-out floor reads as the floor, which is where it will settle.
 */
export function displayZoom(
  view: Pick<Viewport, 'zoom' | 'fittedZoom'>,
  minZoom = MIN_ZOOM,
): number {
  return view.fittedZoom === view.zoom ? view.zoom : snapZoomWithin(view.zoom, minZoom);
}
