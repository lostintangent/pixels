import { fitViewport, stepZoom } from '../../canvas/model';
import type { Viewport, ViewportInsets } from '../../canvas/model';

/** A floating island in canvas CSS pixels, such as the desktop color panel. */
export interface IslandRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Breathing room between the document and an island it has to clear. */
const ISLAND_GAP = 12;

/**
 * Fits the document inside `frame` and keeps it truly centered unless that would put it under an
 * island. Then it steps down the zoom ladder, still centered, until the document clears. Moving
 * beside the island's column is the last resort. So a tall window doesn't shove a document
 * sideways for a panel that sits entirely above it.
 */
export function fitAroundIslands(
  view: Viewport,
  documentWidth: number,
  documentHeight: number,
  frame: ViewportInsets,
  islands: readonly IslandRect[],
): Viewport {
  const centered = fitViewport(view, documentWidth, documentHeight, frame);
  const blocking = islands.filter((island) =>
    overlaps(documentRect(centered, documentWidth, documentHeight), island),
  );
  if (blocking.length === 0) return centered;

  const beside = fitViewport(
    view,
    documentWidth,
    documentHeight,
    reserveColumns(view, frame, blocking),
  );
  const center = frameCenter(view, frame);
  let zoom = centered.zoom;
  while (zoom > beside.zoom) {
    zoom = stepZoom({ ...view, zoom }, -1, center).zoom;
    const smaller = centerAt(view, zoom, documentWidth, documentHeight, center);
    const rect = documentRect(smaller, documentWidth, documentHeight);
    if (!islands.some((island) => overlaps(rect, island))) return smaller;
  }
  return beside;
}

/** The screen point zoom buttons anchor on: the middle of the frame. */
export function frameCenter(view: Viewport, frame: ViewportInsets): { x: number; y: number } {
  return {
    x: frame.left + (view.cssWidth - frame.left - frame.right) / 2,
    y: frame.top + (view.cssHeight - frame.top - frame.bottom) / 2,
  };
}

function reserveColumns(
  view: Viewport,
  frame: ViewportInsets,
  islands: readonly IslandRect[],
): ViewportInsets {
  let { left, right } = frame;
  for (const island of islands) {
    if (island.left + island.right > view.cssWidth)
      right = Math.max(right, view.cssWidth - island.left + ISLAND_GAP);
    else left = Math.max(left, island.right + ISLAND_GAP);
  }
  return { ...frame, left, right };
}

function centerAt(
  view: Viewport,
  zoom: number,
  documentWidth: number,
  documentHeight: number,
  { x, y }: { x: number; y: number },
): Viewport {
  return {
    ...view,
    zoom,
    panX: x - (documentWidth * zoom) / 2,
    panY: y - (documentHeight * zoom) / 2,
  };
}

function documentRect(view: Viewport, width: number, height: number): IslandRect {
  return {
    left: view.panX,
    top: view.panY,
    right: view.panX + width * view.zoom,
    bottom: view.panY + height * view.zoom,
  };
}

function overlaps(a: IslandRect, b: IslandRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
