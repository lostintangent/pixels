import type { Viewport, ScreenPoint, DocumentPoint, ViewportInsets } from './contracts';

export const MIN_ZOOM = 1 / 32;
export const MAX_ZOOM = 128;
export const ZOOM_STEPS = [
  1 / 32,
  1 / 16,
  1 / 8,
  1 / 4,
  1 / 2,
  1,
  2,
  3,
  4,
  6,
  8,
  12,
  16,
  24,
  32,
  48,
  64,
  96,
  128,
] as const;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function nearestStepIndex(zoom: number): number {
  const bounded = clampZoom(zoom);
  let best = 0;
  let distance = Infinity;
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    const current = Math.abs(Math.log(bounded / ZOOM_STEPS[i]!));
    if (current < distance) {
      distance = current;
      best = i;
    }
  }
  return best;
}

export function snapZoom(zoom: number): number {
  return ZOOM_STEPS[nearestStepIndex(zoom)]!;
}

export function screenToDocument(viewport: Viewport, point: ScreenPoint): DocumentPoint {
  return {
    x: (point.x - viewport.panX) / viewport.zoom,
    y: (point.y - viewport.panY) / viewport.zoom,
  };
}

export function documentToScreen(viewport: Viewport, point: DocumentPoint): ScreenPoint {
  return { x: point.x * viewport.zoom + viewport.panX, y: point.y * viewport.zoom + viewport.panY };
}

/** Continuous, clamped zoom anchored at a screen point. Pinch calls this per frame. */
export function zoomAt(viewport: Viewport, requestedZoom: number, point: ScreenPoint): Viewport {
  if (!Number.isFinite(requestedZoom) || requestedZoom <= 0)
    throw new RangeError('Zoom must be positive and finite');
  const zoom = clampZoom(requestedZoom);
  const ratio = zoom / viewport.zoom;
  return {
    ...viewport,
    zoom,
    panX: point.x - (point.x - viewport.panX) * ratio,
    panY: point.y - (point.y - viewport.panY) * ratio,
  };
}

export function zoomToStep(
  viewport: Viewport,
  requestedZoom: number,
  point: ScreenPoint,
): Viewport {
  return zoomAt(viewport, snapZoom(requestedZoom), point);
}

export function settleZoom(viewport: Viewport, point: ScreenPoint): Viewport {
  return zoomToStep(viewport, viewport.zoom, point);
}

export function stepZoom(viewport: Viewport, direction: -1 | 1, point: ScreenPoint): Viewport {
  const zoom = clampZoom(viewport.zoom);
  if (direction > 0) {
    for (const step of ZOOM_STEPS) if (step > zoom) return zoomAt(viewport, step, point);
    return zoomAt(viewport, MAX_ZOOM, point);
  }
  for (let index = ZOOM_STEPS.length - 1; index >= 0; index--) {
    const step = ZOOM_STEPS[index]!;
    if (step < zoom) return zoomAt(viewport, step, point);
  }
  return zoomAt(viewport, MIN_ZOOM, point);
}

export function fitViewport(
  viewport: Viewport,
  documentWidth: number,
  documentHeight: number,
  insets: ViewportInsets | number = 0,
): Viewport {
  const edges =
    typeof insets === 'number'
      ? { top: insets, right: insets, bottom: insets, left: insets }
      : insets;
  const availableWidth = Math.max(1, viewport.cssWidth - edges.left - edges.right);
  const availableHeight = Math.max(1, viewport.cssHeight - edges.top - edges.bottom);
  const rawZoom = Math.min(availableWidth / documentWidth, availableHeight / documentHeight);
  let zoom: number;
  if (rawZoom >= 1) zoom = clampZoom(Math.floor(rawZoom));
  else {
    zoom = MIN_ZOOM;
    for (const step of ZOOM_STEPS) if (step <= rawZoom) zoom = step;
  }
  return {
    ...viewport,
    zoom,
    panX: edges.left + (availableWidth - documentWidth * zoom) / 2,
    panY: edges.top + (availableHeight - documentHeight * zoom) / 2,
  };
}
