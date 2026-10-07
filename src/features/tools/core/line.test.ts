import { expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import { createDocumentHistory } from '../../history';
import { beginLinePreview, LinePreviewWorkspace, snapLineEndpoint } from './line';
import { rasterLine } from './raster';

const INK = packRgba(0, 180, 120);

test('line preview stays outside the document and commits exact pixels once', () => {
  const document = createBitmapDocument('line', 4, 4);
  const history = createDocumentHistory();
  const line = beginLinePreview(
    document,
    { x: 0, y: 0 },
    { color: INK, size: 1, pixelPerfect: false },
    history,
  );
  expect(line.update({ x: 3, y: 3 })).toEqual({ x: 0, y: 0, width: 4, height: 4 });
  expect(document.pixels.every((pixel) => pixel === 0)).toBe(true);
  expect(Array.from(line.overlay.subarray(0, 16))).toEqual([
    INK,
    0,
    0,
    0,
    0,
    INK,
    0,
    0,
    0,
    0,
    INK,
    0,
    0,
    0,
    0,
    INK,
  ]);
  expect(line.commit()).toBe(true);
  expect(Array.from(document.pixels)).toEqual(
    Array.from(line.overlay.subarray(0, 16)).map((_, i) => (i % 5 === 0 ? INK : 0)),
  );
  history.undo(document);
  expect(document.pixels.every((pixel) => pixel === 0)).toBe(true);
});

test('changing preview clears its old pixels; cancel leaves document untouched', () => {
  const document = createBitmapDocument('line', 3, 3);
  const line = beginLinePreview(
    document,
    { x: 0, y: 0 },
    { color: INK, size: 1, pixelPerfect: false },
    createDocumentHistory(),
  );
  line.update({ x: 2, y: 0 });
  expect(line.update({ x: 0, y: 2 })).toEqual({ x: 0, y: 0, width: 3, height: 3 });
  expect(line.bounds).toEqual({ x: 0, y: 0, width: 1, height: 3 });
  expect(Array.from(line.overlay.subarray(0, 3))).toEqual([INK, INK, INK]);
  line.cancel();
  expect(line.overlay.every((pixel) => pixel === 0)).toBe(true);
  expect(document.pixels.every((pixel) => pixel === 0)).toBe(true);
});

test('snap covers horizontal, diagonal, and two-to-one pixel slopes', () => {
  expect(snapLineEndpoint({ x: 0, y: 0 }, { x: 8, y: 1 })).toEqual({ x: 8, y: 0 });
  expect(snapLineEndpoint({ x: 0, y: 0 }, { x: 7, y: 6 })).toEqual({ x: 7, y: 7 });
  expect(snapLineEndpoint({ x: 0, y: 0 }, { x: 8, y: 4 })).toEqual({ x: 9, y: 4 });
  expect(snapLineEndpoint({ x: 0, y: 0 }, { x: 4, y: 8 })).toEqual({ x: 4, y: 9 });
  expect(snapLineEndpoint({ x: 0, y: 0 }, { x: 12, y: 6 })).toEqual({ x: 13, y: 6 });
  expect(snapLineEndpoint({ x: 0, y: 0 }, { x: 10, y: 4 })).toEqual({ x: 9, y: 4 });
  expect(snapLineEndpoint({ x: 0, y: 0 }, { x: 10, y: 5 })).toEqual({ x: 11, y: 5 });
});

test('snapped two-to-one lines use uniform runs and paint the same pixels in reverse', () => {
  const endpoints: [number, number][] = [
    [13, 6],
    [13, -6],
    [6, 13],
    [-6, 13],
  ];
  for (const [endX, endY] of endpoints) {
    const forward: [number, number][] = [];
    const reverse: [number, number][] = [];
    rasterLine(0, 0, endX, endY, (x, y) => forward.push([x, y]));
    rasterLine(endX, endY, 0, 0, (x, y) => reverse.push([x, y]));
    expect(forward.length).toBe(14);
    expect(reverse.map(([x, y]) => `${x},${y}`).sort()).toEqual(
      forward.map(([x, y]) => `${x},${y}`).sort(),
    );
    const counts = new Map<number, number>();
    for (const [x, y] of forward) {
      const shortAxis = Math.abs(endX) > Math.abs(endY) ? y : x;
      counts.set(shortAxis, (counts.get(shortAxis) ?? 0) + 1);
    }
    expect([...counts.values()]).toEqual([2, 2, 2, 2, 2, 2, 2]);
  }
});

test('Shift line preview commits the same exact pixels from either end', () => {
  function commitLine(from: { x: number; y: number }, to: { x: number; y: number }) {
    const document = createBitmapDocument('snapped', 16, 8);
    const preview = beginLinePreview(
      document,
      from,
      { color: INK, size: 1, pixelPerfect: false },
      createDocumentHistory(),
    );
    preview.update(to, true);
    expect(preview.commit()).toBe(true);
    return Array.from(document.pixels);
  }

  const forward = commitLine({ x: 0, y: 0 }, { x: 12, y: 6 });
  const reverse = commitLine({ x: 13, y: 6 }, { x: 0, y: 0 });
  expect(reverse).toEqual(forward);
  for (let x = 0; x <= 13; x++) {
    expect(forward[Math.floor(x / 2) * 16 + x]).toBe(INK);
  }
  expect(forward.filter((pixel) => pixel === INK)).toHaveLength(14);
});

test('short line on a large canvas keeps a compact reusable preview', () => {
  const document = createBitmapDocument('large', 4096, 4096);
  const history = createDocumentHistory();
  const workspace = new LinePreviewWorkspace();
  const first = beginLinePreview(
    document,
    { x: 100, y: 200 },
    { color: INK, size: 1, pixelPerfect: false },
    history,
    workspace,
  );
  first.update({ x: 110, y: 200 });
  expect(first.bounds).toEqual({ x: 100, y: 200, width: 11, height: 1 });
  expect(first.overlay.byteLength).toBeLessThan(4096);
  first.cancel();
  const buffer = workspace.pixels.buffer;
  const second = beginLinePreview(
    document,
    { x: 300, y: 400 },
    { color: INK, size: 1, pixelPerfect: false },
    history,
    workspace,
  );
  second.update({ x: 305, y: 400 });
  expect(second.overlay.buffer).toBe(buffer);
  expect(second.bounds).toEqual({ x: 300, y: 400, width: 6, height: 1 });
});
