import type { ScreenPoint, Viewport, ViewportInsets } from './contracts';
import { ZOOM_STEPS, zoomAt } from './viewport';

/*
 * Keeps the document findable. Zoom never drops below a floor, and on each axis the document keeps
 * overlapping the frame by a quarter of the frame, or entirely when it is smaller than that. Wheel
 * and keyboard input stop at a limit. Direct drags and pinches stretch past it with resistance,
 * then ease back on release.
 */

export interface ViewBounds {
  /** The lowest zoom, which the editor sets to the smaller of its fit and 1×. */
  minZoom: number;
  /** Insets of the frame the document has to keep overlapping. */
  frame: ViewportInsets;
  documentWidth: number;
  documentHeight: number;
}

/** The share of the frame, per axis, the document keeps covering. */
export const MIN_OVERLAP = 1 / 4;
/** How stiff the stretch feels. 0.55 matches the scroll views people already know. */
const RUBBER = 0.55;
/** A pinch can stretch at most this far below the floor, in natural-log zoom. */
const ZOOM_GIVE = Math.LN2;

/**
 * How far a drag `overshoot` past a limit actually moves. It starts at about half speed and never
 * reaches `dimension`, so the further you pull, the less it gives.
 */
export function rubberBand(overshoot: number, dimension: number): number {
  if (overshoot <= 0 || dimension <= 0) return 0;
  return dimension * (1 - 1 / ((overshoot * RUBBER) / dimension + 1));
}

/**
 * The nearest ladder step at or above the floor, or the floor itself when that's closer. A `keep`
 * zoom at or above the floor is a candidate too, so a gesture that ends near where it started can
 * return to an off-ladder fit.
 */
export function snapZoomWithin(zoom: number, minZoom: number, keep?: number): number {
  let best = minZoom;
  let distance = Math.abs(Math.log(zoom / minZoom));
  if (keep !== undefined && keep >= minZoom) {
    const current = Math.abs(Math.log(zoom / keep));
    if (current < distance) {
      best = keep;
      distance = current;
    }
  }
  for (const step of ZOOM_STEPS) {
    if (step < minZoom) continue;
    const current = Math.abs(Math.log(zoom / step));
    if (current < distance) {
      best = step;
      distance = current;
    }
  }
  return best;
}

/**
 * Where a free pinch comes to rest around `at`: the nearest ladder step at or above the floor, the
 * floor, or the zoom the gesture started from, with pan on whole CSS pixels. Returning exactly to a
 * fitted start keeps its fitted label. The caller still bounds the result.
 */
export function settleView(
  view: Viewport,
  minZoom: number,
  at: ScreenPoint,
  start?: Viewport,
): Viewport {
  const zoom = snapZoomWithin(view.zoom, minZoom, start?.zoom);
  const end = zoomAt(view, zoom, at);
  end.panX = Math.round(end.panX);
  end.panY = Math.round(end.panY);
  if (start?.fittedZoom === zoom && start.zoom === zoom) end.fittedZoom = zoom;
  return end;
}

/**
 * The view moved inside `bounds`. A zoom below the floor lifts around `at`, which defaults to the
 * frame's center, then each axis's pan clamps. With `elastic`, both stretch past their limit with
 * resistance instead of stopping. Returns `view` itself when it is already inside.
 */
export function boundView(
  view: Viewport,
  bounds: ViewBounds,
  at?: ScreenPoint,
  elastic = false,
): Viewport {
  const { minZoom, frame, documentWidth, documentHeight } = bounds;
  let next = view;
  if (view.zoom < minZoom) {
    const zoom = elastic
      ? minZoom * Math.exp(-rubberBand(Math.log(minZoom / view.zoom), ZOOM_GIVE))
      : minZoom;
    next = zoomAt(view, zoom, at ?? frameMiddle(view, frame));
  }
  const panX = boundAxis(
    next.panX,
    documentWidth * next.zoom,
    frame.left,
    next.cssWidth - frame.right,
    elastic,
  );
  const panY = boundAxis(
    next.panY,
    documentHeight * next.zoom,
    frame.top,
    next.cssHeight - frame.bottom,
    elastic,
  );
  if (panX === next.panX && panY === next.panY) return next;
  if (next === view) return { ...view, panX, panY };
  // `next` is a fresh view from zoomAt, so it can take the pan without another copy.
  next.panX = panX;
  next.panY = panY;
  return next;
}

/**
 * One axis. The document's leading edge `pan` may range from where its trailing edge covers the
 * frame's start by `need`, to where its leading edge sits `need` before the frame's end. Limits
 * round inward to whole CSS pixels when they can, so a stop lands pixel-aligned.
 */
function boundAxis(
  pan: number,
  size: number,
  start: number,
  end: number,
  elastic: boolean,
): number {
  const frame = end - start;
  if (frame <= 0 || size <= 0) return pan;
  const need = Math.min(frame * MIN_OVERLAP, size);
  let low = start + need - size;
  let high = end - need;
  const roundedLow = Math.ceil(low);
  const roundedHigh = Math.floor(high);
  if (roundedLow <= roundedHigh) {
    low = roundedLow;
    high = roundedHigh;
  }
  if (pan < low) return elastic ? low - rubberBand(low - pan, frame) : low;
  if (pan > high) return elastic ? high + rubberBand(pan - high, frame) : high;
  return pan;
}

function frameMiddle(view: Viewport, frame: ViewportInsets): ScreenPoint {
  return {
    x: frame.left + (view.cssWidth - frame.left - frame.right) / 2,
    y: frame.top + (view.cssHeight - frame.top - frame.bottom) / 2,
  };
}
