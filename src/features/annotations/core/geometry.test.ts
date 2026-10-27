import { expect, test } from 'bun:test';
import { packRgba } from '../../document';
import type { Annotation } from './contracts';
import {
  arrowGeom,
  handlesOf,
  hitShape,
  resizeRect,
  snap45,
  snapToShapeGrid,
  square,
  targetsOf,
  verticalExtentOf,
} from './geometry';
import { annotationsFor, createAnnotationSet, isValidAnnotation } from './set';
import { hitAnnotationSet } from './hit';
import { findAnnotationsFor, watchAnnotationSet } from './registry';
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
  expect(hitShape(thick, { x: 80, y: 9 }, 0)).toBe(true);
  expect(hitShape(thick, { x: 90, y: 9 }, 0)).toBe(false);
  expect(hitShape(thin, { x: 25, y: 5 }, 0)).toBe(false);
});

test('verticalExtentOf bounds a rectangle by its stroke half-width and an arrow head beyond its endpoints', () => {
  // Rectangle y 10 to 30, width 2: half the stroke (1) plus 2px of AA margin either side.
  expect(verticalExtentOf(rectangle)).toEqual({ minY: 7, maxY: 33 });
  // A horizontal width-1 arrow's head swings its triangle corners above and below the shaft.
  const arrow: Annotation = {
    ...rectangle,
    id: 'arrow',
    kind: 'arrow',
    start: { x: 0, y: 0 },
    end: { x: 100, y: 0 },
    width: 1,
  };
  const extent = verticalExtentOf(arrow);
  expect(extent.minY).toBeCloseTo(-4.774);
  expect(extent.maxY).toBeCloseTo(4.774);
  // A band entirely above or below that extent could never see this shape's ink.
  expect(extent.minY < 0 && extent.maxY > 0).toBe(true);
});

test('odd strokes hit and grab where they are drawn, half a pixel inside storage', () => {
  // A 1 px rectangle from 10 to 30 inks columns 10 and 29, so both whole pixels hit.
  const thin: Annotation = { ...rectangle, width: 1 };
  expect(hitShape(thin, { x: 10.95, y: 20 }, 0)).toBe(true);
  expect(hitShape(thin, { x: 29.05, y: 20 }, 0)).toBe(true);
  expect(hitShape(thin, { x: 30.2, y: 20 }, 0)).toBe(false);
  expect(hitShape(thin, { x: 20, y: 29.5 }, 0)).toBe(true);
  // Its handles stay on the outer corners the stroke insets from.
  expect(handlesOf(thin, 1, false)[0]).toEqual({ id: 'nw', x: 10, y: 10 });
  // A 1 px arrow at row 0 inks pixel row 0, and its handles sit on the shaft's ends.
  const arrow: Annotation = {
    ...thin,
    kind: 'arrow',
    start: { x: 0, y: 0 },
    end: { x: 100, y: 0 },
  };
  expect(hitShape(arrow, { x: 25, y: 0.95 }, 0)).toBe(true);
  expect(hitShape(arrow, { x: 25, y: -0.2 }, 0)).toBe(false);
  // The whole head hits, out to its back corners, and nothing beyond its outline.
  const { left, right } = arrowGeom(arrow);
  expect(hitShape(arrow, { x: left.x + 0.5, y: left.y + 0.5 }, 0)).toBe(true);
  expect(hitShape(arrow, { x: right.x + 0.5, y: right.y + 0.5 }, 0)).toBe(true);
  expect(hitShape(arrow, { x: left.x + 0.5, y: left.y + 1.2 }, 0)).toBe(false);
  expect(handlesOf(arrow, 1, false)).toEqual([
    { id: 'start', x: 0.5, y: 0.5 },
    { id: 'end', x: 100.5, y: 0.5 },
  ]);
  expect(snapToShapeGrid({ x: 9.9, y: 4.1 }, 'arrow', 1)).toEqual({ x: 9, y: 4 });
  expect(snapToShapeGrid({ x: 9.9, y: 4.1 }, 'arrow', 2)).toEqual({ x: 10, y: 4 });
  expect(snapToShapeGrid({ x: 9.9, y: 4.1 }, 'rectangle', 1)).toEqual({ x: 10, y: 4 });
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
  expect(hitAnnotationSet(set, { x: 10, y: 20 }, 0)?.id).toBe('top');
  set.showPreview({ ...rectangle, id: 'top', start: { x: 40, y: 40 }, end: { x: 50, y: 50 } });
  expect(hitAnnotationSet(set, { x: 10, y: 20 }, 0)?.id).toBe('rect');
  expect(hitAnnotationSet(set, { x: 40, y: 45 }, 0)?.id).toBe('top');
  expect(set.snapshot().find((shape) => shape.id === 'top')?.start).toEqual({ x: 10, y: 10 });
  set.showPreview(null);
  expect(changes).toEqual(['commit', 'commit', 'preview', 'preview']);
  unsubscribe();
  expect(createAnnotationSet().shapes).toEqual([]);
});

test('a pixel-only document stays without a set until its first annotation', () => {
  const document = createBitmapDocument('cold-shapes', 8, 8);
  expect(findAnnotationsFor(document)).toBeNull();
  const attached: unknown[] = [];
  const stop = watchAnnotationSet(document, (set) => attached.push(set));
  expect(findAnnotationsFor(document)).toBeNull();
  const set = annotationsFor(document);
  expect(attached).toEqual([set]);
  stop();
  expect(findAnnotationsFor(document)).toBe(set);
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
  const cancelled = beginAnnotationEdit(document, history);
  cancelled.preview(rectangle);
  expect(set.shapes).toEqual([]);
  cancelled.cancel();
  expect(history.canUndo).toBe(false);
  const edit = beginAnnotationEdit(document, history);
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

test('odd Center growth and shrink round-trip every pixel and shape coordinate', () => {
  const document = createBitmapDocument('odd-resize', 16, 16);
  for (let i = 0; i < document.pixels.length; i++) document.pixels[i] = i + 1;
  const shape: Annotation = {
    ...rectangle,
    start: { x: 2, y: 3 },
    end: { x: 12, y: 14 },
  };
  annotationsFor(document).commit(shape);
  const history = createDocumentHistory();

  const grown = resizeAnnotatedDocument(document, history, 17, 17, 'center');
  expect(grown.pixels[0]).toBe(1);
  expect(grown.pixels[15 * 17 + 15]).toBe(256);
  expect(grown.pixels[16]).toBe(0);
  expect(grown.pixels[16 * 17]).toBe(0);
  expect(annotationsFor(grown).shapes).toEqual([shape]);

  const restored = resizeAnnotatedDocument(grown, history, 16, 16, 'center');
  expect(Array.from(restored.pixels)).toEqual(Array.from(document.pixels));
  expect(annotationsFor(restored).shapes).toEqual([shape]);
});
