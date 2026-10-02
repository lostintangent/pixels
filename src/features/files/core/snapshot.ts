import { findAnnotationsFor } from '../../annotations/model';
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
  // `buildThumbnail` stays pure math (no canvas, no `await`) so it's safe to call synchronously
  // here, before the buffer-swap-safety window above closes — it never composites `shapes` in.
  // Callers that want markup visible in the thumbnail scale `shapes` by `thumbnailPixels.scale`
  // (`scaleAnnotationsForThumbnail`) and pass that into the PNG Worker's encode alongside these
  // raw pixels, the same way a full export's shapes are flattened in the Worker, not here.
  const thumbnailPixels = buildThumbnail(document.pixels, document.width, document.height);
  // A read-only lookup: never creates a set (and never pulls in its mutable implementation) for a
  // document no gesture has touched this session. `.snapshot()` returns already-detached copies,
  // so this is just as safe across an `await` as the pixel copies below.
  const shapes = findAnnotationsFor(document)?.snapshot() ?? [];
  const base = {
    id: document.id,
    name: document.name,
    width: document.width,
    height: document.height,
    updatedAt: Date.now(),
    fullResave,
    shapes,
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
