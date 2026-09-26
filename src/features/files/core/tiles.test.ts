import { describe, expect, test } from 'bun:test';
import { allTiles, buildThumbnail, extractTile, tileGrid, tilesForRect, writeTile } from './tiles';

describe('tile grid math', () => {
  test('grid size covers partial edge tiles', () => {
    expect(tileGrid(128, 65)).toEqual({ tilesX: 2, tilesY: 2 });
    expect(tileGrid(1, 1)).toEqual({ tilesX: 1, tilesY: 1 });
  });

  test('allTiles enumerates every tile in row-major order', () => {
    expect(allTiles(65, 65)).toEqual([
      { tx: 0, ty: 0 },
      { tx: 1, ty: 0 },
      { tx: 0, ty: 1 },
      { tx: 1, ty: 1 },
    ]);
  });

  test('tilesForRect clips to the tiles a dirty rect actually touches', () => {
    const tiles = tilesForRect({ x: 60, y: 60, width: 10, height: 10 }, 128, 128);
    expect(tiles).toEqual([
      { tx: 0, ty: 0 },
      { tx: 1, ty: 0 },
      { tx: 0, ty: 1 },
      { tx: 1, ty: 1 },
    ]);
  });

  test('tilesForRect never returns tiles outside the document grid', () => {
    const tiles = tilesForRect({ x: 0, y: 0, width: 200, height: 200 }, 65, 65);
    expect(tiles.every((t) => t.tx <= 1 && t.ty <= 1)).toBe(true);
  });
});

describe('tile extraction and restoration', () => {
  test('round-trips a full 64x64 tile', () => {
    const width = 64;
    const height = 64;
    const rgbaBytes = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgbaBytes.length; i++) rgbaBytes[i] = i % 256;

    const tile = extractTile(rgbaBytes, width, height, { tx: 0, ty: 0 });
    expect(tile.pixels.length).toBe(64 * 64 * 4);

    const restored = new Uint8Array(width * height * 4);
    writeTile(restored, width, height, tile);
    expect([...restored]).toEqual([...rgbaBytes]);
  });

  test('an edge tile pads past document bounds with zero, and restoring clips back cleanly', () => {
    const width = 70;
    const height = 70;
    const rgbaBytes = new Uint8Array(width * height * 4).fill(200);

    const edgeTile = extractTile(rgbaBytes, width, height, { tx: 1, ty: 1 });
    // The tile covers x/y 64..127, but only 64..69 (6 columns/rows) are live.
    expect(edgeTile.pixels[0]).toBe(200); // (64,64) is live
    expect(edgeTile.pixels[6 * 4]).toBe(0); // (70,64) is past the live width, padded

    const restored = new Uint8Array(width * height * 4);
    writeTile(restored, width, height, edgeTile);
    // Only the live 6x6 corner should have been written; nothing past it.
    expect(restored[(64 * width + 64) * 4]).toBe(200);
    expect(restored[(69 * width + 69) * 4]).toBe(200);
  });

  test('a tile fully outside the document is a no-op on restore', () => {
    const restored = new Uint8Array(10 * 10 * 4);
    writeTile(restored, 10, 10, { tx: 5, ty: 5, pixels: new Uint8Array(64 * 64 * 4).fill(9) });
    expect(restored.every((b) => b === 0)).toBe(true);
  });
});

describe('thumbnail generation', () => {
  test('downscales to fit within maxSide, averaging blocks', () => {
    // A 4x4 image, top-left quadrant red, rest black, downscaled to 2x2.
    const pixels = new Uint32Array(16);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        pixels[y * 4 + x] = x < 2 && y < 2 ? 0xff0000ff : 0xff000000; // ABGR: alpha 255, R in low byte
      }
    }
    const thumb = buildThumbnail(pixels, 4, 4, 2);
    expect(thumb.width).toBe(2);
    expect(thumb.height).toBe(2);
    const bytes = new Uint8Array(thumb.pixels.buffer);
    expect(bytes[0]).toBe(255); // top-left quadrant averages to pure red
    expect(bytes[(1 * 2 + 1) * 4]).toBe(0); // bottom-right quadrant averages to black
  });

  test('never upscales a document already within maxSide', () => {
    const pixels = new Uint32Array(4).fill(0xff112233);
    const thumb = buildThumbnail(pixels, 2, 2, 64);
    expect(thumb.width).toBe(2);
    expect(thumb.height).toBe(2);
  });
});
