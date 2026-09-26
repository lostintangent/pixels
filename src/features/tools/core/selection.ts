import type { BitmapDocument, PixelRect } from '../../document';
import { intersectRect, unionRect } from '../../document';
import type { DocumentHistory, HistoryTransaction } from '../../history';
import type { FloatingSelection, SelectionSession } from './contracts';

function copyRegion(document: BitmapDocument, rect: PixelRect): FloatingSelection | null {
  const bounds: PixelRect = { x: 0, y: 0, width: document.width, height: document.height };
  const clip: PixelRect = { x: 0, y: 0, width: 0, height: 0 };
  if (!intersectRect(rect, bounds, clip)) return null;
  const region = { ...clip };
  const pixels = new Uint32Array(region.width * region.height);
  for (let row = 0; row < region.height; row++) {
    const source = (region.y + row) * document.width + region.x;
    pixels.set(document.pixels.subarray(source, source + region.width), row * region.width);
  }
  return { bounds: { ...region }, sourceBounds: region, pixels };
}

function pasteRegion(document: BitmapDocument, selection: FloatingSelection): PixelRect | null {
  const documentBounds: PixelRect = { x: 0, y: 0, width: document.width, height: document.height };
  const clip: PixelRect = { x: 0, y: 0, width: 0, height: 0 };
  if (!intersectRect(selection.bounds, documentBounds, clip)) return null;
  for (let row = 0; row < clip.height; row++) {
    const source =
      (row + clip.y - selection.bounds.y) * selection.bounds.width + clip.x - selection.bounds.x;
    const target = (clip.y + row) * document.width + clip.x;
    document.pixels.set(selection.pixels.subarray(source, source + clip.width), target);
  }
  return { ...clip };
}

export function copySelection(document: BitmapDocument, rect: PixelRect): FloatingSelection | null {
  return copyRegion(document, rect);
}

export function beginSelection(
  document: BitmapDocument,
  history: DocumentHistory,
): SelectionSession {
  let floating: FloatingSelection | null = null;
  let transaction: HistoryTransaction | null = null;
  return {
    get floating() {
      return floating;
    },
    lift(rect) {
      if (floating) throw new Error('Selection is already floating');
      const copied = copyRegion(document, rect);
      if (!copied) return null;
      transaction = history.begin('Move selection', document);
      transaction.capture(copied.sourceBounds);
      for (let row = 0; row < copied.sourceBounds.height; row++) {
        const start = (copied.sourceBounds.y + row) * document.width + copied.sourceBounds.x;
        document.pixels.fill(0, start, start + copied.sourceBounds.width);
      }
      floating = copied;
      document.events.invalidate(copied.sourceBounds);
      return copied;
    },
    paste(selection, to) {
      if (floating) throw new Error('Selection is already floating');
      const bounds = {
        x: Math.floor(to.x),
        y: Math.floor(to.y),
        width: selection.bounds.width,
        height: selection.bounds.height,
      };
      const documentBounds: PixelRect = {
        x: 0,
        y: 0,
        width: document.width,
        height: document.height,
      };
      const clip: PixelRect = { x: 0, y: 0, width: 0, height: 0 };
      if (!intersectRect(bounds, documentBounds, clip)) return null;
      transaction = history.begin('Paste', document);
      floating = { bounds, sourceBounds: { ...bounds }, pixels: selection.pixels.slice() };
      return floating;
    },
    move(to) {
      if (!floating) return null;
      const previous = { ...floating.bounds };
      floating.bounds.x = Math.floor(to.x);
      floating.bounds.y = Math.floor(to.y);
      return unionRect(previous, floating.bounds, { x: 0, y: 0, width: 0, height: 0 });
    },
    commit() {
      if (!floating || !transaction) return false;
      const target = floating;
      const current = transaction;
      floating = null;
      transaction = null;
      const documentBounds: PixelRect = {
        x: 0,
        y: 0,
        width: document.width,
        height: document.height,
      };
      const clip: PixelRect = { x: 0, y: 0, width: 0, height: 0 };
      if (intersectRect(target.bounds, documentBounds, clip)) {
        current.capture(clip);
        const dirty = pasteRegion(document, target)!;
        document.events.invalidate(dirty);
      }
      return current.commit();
    },
    cancel() {
      if (!floating || !transaction) return;
      floating = null;
      const current = transaction;
      transaction = null;
      current.cancel();
    },
    clear() {
      if (!floating || !transaction) return false;
      floating = null;
      const current = transaction;
      transaction = null;
      return current.commit();
    },
  };
}
