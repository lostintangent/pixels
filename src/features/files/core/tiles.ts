import { TILE_SIZE, type TileCoord, type TileSnapshot } from './contracts';

export { TILE_SIZE };

/** Document pixel bytes come in as either class: `BitmapDocument.rgbaBytes` is a `Uint8ClampedArray`
 *  view, while bytes decoded from storage or PNG are plain `Uint8Array`. Both index and `.set()`
 *  identically, so tile copying works the same either way. */
export type RgbaBytes = Uint8Array | Uint8ClampedArray;

export function tileGrid(width: number, height: number): { tilesX: number; tilesY: number } {
  return {
    tilesX: Math.ceil(width / TILE_SIZE),
    tilesY: Math.ceil(height / TILE_SIZE),
  };
}

export function allTiles(width: number, height: number): TileCoord[] {
  const { tilesX, tilesY } = tileGrid(width, height);
  const out: TileCoord[] = [];
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) out.push({ tx, ty });
  }
  return out;
}

/** Clips a dirty document rect to the tile coordinates it touches. */
export function tilesForRect(
  rect: { x: number; y: number; width: number; height: number },
  documentWidth: number,
  documentHeight: number,
): TileCoord[] {
  const left = Math.max(0, Math.floor(rect.x / TILE_SIZE));
  const top = Math.max(0, Math.floor(rect.y / TILE_SIZE));
  const right = Math.min(
    Math.ceil(documentWidth / TILE_SIZE) - 1,
    Math.floor((rect.x + rect.width - 1) / TILE_SIZE),
  );
  const bottom = Math.min(
    Math.ceil(documentHeight / TILE_SIZE) - 1,
    Math.floor((rect.y + rect.height - 1) / TILE_SIZE),
  );
  const out: TileCoord[] = [];
  for (let ty = top; ty <= bottom; ty++) {
    for (let tx = left; tx <= right; tx++) out.push({ tx, ty });
  }
  return out;
}

/** Copies one tile out of document RGBA bytes into a fresh, always-full-size buffer. Edge tiles pad with zero. */
export function extractTile(
  rgbaBytes: RgbaBytes,
  documentWidth: number,
  documentHeight: number,
  coord: TileCoord,
): TileSnapshot {
  const pixels = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  const originX = coord.tx * TILE_SIZE;
  const originY = coord.ty * TILE_SIZE;
  const copyWidth = Math.min(TILE_SIZE, documentWidth - originX);
  const copyHeight = Math.min(TILE_SIZE, documentHeight - originY);
  for (let row = 0; row < copyHeight; row++) {
    const sourceOffset = ((originY + row) * documentWidth + originX) * 4;
    const targetOffset = row * TILE_SIZE * 4;
    pixels.set(rgbaBytes.subarray(sourceOffset, sourceOffset + copyWidth * 4), targetOffset);
  }
  return { tx: coord.tx, ty: coord.ty, pixels };
}

/** Splits a whole-buffer copy into tiles one at a time, instead of all at once: a full resave's
 *  snapshot captures one synchronous copy of the live buffer (cheap, a single bulk copy) and
 *  hands it here, so the actual per-tile splitting work — the part that scales with tile count —
 *  happens lazily, interleaved with whatever paced loop is persisting each tile, rather than as
 *  one unbroken task before the first write. */
export function* extractAllTiles(
  rgbaBytes: RgbaBytes,
  width: number,
  height: number,
): Generator<TileSnapshot> {
  for (const coord of allTiles(width, height)) yield extractTile(rgbaBytes, width, height, coord);
}

/** Inverse of extractTile: writes a tile's live bytes back into document RGBA bytes, clipped to bounds. */
export function writeTile(
  rgbaBytes: RgbaBytes,
  documentWidth: number,
  documentHeight: number,
  tile: TileSnapshot,
): void {
  const originX = tile.tx * TILE_SIZE;
  const originY = tile.ty * TILE_SIZE;
  if (originX >= documentWidth || originY >= documentHeight) return;
  const copyWidth = Math.min(TILE_SIZE, documentWidth - originX);
  const copyHeight = Math.min(TILE_SIZE, documentHeight - originY);
  for (let row = 0; row < copyHeight; row++) {
    const sourceOffset = row * TILE_SIZE * 4;
    const targetOffset = ((originY + row) * documentWidth + originX) * 4;
    rgbaBytes.set(tile.pixels.subarray(sourceOffset, sourceOffset + copyWidth * 4), targetOffset);
  }
}

/** Caps each output pixel's box average to at most this many source samples per axis
 *  (so at most its square in total), independent of how large the source block is. */
const THUMBNAIL_SAMPLES_PER_AXIS = 4;

/** Box-average downscale to fit within maxSide on the long edge. Pure math, no canvas. */
export function buildThumbnail(
  pixels: Uint32Array,
  width: number,
  height: number,
  maxSide = 64,
): { width: number; height: number; pixels: Uint32Array } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  if (outWidth === width && outHeight === height) {
    return { width, height, pixels: pixels.slice() };
  }
  const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length * 4);
  const out = new Uint32Array(outWidth * outHeight);
  const outBytes = new Uint8Array(out.buffer);
  for (let oy = 0; oy < outHeight; oy++) {
    const sy0 = Math.floor((oy * height) / outHeight);
    const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) * height) / outHeight));
    // Capping samples per axis (rather than visiting every source pixel in the block) bounds a
    // thumbnail's cost to a small constant independent of the document's size: a 64 px preview
    // doesn't need millions of reads to look right, and that cap is what keeps opening or
    // autosaving a large document from becoming a long main-thread task.
    const strideY = Math.max(1, Math.floor((sy1 - sy0) / THUMBNAIL_SAMPLES_PER_AXIS));
    for (let ox = 0; ox < outWidth; ox++) {
      const sx0 = Math.floor((ox * width) / outWidth);
      const sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) * width) / outWidth));
      const strideX = Math.max(1, Math.floor((sx1 - sx0) / THUMBNAIL_SAMPLES_PER_AXIS));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1; sy += strideY) {
        for (let sx = sx0; sx < sx1; sx += strideX) {
          const offset = (sy * width + sx) * 4;
          r += bytes[offset]!;
          g += bytes[offset + 1]!;
          b += bytes[offset + 2]!;
          a += bytes[offset + 3]!;
          count++;
        }
      }
      const outOffset = (oy * outWidth + ox) * 4;
      outBytes[outOffset] = Math.round(r / count);
      outBytes[outOffset + 1] = Math.round(g / count);
      outBytes[outOffset + 2] = Math.round(b / count);
      outBytes[outOffset + 3] = Math.round(a / count);
    }
  }
  return { width: outWidth, height: outHeight, pixels: out };
}
