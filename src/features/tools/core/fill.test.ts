import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createBitmapDocument, packRgba } from '../../document';
import { createDocumentHistory } from '../../history';
import { FillWorkspace, floodFill } from './fill';

const RED = packRgba(255, 0, 0);
const BLUE = packRgba(0, 0, 255);

function grid(document: ReturnType<typeof createBitmapDocument>): string[] {
  const rows: string[] = [];
  for (let y = 0; y < document.height; y++) {
    let row = '';
    for (let x = 0; x < document.width; x++)
      row +=
        document.pixels[y * document.width + x] === BLUE
          ? 'B'
          : document.pixels[y * document.width + x] === RED
            ? 'R'
            : '.';
    rows.push(row);
  }
  return rows;
}

test('uniform fill changes every pixel and undo swaps the full buffer', () => {
  const document = createBitmapDocument('fill', 4, 3);
  const history = createDocumentHistory();
  const result = floodFill(document, { at: { x: 1, y: 1 }, color: BLUE }, history);
  expect(result).toEqual({ dirty: { x: 0, y: 0, width: 4, height: 3 }, changedPixels: 12 });
  expect(grid(document)).toEqual(['BBBB', 'BBBB', 'BBBB']);
  history.undo(document);
  expect(grid(document)).toEqual(['....', '....', '....']);
});

test('contiguous fill traverses a winding one-pixel maze exactly', () => {
  const document = createBitmapDocument('fill', 5, 5);
  document.pixels.set([
    0,
    0,
    RED,
    0,
    0,
    RED,
    0,
    RED,
    0,
    RED,
    0,
    0,
    0,
    0,
    RED,
    0,
    RED,
    RED,
    0,
    0,
    0,
    0,
    0,
    RED,
    0,
  ]);
  const history = createDocumentHistory();
  const result = floodFill(
    document,
    { at: { x: 0, y: 0 }, color: BLUE },
    history,
    new FillWorkspace(),
  );
  expect(result.changedPixels).toBe(17);
  expect(grid(document)).toEqual(['BBRBB', 'RBRBR', 'BBBBR', 'BRRBB', 'BBBRB']);
  history.undo(document);
  expect(grid(document)).toEqual(['..R..', 'R.R.R', '....R', '.RR..', '...R.']);
});

test('same-color and outside fills are no-ops with no history entry', () => {
  const document = createBitmapDocument('fill', 2, 2);
  const history = createDocumentHistory();
  expect(floodFill(document, { at: { x: 0, y: 0 }, color: 0 }, history).changedPixels).toBe(0);
  expect(floodFill(document, { at: { x: 4, y: 0 }, color: BLUE }, history).changedPixels).toBe(0);
  expect(history.canUndo).toBe(false);
});

test('a screenshot-scale window fills exactly and undo restores every byte in one step', () => {
  const width = 3456;
  const height = 2234;
  const document = createBitmapDocument('screenshot', width, height);
  const desktop = packRgba(90, 110, 140, 255);
  const white = packRgba(255, 255, 255, 255);
  const text = packRgba(30, 30, 32, 255);
  const ink = packRgba(220, 40, 40, 255);
  const expected = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let color = desktop;
      if (x > 300 && x < 3150 && y > 200 && y < 2000) {
        color = white;
        if (
          y > 380 &&
          y < 760 &&
          (y - 380) % 38 < 14 &&
          x > 980 &&
          x < 2900 &&
          (x * 7 + y * 3) % 23 < 15
        )
          color = text;
      }
      document.pixels[y * width + x] = color;
      expected[y * width + x] = color;
    }
  }
  const hash = (pixels: Uint32Array) =>
    createHash('sha256')
      .update(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength))
      .digest('hex');
  const originalHash = hash(document.pixels);
  // An independent four-neighbor traversal defines the expected connected
  // region. Text strokes leave white pockets that must not be recolored.
  const seen = new Uint8Array(expected.length);
  const queue = new Uint32Array(expected.length);
  const seed = 1300 * width + 1728;
  seen[seed] = 1;
  queue[0] = seed;
  let head = 0;
  let tail = 1;
  while (head < tail) {
    const index = queue[head++]!;
    const x = index % width;
    const visit = (neighbor: number) => {
      if (seen[neighbor] || expected[neighbor] !== white) return;
      seen[neighbor] = 1;
      queue[tail++] = neighbor;
    };
    if (x > 0) visit(index - 1);
    if (x < width - 1) visit(index + 1);
    if (index >= width) visit(index - width);
    if (index < expected.length - width) visit(index + width);
    expected[index] = ink;
  }
  expect(tail).toBe(4_893_731);
  const expectedHash = hash(expected);
  const history = createDocumentHistory();
  const result = floodFill(
    document,
    { at: { x: 1728, y: 1300 }, color: ink },
    history,
    new FillWorkspace(),
  );
  expect(result.changedPixels).toBe(tail);
  expect(result.dirty).toEqual({ x: 301, y: 201, width: 2849, height: 1799 });
  expect(hash(document.pixels)).toBe(expectedHash);
  expect(history.usedBytes).toBe(document.pixels.byteLength);
  history.undo(document);
  expect(history.canUndo).toBe(false);
  expect(hash(document.pixels)).toBe(originalHash);
  history.redo(document);
  expect(hash(document.pixels)).toBe(expectedHash);
});
