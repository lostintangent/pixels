import type { BitmapDocument } from '../../document';
import type { DocumentSnapshot, TileCoord } from './contracts';
import { allTiles, buildThumbnail, extractTile } from './tiles';

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
  const coords = fullResave ? allTiles(document.width, document.height) : dedupeTiles(dirtyTiles);
  const tiles = coords.map((coord) =>
    extractTile(document.rgbaBytes, document.width, document.height, coord),
  );
  const thumbnailPixels = buildThumbnail(document.pixels, document.width, document.height);
  return {
    id: document.id,
    name: document.name,
    width: document.width,
    height: document.height,
    updatedAt: Date.now(),
    tiles,
    fullResave,
    thumbnailPixels,
    colorSpace: document.colorSpace,
  };
}

function dedupeTiles(coords: Iterable<TileCoord>): TileCoord[] {
  const seen = new Map<string, TileCoord>();
  for (const coord of coords) seen.set(`${coord.tx}:${coord.ty}`, coord);
  return [...seen.values()];
}
