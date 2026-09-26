import type { Viewport, ScreenPoint, DocumentPoint, ViewportInsets } from './contracts';

export const MIN_ZOOM = 1 / 32;
export const MAX_ZOOM = 128;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function snapZoom(zoom: number): number {
  const bounded = clampZoom(zoom);
  if (bounded >= 1) return Math.round(bounded);
  return clampZoom(2 ** Math.round(Math.log2(bounded)));
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

export function zoomAt(viewport: Viewport, point: ScreenPoint, factor: number): Viewport {
  if (!Number.isFinite(factor) || factor <= 0)
    throw new RangeError('Zoom factor must be positive and finite');
  return zoomToStep(viewport, viewport.zoom * factor, point);
}

export function zoomToStep(
  viewport: Viewport,
  requestedZoom: number,
  point: ScreenPoint,
): Viewport {
  const zoom = snapZoom(requestedZoom);
  const ratio = zoom / viewport.zoom;
  return {
    ...viewport,
    zoom,
    panX: point.x - (point.x - viewport.panX) * ratio,
    panY: point.y - (point.y - viewport.panY) * ratio,
  };
}

export function stepZoom(viewport: Viewport, direction: -1 | 1, point: ScreenPoint): Viewport {
  const current = snapZoom(viewport.zoom);
  const next =
    current < 1
      ? direction > 0
        ? current * 2
        : current / 2
      : direction > 0
        ? current + 1
        : current === 1
          ? 1 / 2
          : current - 1;
  return zoomToStep(viewport, next, point);
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
  const zoom = clampZoom(rawZoom >= 1 ? Math.floor(rawZoom) : 2 ** Math.floor(Math.log2(rawZoom)));
  return {
    ...viewport,
    zoom,
    panX: edges.left + (availableWidth - documentWidth * zoom) / 2,
    panY: edges.top + (availableHeight - documentHeight * zoom) / 2,
  };
}
