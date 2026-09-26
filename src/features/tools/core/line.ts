import type { BitmapDocument, PixelPoint, PixelRect } from '../../document';
import { intersectRect, unionRect } from '../../document';
import type { DocumentHistory } from '../../history';
import type { Brush, LinePreview } from './contracts';
import { paintSquare, rasterLine, segmentBounds } from './raster';

export function snapLineEndpoint(from: PixelPoint, to: PixelPoint): PixelPoint {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  if (ax === 0 || ay === 0) return { x: to.x, y: to.y };
  const ratio = ay / ax;
  if (ratio < 0.198912367) return { x: to.x, y: from.y };
  if (ratio < 0.668178638) return { x: to.x, y: from.y + sy * Math.round(ax / 2) };
  if (ratio < 1.496605763)
    return { x: from.x + sx * Math.max(ax, ay), y: from.y + sy * Math.max(ax, ay) };
  if (ratio < 5.027339492) return { x: from.x + sx * Math.round(ay / 2), y: to.y };
  return { x: from.x, y: to.y };
}

export function beginLinePreview(
  document: BitmapDocument,
  from: PixelPoint,
  brush: Brush,
  history: DocumentHistory,
): LinePreview {
  const overlay = new Uint32Array(document.pixels.length);
  const width = document.width;
  const height = document.height;
  const bounds: PixelRect = { x: 0, y: 0, width, height };
  const clip: PixelRect = { x: 0, y: 0, width: 0, height: 0 };
  let current: PixelPoint = from;
  let dirty: PixelRect | null = null;
  let closed = false;
  const startX = Math.floor(from.x);
  const startY = Math.floor(from.y);

  function clearOverlay(): void {
    if (!dirty) return;
    for (let row = dirty.y; row < dirty.y + dirty.height; row++) {
      const start = row * width + dirty.x;
      overlay.fill(0, start, start + dirty.width);
    }
  }
  function draw(target: Uint32Array, to: PixelPoint): number {
    let changed = 0;
    rasterLine(startX, startY, Math.floor(to.x), Math.floor(to.y), (x, y) => {
      changed += paintSquare(target, width, height, x, y, brush.size, brush.color);
    });
    return changed;
  }

  return {
    overlay,
    get dirty() {
      return dirty;
    },
    update(to, snap = false) {
      if (closed) throw new Error('Line preview is closed');
      const previous = dirty;
      clearOverlay();
      current = snap ? snapLineEndpoint(from, to) : to;
      const raw = segmentBounds(
        startX,
        startY,
        Math.floor(current.x),
        Math.floor(current.y),
        brush.size,
      );
      dirty = intersectRect(raw, bounds, clip) ? { ...clip } : null;
      if (dirty) draw(overlay, current);
      if (!previous) return dirty;
      if (!dirty) return previous;
      return unionRect(previous, dirty, { x: 0, y: 0, width: 0, height: 0 });
    },
    commit() {
      if (closed) throw new Error('Line preview is closed');
      closed = true;
      clearOverlay();
      if (!dirty) return false;
      const transaction = history.begin('Line', document);
      transaction.capture(dirty);
      const changed = draw(document.pixels, current);
      if (!changed) {
        transaction.cancel();
        return false;
      }
      transaction.commit();
      document.events.invalidate(dirty);
      return true;
    },
    cancel() {
      if (closed) throw new Error('Line preview is closed');
      closed = true;
      clearOverlay();
    },
  };
}
