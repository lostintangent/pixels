import type { BitmapDocument, PixelPoint, PixelRect } from '../../document';
import { intersectRect, unionRect } from '../../document';
import type { DocumentHistory } from '../../history';
import type { Brush, LinePreview } from './contracts';
import { paintSquare, rasterLine, segmentBounds } from './raster';

export class LinePreviewWorkspace {
  pixels = new Uint32Array(256);
  ensure(pixelCount: number): Uint32Array {
    if (this.pixels.length < pixelCount)
      this.pixels = new Uint32Array(Math.max(pixelCount, this.pixels.length * 2));
    return this.pixels;
  }
}

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
  workspace = new LinePreviewWorkspace(),
): LinePreview {
  const documentBounds: PixelRect = { x: 0, y: 0, width: document.width, height: document.height };
  const clip: PixelRect = { x: 0, y: 0, width: 0, height: 0 };
  let current: PixelPoint = from;
  let dirty: PixelRect | null = null;
  let closed = false;
  const startX = Math.floor(from.x);
  const startY = Math.floor(from.y);

  function draw(
    target: Uint32Array,
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
  ): number {
    let changed = 0;
    rasterLine(startX, startY, Math.floor(current.x), Math.floor(current.y), (x, y) => {
      changed += paintSquare(
        target,
        width,
        height,
        x - offsetX,
        y - offsetY,
        brush.size,
        brush.color,
      );
    });
    return changed;
  }

  return {
    get overlay() {
      return workspace.pixels;
    },
    get bounds() {
      return dirty;
    },
    get dirty() {
      return dirty;
    },
    update(to, snap = false) {
      if (closed) throw new Error('Line preview is closed');
      const previous = dirty;
      current = snap ? snapLineEndpoint(from, to) : to;
      const raw = segmentBounds(
        startX,
        startY,
        Math.floor(current.x),
        Math.floor(current.y),
        brush.size,
      );
      dirty = intersectRect(raw, documentBounds, clip) ? { ...clip } : null;
      if (dirty) {
        const pixels = workspace.ensure(dirty.width * dirty.height);
        pixels.fill(0, 0, dirty.width * dirty.height);
        draw(pixels, dirty.width, dirty.height, dirty.x, dirty.y);
      }
      if (!previous) return dirty;
      if (!dirty) return previous;
      return unionRect(previous, dirty, { x: 0, y: 0, width: 0, height: 0 });
    },
    commit() {
      if (closed) throw new Error('Line preview is closed');
      closed = true;
      if (!dirty) return false;
      const transaction = history.begin('Line', document);
      transaction.capture(dirty);
      const changed = draw(document.pixels, document.width, document.height, 0, 0);
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
      if (dirty) workspace.pixels.fill(0, 0, dirty.width * dirty.height);
    },
  };
}
