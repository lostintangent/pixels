import { expect, test } from 'bun:test';
import { packRgba } from '../../document';
import type { Annotation } from './contracts';
import { arrowGeom, handlesOf, hitShape, resizeRect, snap45, square, targetsOf } from './geometry';
import { annotationsFor, createAnnotationSet, isValidAnnotation } from './set';
import { createBitmapDocument } from '../../document';
import { createDocumentHistory } from '../../history';
import {
  beginAnnotationEdit,
  deleteAnnotation,
  duplicateAnnotation,
  resizeAnnotatedDocument,
} from './commands';

const rectangle: Annotation = {
  id: 'rect',
  kind: 'rectangle',
  start: { x: 10, y: 10 },
  end: { x: 30, y: 30 },
  width: 2,
  color: packRgba(200, 50, 20),
};

test('rectangles hit their stroke until selected, then their body', () => {
  expect(hitShape(rectangle, { x: 20, y: 10 }, 0)).toBe(true);
  expect(hitShape(rectangle, { x: 20, y: 20 }, 0)).toBe(false);
  expect(hitShape(rectangle, { x: 20, y: 20 }, 0, true)).toBe(true);
  expect(hitShape(rectangle, { x: 20, y: 7 }, 2)).toBe(true);
  expect(hitShape(rectangle, { x: 20, y: 6 }, 2)).toBe(false);
});

test('arrow head scales with width, and shaft and head both hit', () => {
  const thin: Annotation = {
    ...rectangle,
    id: 'arrow',
    kind: 'arrow',
    start: { x: 0, y: 0 },
    end: { x: 100, y: 0 },
    width: 1,
  };
  const thick: Annotation = { ...thin, width: 6 };
  expect(arrowGeom(thin).head).toBeCloseTo(4.7);
  expect(arrowGeom(thick).head).toBeCloseTo(28.2);
  expect(hitShape(thin, { x: 25, y: 0 }, 0)).toBe(true);
  expect(hitShape(thick, { x: 90, y: 9 }, 0)).toBe(true);
  expect(hitShape(thin, { x: 25, y: 5 }, 0)).toBe(false);
});

test('handles hide on short sides and touch targets leave a 24 px body', () => {
  expect(handlesOf(rectangle, 1, false).map((handle) => handle.id)).toEqual([
    'nw',
    'ne',
    'se',
    'sw',
  ]);
  expect(handlesOf(rectangle, 5, true).map((handle) => handle.id)).toEqual([
    'nw',
    'ne',
    'se',
    'sw',
    'n',
    's',
    'e',
    'w',
  ]);
  const targets = targetsOf(
    { ...rectangle, start: { x: 0, y: 0 }, end: { x: 20, y: 20 } },
    1,
    true,
  );
  expect(targets.find((handle) => handle.id === 'nw')).toEqual({ id: 'nw', x: -24, y: -24 });
  expect(targets.find((handle) => handle.id === 'se')).toEqual({ id: 'se', x: 44, y: 44 });
  const arrow = {
    ...rectangle,
    kind: 'arrow' as const,
    start: { x: 0, y: 0 },
    end: { x: 20, y: 0 },
  };
  expect(targetsOf(arrow, 1, true)).toEqual([
    { id: 'start', x: -24, y: 0 },
    { id: 'end', x: 44, y: 0 },
  ]);
});

test('corner resize and drawing constraints keep exact endpoints', () => {
  expect(square({ x: 10, y: 10 }, { x: 25, y: 15 })).toEqual({ x: 25, y: 25 });
  expect(snap45({ x: 0, y: 0 }, { x: 10, y: 6 })).toEqual({ x: 8, y: 8 });
  const resized = resizeRect(rectangle, 'se', { x: 40, y: 25 }, true);
  expect(resized.start).toEqual({ x: 10, y: 10 });
  expect(resized.end).toEqual({ x: 40, y: 40 });
  expect(resizeRect(rectangle, 'w', { x: 5, y: 18 }, false).start).toEqual({ x: 5, y: 10 });
});

test('one set owns committed shapes, preview changes, and topmost hits', () => {
  const document = createBitmapDocument('annotations', 64, 64);
  const set = annotationsFor(document);
  expect(annotationsFor(document)).toBe(set);
  expect(annotationsFor(createBitmapDocument('other', 64, 64))).not.toBe(set);
  const changes: string[] = [];
  const unsubscribe = set.subscribe((change) => changes.push(change.kind));
  set.commit(rectangle);
  set.commit({ ...rectangle, id: 'top', color: packRgba(20, 50, 200) });
  expect(set.hitTest({ x: 10, y: 20 }, 0)?.id).toBe('top');
  set.showPreview({ ...rectangle, id: 'top', start: { x: 40, y: 40 }, end: { x: 50, y: 50 } });
  expect(set.hitTest({ x: 10, y: 20 }, 0)?.id).toBe('rect');
  expect(set.hitTest({ x: 40, y: 45 }, 0)?.id).toBe('top');
  expect(set.snapshot().find((shape) => shape.id === 'top')?.start).toEqual({ x: 10, y: 10 });
  set.showPreview(null);
  expect(changes).toEqual(['commit', 'commit', 'preview', 'preview']);
  unsubscribe();
  expect(createAnnotationSet().shapes).toEqual([]);
});

test('stored shapes reject malformed geometry and colors', () => {
  expect(isValidAnnotation(rectangle)).toBe(true);
  expect(isValidAnnotation({ ...rectangle, width: Number.NaN })).toBe(false);
  expect(isValidAnnotation({ ...rectangle, color: -1 })).toBe(false);
  const set = createAnnotationSet();
  set.replace([rectangle, { ...rectangle, width: Number.NaN }]);
  expect(set.shapes).toHaveLength(1);
});

test('one preview gesture commits once, while cancel leaves no history entry', () => {
  const document = createBitmapDocument('gesture', 64, 64);
  const set = annotationsFor(document);
  const history = createDocumentHistory();
  const cancelled = beginAnnotationEdit(document, history, 'Rectangle');
  cancelled.preview(rectangle);
  expect(set.shapes).toEqual([]);
  cancelled.cancel();
  expect(history.canUndo).toBe(false);
  const edit = beginAnnotationEdit(document, history, 'Rectangle');
  edit.preview(rectangle);
  edit.preview({ ...rectangle, end: { x: 35, y: 30 } });
  expect(edit.commit({ ...rectangle, end: { x: 35, y: 30 } })).toBe(true);
  expect(set.shapes).toHaveLength(1);
  history.undo(document);
  expect(set.shapes).toEqual([]);
  history.redo(document);
  expect(set.shapes[0]?.end).toEqual({ x: 35, y: 30 });
});

test('duplicate returns a new id, then delete is a separate undo step', () => {
  const document = createBitmapDocument('duplicate', 64, 64);
  const set = annotationsFor(document);
  const history = createDocumentHistory();
  set.commit(rectangle);
  const id = duplicateAnnotation(document, history, rectangle.id, { x: 2, y: 3 });
  expect(id).not.toBe(rectangle.id);
  expect(set.get(id!)?.start).toEqual({ x: 12, y: 13 });
  expect(deleteAnnotation(document, history, id!)).toBe(true);
  expect(set.get(id!)).toBeNull();
  history.undo(document);
  expect(set.get(id!)).not.toBeNull();
  history.undo(document);
  expect(set.get(id!)).toBeNull();
});

test('resize shifts pixels and annotations in one document replacement entry', () => {
  const document = createBitmapDocument('resize-shapes', 40, 40);
  document.pixels[10 * 40 + 10] = rectangle.color;
  annotationsFor(document).commit(rectangle);
  const history = createDocumentHistory();
  const resized = resizeAnnotatedDocument(document, history, 60, 60, 'center');
  expect(resized.pixels[20 * 60 + 20]).toBe(rectangle.color);
  expect(annotationsFor(resized).shapes[0]?.start).toEqual({ x: 20, y: 20 });
  expect(history.undo(resized)).toEqual({ document });
  expect(document.pixels[10 * 40 + 10]).toBe(rectangle.color);
  expect(annotationsFor(document).shapes[0]?.start).toEqual({ x: 10, y: 10 });
  expect(history.redo(document)).toEqual({ document: resized });
});
