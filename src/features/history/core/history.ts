import type { BitmapDocument, PixelRect } from '../../document';
import { intersectRect, unionRect } from '../../document';
import type { DocumentHistory, HistoryTransaction } from './contracts';

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
  document.events.invalidate(entry.bounds);
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
    begin(label, document): HistoryTransaction {
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
      let closed = false;
      const close = () => {
        if (closed) throw new Error('History transaction is closed');
        closed = true;
        active = false;
      };
      const entry = (): Entry => ({
        label,
        bounds: bounds!,
        tiles: [...tiles.values()],
        full,
        bytes: full
          ? full.byteLength
          : [...tiles.values()].reduce((n, tile) => n + tile.saved.byteLength, 0),
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
        commit() {
          close();
          if (!bounds) return false;
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
          if (bounds) swapEntry(document, entry());
        },
      };
    },
    undo(document) {
      if (active) throw new Error('Cannot undo during a history transaction');
      const item = past.pop();
      if (!item) return null;
      swapEntry(document, item);
      future.push(item);
      return item.bounds;
    },
    redo(document) {
      if (active) throw new Error('Cannot redo during a history transaction');
      const item = future.pop();
      if (!item) return null;
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
