import type { BitmapDocument } from '../../document';
import type { DocumentSnapshot, TileCoord } from './contracts';
import { buildThumbnail, extractTile } from './tiles';

/**
 * Copies every byte this snapshot needs out of the live document synchronously, in one task.
 * Strokes and undo can swap `document.pixels` between microtasks, so nothing here may be
 * revisited after an `await`: the caller can safely do async work (thumbnail encode, IndexedDB
 * write) with the returned value alone.
 */
export function snapshotDocument(
  document: BitmapDocument,
  dirtyTiles: Iterable<TileCoord>,
  fullResave: boolean,
): DocumentSnapshot {
  const thumbnailPixels = buildThumbnail(document.pixels, document.width, document.height);
  const base = {
    id: document.id,
    name: document.name,
    width: document.width,
    height: document.height,
    updatedAt: Date.now(),
    fullResave,
    thumbnailPixels,
    colorSpace: document.colorSpace,
  };
  if (fullResave) {
    // One bulk copy, synchronously, before any await — the same buffer-swap safety eager
    // per-tile extraction gave, without splitting every tile (thousands, at a large canvas) out
    // of it up front. `.set()` from a same-length typed array is a single optimized copy, same
    // cost as `.slice()`, but keeps the result a plain `Uint8Array` regardless of the source's
    // class (`BitmapDocument.rgbaBytes` is a `Uint8ClampedArray`).
    const fullResaveBytes = new Uint8Array(document.rgbaBytes.length);
    fullResaveBytes.set(document.rgbaBytes);
    return { ...base, tiles: [], fullResaveBytes };
  }
  const coords = dedupeTiles(dirtyTiles);
  const tiles = coords.map((coord) =>
    extractTile(document.rgbaBytes, document.width, document.height, coord),
  );
  return { ...base, tiles };
}

function dedupeTiles(coords: Iterable<TileCoord>): TileCoord[] {
  const seen = new Map<string, TileCoord>();
  for (const coord of coords) seen.set(`${coord.tx}:${coord.ty}`, coord);
  return [...seen.values()];
}
