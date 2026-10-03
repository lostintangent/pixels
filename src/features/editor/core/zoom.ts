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
 * Names where the view will rest: an exact fit reads exactly, and a moving pinch quantizes to the
 * same candidates its settle uses (ladder, floor, or the fit it started from), so chrome updates
 * only when that destination changes.
 */
export function displayZoom(
  view: Pick<Viewport, 'zoom' | 'fittedZoom'>,
  minZoom = MIN_ZOOM,
): number {
  return snapZoomWithin(view.zoom, minZoom, view.fittedZoom);
}
