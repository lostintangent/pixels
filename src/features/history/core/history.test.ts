import { expect, test } from 'bun:test';
import { createBitmapDocument, packRgba } from '../../document';
import { createDocumentHistory } from './history';
import { annotationHistoryState, annotationsFor, type Annotation } from '../../annotations';

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

const rectangle: Annotation = {
  id: 'rect',
  kind: 'rectangle',
  start: { x: 1, y: 1 },
  end: { x: 3, y: 3 },
  width: 1,
  color: RED,
};

test('a shape-only edit shares undo and redo with pixel edits', () => {
  const document = createBitmapDocument('annotated', 4, 4);
  const annotations = annotationsFor(document);
  const history = createDocumentHistory();
  const shape = history.begin('Add rectangle', document, annotationHistoryState(annotations));
  annotations.commit(rectangle);
  expect(shape.commit()).toBe(true);
  const pixel = history.begin('Paint', document);
  pixel.capture({ x: 0, y: 0, width: 1, height: 1 });
  document.pixels[0] = BLUE;
  pixel.commit();
  history.undo(document);
  expect(document.pixels[0]).toBe(0);
  expect(annotations.shapes).toEqual([rectangle]);
  history.undo(document);
  expect(annotations.shapes).toEqual([]);
  history.redo(document);
  history.redo(document);
  expect(document.pixels[0]).toBe(BLUE);
  expect(annotations.shapes).toEqual([rectangle]);
});

test('one transaction restores pixels and shapes together, and ignores no-op shape changes', () => {
  const document = createBitmapDocument('both', 4, 4);
  const annotations = annotationsFor(document);
  const history = createDocumentHistory();
  const noOp = history.begin('No change', document, annotationHistoryState(annotations));
  expect(noOp.commit()).toBe(false);
  const change = history.begin('Both', document, annotationHistoryState(annotations));
  change.capture({ x: 0, y: 0, width: 1, height: 1 });
  document.pixels[0] = RED;
  annotations.commit(rectangle);
  expect(change.commit()).toBe(true);
  history.undo(document);
  expect(document.pixels[0]).toBe(0);
  expect(annotations.shapes).toEqual([]);
  history.redo(document);
  expect(document.pixels[0]).toBe(RED);
  expect(annotations.shapes).toEqual([rectangle]);
});
