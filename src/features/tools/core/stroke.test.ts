import { expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import { createDocumentHistory } from '../../history';
import { beginStroke } from './stroke';

const INK = packRgba(28, 76, 180);

function rows(pixels: Uint32Array, width: number): string[] {
  const output: string[] = [];
  for (let y = 0; y < pixels.length / width; y++) {
    let row = '';
    for (let x = 0; x < width; x++) row += pixels[y * width + x] ? '#' : '.';
    output.push(row);
  }
  return output;
}

test('1px stroke follows exact Bresenham pixels and undoes as one gesture', () => {
  const document = createBitmapDocument('stroke', 5, 5);
  const history = createDocumentHistory();
  const stroke = beginStroke(document, { color: INK, size: 1, pixelPerfect: false }, history);
  stroke.extend({ x: 0, y: 0 });
  stroke.extend({ x: 4, y: 2 });
  expect(stroke.end()).toBe(true);
  expect(rows(document.pixels, 5)).toEqual(['#....', '.##..', '...##', '.....', '.....']);
  history.undo(document);
  expect(rows(document.pixels, 5)).toEqual(['.....', '.....', '.....', '.....', '.....']);
  history.redo(document);
  expect(rows(document.pixels, 5)).toEqual(['#....', '.##..', '...##', '.....', '.....']);
});

test('pixel-perfect mode removes the middle corner pixel and preserves its old color', () => {
  const document = createBitmapDocument('stroke', 3, 3);
  const OLD = packRgba(255, 0, 0);
  document.pixels[1] = OLD;
  const history = createDocumentHistory();
  const stroke = beginStroke(document, { color: INK, size: 1, pixelPerfect: true }, history);
  stroke.extend({ x: 0, y: 0 });
  stroke.extend({ x: 1, y: 0 });
  stroke.extend({ x: 1, y: 1 });
  stroke.end();
  expect(Array.from(document.pixels.slice(0, 5))).toEqual([INK, OLD, 0, 0, INK]);
});

test('cancel restores a partial gesture when touch becomes pinch', () => {
  const document = createBitmapDocument('stroke', 5, 5);
  const history = createDocumentHistory();
  const stroke = beginStroke(document, { color: INK, size: 2, pixelPerfect: false }, history);
  stroke.extend({ x: 2, y: 2 });
  stroke.extend({ x: 4, y: 4 });
  stroke.cancel();
  expect(document.pixels.every((pixel) => pixel === 0)).toBe(true);
  expect(history.canUndo).toBe(false);
});

test('square brush has exact even-size footprint at the canvas edge', () => {
  const document = createBitmapDocument('stroke', 4, 4);
  const history = createDocumentHistory();
  const stroke = beginStroke(document, { color: INK, size: 2, pixelPerfect: false }, history);
  stroke.extend({ x: 0, y: 0 });
  stroke.end();
  expect(rows(document.pixels, 4)).toEqual(['##..', '##..', '....', '....']);
});
