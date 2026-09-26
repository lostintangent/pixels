import { expect, test } from 'bun:test';
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
