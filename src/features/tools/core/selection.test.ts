import { expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import { createDocumentHistory } from '../../history';
import { beginSelection, copySelection, pasteSelection } from './selection';

const A = packRgba(255, 0, 0);
const B = packRgba(0, 0, 255);

test('lift, move, and commit is one history step with exact destination pixels', () => {
  const document = createBitmapDocument('selection', 4, 3);
  document.pixels.set([A, B, 0, 0, A, B, 0, 0, 0, 0, 0, 0]);
  const history = createDocumentHistory();
  const selection = beginSelection(document, history);
  const floating = selection.lift({ x: 0, y: 0, width: 2, height: 2 });
  expect(Array.from(floating!.pixels)).toEqual([A, B, A, B]);
  expect(Array.from(document.pixels.slice(0, 6))).toEqual([0, 0, 0, 0, 0, 0]);
  expect(selection.move({ x: 2, y: 1 })).toEqual({ x: 0, y: 0, width: 4, height: 3 });
  expect(selection.commit()).toBe(true);
  expect(Array.from(document.pixels)).toEqual([0, 0, 0, 0, 0, 0, A, B, 0, 0, A, B]);
  history.undo(document);
  expect(Array.from(document.pixels)).toEqual([A, B, 0, 0, A, B, 0, 0, 0, 0, 0, 0]);
  history.redo(document);
  expect(Array.from(document.pixels)).toEqual([0, 0, 0, 0, 0, 0, A, B, 0, 0, A, B]);
});

test('cancel restores lifted pixels; clear deletes as one undoable step', () => {
  const document = createBitmapDocument('selection', 2, 1);
  document.pixels[0] = A;
  const history = createDocumentHistory();
  const selection = beginSelection(document, history);
  selection.lift({ x: 0, y: 0, width: 1, height: 1 });
  selection.cancel();
  expect(document.pixels[0]).toBe(A);
  expect(history.canUndo).toBe(false);
  selection.lift({ x: 0, y: 0, width: 1, height: 1 });
  expect(selection.clear()).toBe(true);
  expect(document.pixels[0]).toBe(0);
  history.undo(document);
  expect(document.pixels[0]).toBe(A);
});

test('copy and paste use the same compact buffer and clip at document edges', () => {
  const document = createBitmapDocument('selection', 3, 2);
  document.pixels.set([A, B, 0, 0, 0, 0]);
  const copied = copySelection(document, { x: 0, y: 0, width: 2, height: 1 })!;
  const history = createDocumentHistory();
  expect(pasteSelection(document, copied, { x: 2, y: 1 }, history)).toBe(true);
  expect(Array.from(document.pixels)).toEqual([A, B, 0, 0, 0, A]);
  history.undo(document);
  expect(Array.from(document.pixels)).toEqual([A, B, 0, 0, 0, 0]);
});
