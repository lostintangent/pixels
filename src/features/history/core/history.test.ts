import { expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import { createDocumentHistory } from './history';

const RED = packRgba(255, 0, 0);
const BLUE = packRgba(0, 0, 255);

test('one transaction captures a tile once and undo/redo swaps exact pixels', () => {
  const document = createBitmapDocument('test', 70, 2);
  const history = createDocumentHistory();
  const transaction = history.begin('stroke', document);
  transaction.capture({ x: 0, y: 0, width: 1, height: 1 });
  document.pixels[0] = RED;
  transaction.capture({ x: 1, y: 0, width: 1, height: 1 });
  document.pixels[1] = BLUE;
  expect(transaction.commit()).toBe(true);
  expect(history.usedBytes).toBe(64 * 2 * 4);
  expect(history.undo(document)).toEqual({ x: 0, y: 0, width: 2, height: 1 });
  expect(Array.from(document.pixels.subarray(0, 2))).toEqual([0, 0]);
  history.redo(document);
  expect(Array.from(document.pixels.subarray(0, 2))).toEqual([RED, BLUE]);
});

test('cancel restores the whole gesture, including the shared RGBA view', () => {
  const document = createBitmapDocument('test', 4, 4);
  const history = createDocumentHistory();
  const transaction = history.begin('stroke', document);
  transaction.capture({ x: 0, y: 0, width: 4, height: 4 });
  document.pixels.fill(RED);
  transaction.cancel();
  expect(document.pixels.every((pixel) => pixel === 0)).toBe(true);
  expect(document.pixels.buffer).toBe(document.rgbaBytes.buffer);
  expect(history.canUndo).toBe(false);
});

test('full-canvas entries swap buffers on undo and redo', () => {
  const document = createBitmapDocument('test', 4, 4);
  const history = createDocumentHistory();
  const original = document.pixels.buffer;
  const transaction = history.begin('fill', document);
  transaction.capture({ x: 0, y: 0, width: 4, height: 4 });
  document.pixels.fill(BLUE);
  transaction.commit();
  history.undo(document);
  expect(document.pixels.every((pixel) => pixel === 0)).toBe(true);
  expect(document.pixels.buffer).not.toBe(original);
  history.redo(document);
  expect(document.pixels.every((pixel) => pixel === BLUE)).toBe(true);
});
