import { expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import { createDocumentHistory } from '../../history';
import { beginLinePreview, LinePreviewWorkspace, snapLineEndpoint } from './line';

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
  expect(snapLineEndpoint({ x: 0, y: 0 }, { x: 8, y: 4 })).toEqual({ x: 8, y: 4 });
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
