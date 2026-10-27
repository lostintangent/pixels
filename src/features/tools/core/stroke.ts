import type { BitmapDocument, PixelRect } from '../../document';
import { intersectRect } from '../../document';
import type { DocumentHistory } from '../../history';
import type { Brush, MutationResult, StrokeSample, StrokeSession } from './contracts';
import { paintSquare, rasterLine, segmentBounds } from './raster';

export function beginStroke(
  document: BitmapDocument,
  brush: Brush,
  history: DocumentHistory,
): StrokeSession {
  if (!Number.isInteger(brush.size) || brush.size < 1 || brush.size > 64)
    throw new RangeError('Brush size must be 1 to 64');
  const transaction = history.begin(document);
  const bounds: PixelRect = { x: 0, y: 0, width: document.width, height: document.height };
  const clipped: PixelRect = { x: 0, y: 0, width: 0, height: 0 };
  let lastSample: StrokeSample | null = null;
  let lastX = NaN;
  let lastY = NaN;
  let previousX = NaN;
  let previousY = NaN;
  let lastBefore = 0;
  let changedTotal = 0;
  let closed = false;
  const color = brush.color >>> 0;
  const pixelPerfect = brush.pixelPerfect && brush.size === 1;

  function plot(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= document.width || y >= document.height) return;
    if (pixelPerfect) {
      if (x === lastX && y === lastY) return;
      const diagonal = Math.abs(x - previousX) === 1 && Math.abs(y - previousY) === 1;
      const elbow = (lastX === previousX && lastY === y) || (lastY === previousY && lastX === x);
      if (diagonal && elbow) {
        const oldIndex = lastY * document.width + lastX;
        if (document.pixels[oldIndex] !== lastBefore) {
          document.pixels[oldIndex] = lastBefore;
          changedTotal++;
        }
      } else {
        previousX = lastX;
        previousY = lastY;
      }
      const index = y * document.width + x;
      lastBefore = document.pixels[index]!;
      if (lastBefore !== color) {
        document.pixels[index] = color;
        changedTotal++;
      }
      lastX = x;
      lastY = y;
    } else {
      changedTotal += paintSquare(
        document.pixels,
        document.width,
        document.height,
        x,
        y,
        brush.size,
        color,
      );
    }
  }

  return {
    extend(sample): MutationResult {
      if (closed) throw new Error('Stroke is closed');
      const x = Math.floor(sample.x);
      const y = Math.floor(sample.y);
      const fromX = lastSample ? Math.floor(lastSample.x) : x;
      const fromY = lastSample ? Math.floor(lastSample.y) : y;
      const dirty = segmentBounds(fromX, fromY, x, y, brush.size);
      lastSample = sample;
      if (!intersectRect(dirty, bounds, clipped)) return { dirty: null, changedPixels: 0 };
      transaction.capture(clipped);
      const before = changedTotal;
      rasterLine(fromX, fromY, x, y, plot);
      const changedPixels = changedTotal - before;
      if (changedPixels > 0) {
        document.events.invalidate(clipped);
        return { dirty: { ...clipped }, changedPixels };
      }
      return { dirty: null, changedPixels: 0 };
    },
    end() {
      if (closed) throw new Error('Stroke is closed');
      closed = true;
      if (!changedTotal) {
        transaction.cancel();
        return false;
      }
      return transaction.commit();
    },
    cancel() {
      if (closed) throw new Error('Stroke is closed');
      closed = true;
      transaction.cancel();
    },
  };
}
