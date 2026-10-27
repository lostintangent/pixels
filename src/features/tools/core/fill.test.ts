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

test('fully transparent hidden RGB does not divide an imported icon fill', () => {
  const document = createBitmapDocument('icon', 48, 48);
  const hidden = [packRgba(0, 0, 0, 0), packRgba(255, 0, 0, 0), packRgba(0, 0, 255, 0)];
  const wall = packRgba(20, 30, 40, 255);
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) document.pixels[y * 48 + x] = hidden[(x * 7 + y) % 3]!;
    document.pixels[y * 48 + 10] = wall;
  }
  const before = document.rgbaBytes.slice();
  const history = createDocumentHistory();
  const invisibleChange = floodFill(
    document,
    { at: { x: 0, y: 0 }, color: packRgba(77, 88, 99, 0) },
    history,
  );
  expect(invisibleChange.changedPixels).toBe(0);
  expect(history.canUndo).toBe(false);
  const result = floodFill(document, { at: { x: 0, y: 0 }, color: BLUE }, history);
  expect(result.changedPixels).toBe(10 * 48);
  expect(result.dirty).toEqual({ x: 0, y: 0, width: 10, height: 48 });
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 10; x++) expect(document.pixels[y * 48 + x]).toBe(BLUE);
    expect(document.pixels[y * 48 + 10]).toBe(wall);
    for (let x = 11; x < 48; x++) expect(document.pixels[y * 48 + x]).toBe(hidden[(x * 7 + y) % 3]);
  }
  history.undo(document);
  expect(document.rgbaBytes).toEqual(before);
  expect(history.canUndo).toBe(false);
  history.redo(document);
  expect(document.pixels[0]).toBe(BLUE);
});

test('large transparent fill crosses hidden-RGB variations without crossing visible pixels', () => {
  const width = 1025;
  const height = 1024;
  const document = createBitmapDocument('large-alpha', width, height);
  for (let i = 0; i < document.pixels.length; i++)
    document.pixels[i] = packRgba(i & 255, (i >>> 8) & 255, 0, 0);
  const wall = packRgba(7, 8, 9, 255);
  document.pixels[width * 512 + 512] = wall;
  const before = document.rgbaBytes.slice();
  const history = createDocumentHistory();
  const result = floodFill(document, { at: { x: 0, y: 0 }, color: BLUE }, history);
  expect(result.changedPixels).toBe(width * height - 1);
  expect(document.pixels[width * 512 + 512]).toBe(wall);
  history.undo(document);
  expect(document.rgbaBytes).toEqual(before);
  history.redo(document);
  expect(document.pixels[width * 512 + 511]).toBe(BLUE);
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

for (const whiteBackground of [false, true]) {
  test(`ten small screenshot fills retain all undo steps with ${whiteBackground ? 'above 75%' : 'about 66%'} source color`, () => {
    const width = 3456;
    const height = 2234;
    const document = createBitmapDocument('buttons', width, height);
    const background = packRgba(90, 110, 140, 255);
    const white = packRgba(255, 255, 255, 255);
    const border = packRgba(30, 30, 32, 255);
    const ink = packRgba(220, 40, 40, 255);
    document.pixels.fill(whiteBackground ? white : background);
    if (!whiteBackground) {
      for (let y = 201; y < 2000; y++)
        document.pixels.fill(white, y * width + 301, y * width + 3150);
    }
    const buttons: number[] = [];
    for (let button = 0; button < 10; button++) {
      const x = 500 + button * 200;
      const y = 1000;
      buttons.push(x + 20);
      for (let row = y; row < y + 24; row++) {
        document.pixels.fill(border, row * width + x, row * width + x + 40);
        if (row > y && row < y + 23)
          document.pixels.fill(white, row * width + x + 1, row * width + x + 39);
      }
    }
    const hash = () =>
      createHash('sha256').update(new Uint8Array(document.pixels.buffer)).digest('hex');
    const originalHash = hash();
    const history = createDocumentHistory();
    const workspace = new FillWorkspace();
    for (const x of buttons) {
      const result = floodFill(document, { at: { x, y: 1010 }, color: ink }, history, workspace);
      expect(result.changedPixels).toBe(38 * 22);
    }
    expect(history.usedBytes).toBeLessThan(1024 * 1024);
    const filledHash = hash();
    for (let i = buttons.length - 1; i >= 0; i--) {
      expect(history.canUndo).toBe(true);
      history.undo(document);
      expect(document.pixels[1010 * width + buttons[i]!]).toBe(white);
    }
    expect(history.canUndo).toBe(false);
    expect(hash()).toBe(originalHash);
    for (let i = 0; i < buttons.length; i++) history.redo(document);
    expect(hash()).toBe(filledHash);
  });
}
