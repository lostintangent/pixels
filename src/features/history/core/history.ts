import type { BitmapDocument, PixelRect } from '../../document';
import { intersectRect, unionRect } from '../../document';
import type { DocumentHistory, HistoryExternalState, HistoryTransaction } from './contracts';

const TILE_SIZE = 64;
const DEFAULT_BUDGET = 256 * 1024 * 1024;

interface TileSnapshot {
  x: number;
  y: number;
  width: number;
  height: number;
  saved: Uint32Array;
}
interface Entry {
  label: string;
  bounds: PixelRect;
  tiles: TileSnapshot[];
  full: Uint32Array | null;
  external: { adapter: HistoryExternalState; snapshot: unknown } | null;
  replacement: BitmapDocument | null;
  bytes: number;
}

function swapEntry(document: BitmapDocument, entry: Entry): void {
  if (entry.full) {
    const previous = document.pixels;
    document.pixels = entry.full;
    document.rgbaBytes = new Uint8ClampedArray(entry.full.buffer);
    entry.full = previous;
  } else {
    const pixels = document.pixels;
    const documentWidth = document.width;
    for (const tile of entry.tiles) {
      let savedIndex = 0;
      for (let y = 0; y < tile.height; y++) {
        let index = (tile.y + y) * documentWidth + tile.x;
        const end = index + tile.width;
        while (index < end) {
          const value = pixels[index]!;
          pixels[index] = tile.saved[savedIndex]!;
          tile.saved[savedIndex++] = value;
          index++;
        }
      }
    }
  }
  if (entry.external) {
    const current = entry.external.adapter.snapshot();
    entry.external.adapter.restore(entry.external.snapshot);
    entry.external.snapshot = current;
  }
  if (entry.bounds.width && entry.bounds.height) document.events.invalidate(entry.bounds);
}

export function createDocumentHistory(maxBytes = DEFAULT_BUDGET): DocumentHistory {
  if (maxBytes <= 0) throw new RangeError('History budget must be positive');
  const past: Entry[] = [];
  const future: Entry[] = [];
  let usedBytes = 0;
  let active = false;
  return {
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    get usedBytes() {
      return usedBytes;
    },
    get maxBytes() {
      return maxBytes;
    },
    begin(label, document, external): HistoryTransaction {
      if (active) throw new Error('A history transaction is already active');
      active = true;
      const tiles = new Map<number, TileSnapshot>();
      const tileColumns = Math.ceil(document.width / TILE_SIZE);
      const clip: PixelRect = { x: 0, y: 0, width: 0, height: 0 };
      const documentBounds: PixelRect = {
        x: 0,
        y: 0,
        width: document.width,
        height: document.height,
      };
      let bounds: PixelRect | null = null;
      let full: Uint32Array | null = null;
      let extra = external ? { adapter: external, snapshot: external.snapshot() } : null;
      let closed = false;
      const close = () => {
        if (closed) throw new Error('History transaction is closed');
        closed = true;
        active = false;
      };
      const entry = (): Entry => ({
        label,
        bounds: bounds ?? { x: 0, y: 0, width: 0, height: 0 },
        tiles: [...tiles.values()],
        full,
        external: extra,
        replacement: null,
        bytes:
          (full
            ? full.byteLength
            : [...tiles.values()].reduce((n, tile) => n + tile.saved.byteLength, 0)) +
          (extra?.adapter.byteSize(extra.snapshot) ?? 0),
      });
      return {
        capture(rect) {
          if (closed) throw new Error('History transaction is closed');
          if (!intersectRect(rect, documentBounds, clip)) return;
          if (!bounds) bounds = { ...clip };
          else unionRect(bounds, clip, bounds);
          if (full) return;
          if (
            clip.x === 0 &&
            clip.y === 0 &&
            clip.width === document.width &&
            clip.height === document.height &&
            tiles.size === 0
          ) {
            full = document.pixels.slice();
            return;
          }
          const left = Math.floor(clip.x / TILE_SIZE);
          const top = Math.floor(clip.y / TILE_SIZE);
          const right = Math.floor((clip.x + clip.width - 1) / TILE_SIZE);
          const bottom = Math.floor((clip.y + clip.height - 1) / TILE_SIZE);
          for (let ty = top; ty <= bottom; ty++) {
            for (let tx = left; tx <= right; tx++) {
              const key = ty * tileColumns + tx;
              if (tiles.has(key)) continue;
              const x = tx * TILE_SIZE;
              const y = ty * TILE_SIZE;
              const width = Math.min(TILE_SIZE, document.width - x);
              const height = Math.min(TILE_SIZE, document.height - y);
              const saved = new Uint32Array(width * height);
              for (let row = 0; row < height; row++) {
                const source = (y + row) * document.width + x;
                saved.set(document.pixels.subarray(source, source + width), row * width);
              }
              tiles.set(key, { x, y, width, height, saved });
            }
          }
        },
        narrowFullCapture(changedTiles, dirty) {
          if (closed) throw new Error('History transaction is closed');
          if (!full) return;
          const tileRows = Math.ceil(document.height / TILE_SIZE);
          if (changedTiles.length < tileColumns * tileRows)
            throw new RangeError('Changed tile mask does not cover the document');
          let touchedBytes = 0;
          for (let ty = 0; ty < tileRows; ty++) {
            for (let tx = 0; tx < tileColumns; tx++) {
              if (!changedTiles[ty * tileColumns + tx]) continue;
              touchedBytes +=
                Math.min(TILE_SIZE, document.width - tx * TILE_SIZE) *
                Math.min(TILE_SIZE, document.height - ty * TILE_SIZE) *
                Uint32Array.BYTES_PER_ELEMENT;
            }
          }
          // Keep the O(1) buffer swap for a broad edit. Sparse edits only
          // retain tiles copied from the pre-edit full snapshot.
          if (touchedBytes >= full.byteLength / 2) return;
          for (let ty = 0; ty < tileRows; ty++) {
            for (let tx = 0; tx < tileColumns; tx++) {
              const key = ty * tileColumns + tx;
              if (!changedTiles[key]) continue;
              const x = tx * TILE_SIZE;
              const y = ty * TILE_SIZE;
              const width = Math.min(TILE_SIZE, document.width - x);
              const height = Math.min(TILE_SIZE, document.height - y);
              const saved = new Uint32Array(width * height);
              for (let row = 0; row < height; row++) {
                const source = (y + row) * document.width + x;
                saved.set(full.subarray(source, source + width), row * width);
              }
              tiles.set(key, { x, y, width, height, saved });
            }
          }
          full = null;
          bounds = { ...dirty };
        },
        commit() {
          close();
          if (extra && extra.adapter.equals(extra.snapshot, extra.adapter.snapshot())) extra = null;
          if (!bounds && !extra) return false;
          const committed = entry();
          for (const redo of future) usedBytes -= redo.bytes;
          future.length = 0;
          past.push(committed);
          usedBytes += committed.bytes;
          while (past.length > 1 && usedBytes > maxBytes) usedBytes -= past.shift()!.bytes;
          return true;
        },
        cancel() {
          close();
          if (
            bounds ||
            (extra && !extra.adapter.equals(extra.snapshot, extra.adapter.snapshot()))
          ) {
            swapEntry(document, entry());
          }
        },
      };
    },
    pushReplacement(label, before, after) {
      if (active) throw new Error('Cannot replace a document during a history transaction');
      if (before === after) return;
      for (const redo of future) usedBytes -= redo.bytes;
      future.length = 0;
      const bytes = Math.max(before.pixels.byteLength, after.pixels.byteLength);
      past.push({
        label,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        tiles: [],
        full: null,
        external: null,
        replacement: before,
        bytes,
      });
      usedBytes += bytes;
      while (past.length > 1 && usedBytes > maxBytes) usedBytes -= past.shift()!.bytes;
    },
    undo(document) {
      if (active) throw new Error('Cannot undo during a history transaction');
      const item = past.pop();
      if (!item) return null;
      if (item.replacement) {
        const next = item.replacement;
        item.replacement = document;
        future.push(item);
        return { document: next };
      }
      swapEntry(document, item);
      future.push(item);
      return item.bounds;
    },
    redo(document) {
      if (active) throw new Error('Cannot redo during a history transaction');
      const item = future.pop();
      if (!item) return null;
      if (item.replacement) {
        const next = item.replacement;
        item.replacement = document;
        past.push(item);
        return { document: next };
      }
      swapEntry(document, item);
      past.push(item);
      return item.bounds;
    },
    clear() {
      past.length = 0;
      future.length = 0;
      usedBytes = 0;
    },
  };
}
