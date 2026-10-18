import { expect, test } from 'bun:test';
import { annotationsFor } from '../../annotations';
import type { Annotation } from '../../annotations';
import { createBitmapDocument, packRgba } from '../../document';
import { createEditorSession } from './session';

const RED = packRgba(255, 0, 0);
const BLUE = packRgba(0, 0, 255);

function input(x: number, y: number, alt = false) {
  return { point: { x, y }, shift: false, alt };
}

function box(id: string, color = RED): Annotation {
  return { id, kind: 'rectangle', start: { x: 10, y: 10 }, end: { x: 30, y: 20 }, color, width: 2 };
}

/** The shape controller loads on demand, so a test waits for it like a first press would. */
async function open(shapes: Annotation[] = [], { load = true } = {}) {
  const document = createBitmapDocument('shapes', 64, 64);
  for (const shape of shapes) annotationsFor(document).commit(shape);
  const session = createEditorSession({ document, save: null });
  session.setViewport({
    // At 8× the handles cover about a pixel, as they do in a real edit.
    zoom: 8,
    panX: 0,
    panY: 0,
    cssWidth: 512,
    cssHeight: 512,
    devicePixelRatio: 1,
  });
  if (load) {
    await import('./shapes');
    await Bun.sleep(0);
  }
  const set = () => annotationsFor(session.bitmap.state);
  return { session, set };
}

function drag(
  session: Awaited<ReturnType<typeof open>>['session'],
  from: [number, number],
  to: [number, number],
  alt = false,
) {
  session.beginGesture(input(from[0], from[1], alt));
  session.extendGesture([input(to[0], to[1], alt)]);
  session.endGesture();
}

test('a Shapes drag draws one selected shape as one undo step, and a tap draws nothing', async () => {
  const { session, set } = await open();
  session.run({ type: 'shape-tool', kind: 'arrow' });
  await Bun.sleep(0);
  session.chooseColor(BLUE, 'primary');

  session.beginGesture(input(5, 5));
  session.endGesture();
  expect(set().shapes).toHaveLength(0);
  expect(session.state.state.canUndo).toBe(false);

  drag(session, [5, 5], [40, 30]);
  const [arrow] = set().shapes;
  expect(arrow).toMatchObject({ kind: 'arrow', start: { x: 5, y: 5 }, end: { x: 40, y: 30 } });
  expect(arrow!.color).toBe(BLUE);
  expect(session.state.state.selectedShape).toEqual({ id: arrow!.id, kind: 'arrow' });
  expect(session.overlay.state.selectedAnnotationId).toBe(arrow!.id);
  expect(session.state.state.recent[0]).toBe(BLUE);

  session.run({ type: 'undo' });
  expect(set().shapes).toHaveLength(0);
  expect(session.state.state.selectedShape).toBeNull();
  expect(session.overlay.state.selectedAnnotationId).toBeNull();
});

test('Select moves a shape, and Option-drag leaves the original behind', async () => {
  const { session, set } = await open([box('box')]);
  session.run({ type: 'tool', tool: 'select' });

  drag(session, [10, 15], [15, 20]);
  expect(set().get('box')).toMatchObject({ start: { x: 15, y: 15 }, end: { x: 35, y: 25 } });
  expect(session.state.state.selectedShape?.id).toBe('box');
  // Selecting a shape loads its style into the well and the width bar.
  expect(session.state.state.primary).toBe(RED);
  expect(session.state.state.shapeWidth).toBe(2);

  // A press on the edge, away from the selected handles, moves rather than resizes.
  drag(session, [20, 15], [20, 35], true);
  expect(set().shapes).toHaveLength(2);
  expect(set().get('box')?.start).toEqual({ x: 15, y: 15 });
  const copy = set().shapes.find((shape) => shape.id !== 'box')!;
  expect(copy.start).toEqual({ x: 15, y: 35 });
  expect(session.state.state.selectedShape?.id).toBe(copy.id);

  session.run({ type: 'undo' });
  expect(set().shapes).toHaveLength(1);
  expect(session.state.state.selectedShape).toBeNull();
});

test('a press on empty canvas with Select deselects the shape and starts a marquee', async () => {
  const { session } = await open([box('box')]);
  session.run({ type: 'tool', tool: 'select' });
  drag(session, [10, 15], [10, 15]);
  expect(session.state.state.selectedShape?.id).toBe('box');

  drag(session, [40, 40], [50, 50]);
  expect(session.state.state.selectedShape).toBeNull();
  expect(session.state.state.selection).not.toBeNull();

  // The two selections are exclusive in both directions.
  drag(session, [10, 15], [10, 15]);
  expect(session.state.state.selection).toBeNull();
  expect(session.state.state.selectedShape?.id).toBe('box');
});

test('shape actions delete, duplicate, and deselect, each as its own step', async () => {
  const { session, set } = await open([box('box')]);
  session.run({ type: 'tool', tool: 'select' });
  drag(session, [10, 15], [10, 15]);

  session.run({ type: 'shape', action: 'duplicate' });
  expect(set().shapes).toHaveLength(2);
  const copy = session.state.state.selectedShape!.id;
  expect(copy).not.toBe('box');
  // 12 screen px at 8× rounds to 2 image px.
  expect(set().get(copy)?.start).toEqual({ x: 12, y: 12 });

  session.run({ type: 'shape', action: 'delete' });
  expect(set().get(copy)).toBeNull();
  expect(session.state.state.selectedShape).toBeNull();

  drag(session, [10, 15], [10, 15]);
  session.run({ type: 'shape', action: 'deselect' });
  expect(session.state.state.selectedShape).toBeNull();

  session.run({ type: 'undo' });
  expect(set().shapes).toHaveLength(2);
  session.run({ type: 'undo' });
  expect(set().shapes).toHaveLength(1);
});

test('repeated duplicates step on from the newest copy, each its own undo step', async () => {
  // Only 1 px of this arrow's shaft is on the 64 px image, so the first copy steps left.
  const edge: Annotation = {
    id: 'edge',
    kind: 'arrow',
    start: { x: 63, y: 30 },
    end: { x: 80, y: 30 },
    color: RED,
    width: 2,
  };
  const { session, set } = await open([edge]);
  session.run({ type: 'tool', tool: 'select' });
  drag(session, [63.5, 30], [63.5, 30]);
  expect(session.state.state.selectedShape?.id).toBe('edge');

  const starts = [];
  for (let step = 0; step < 3; step++) {
    session.run({ type: 'shape', action: 'duplicate' });
    starts.push(set().get(session.state.state.selectedShape!.id)?.start);
  }
  // Down and right still fits from a copy, yet the run keeps going the way it started.
  expect(starts).toEqual([
    { x: 61, y: 32 },
    { x: 59, y: 34 },
    { x: 57, y: 36 },
  ]);
  for (let step = 3; step > 0; step--) {
    expect(set().shapes).toHaveLength(step + 1);
    session.run({ type: 'undo' });
  }
  expect(set().shapes).toHaveLength(1);
});

test('nudges and restyles coalesce until another command lands them', async () => {
  const { session, set } = await open([box('box')]);
  session.run({ type: 'tool', tool: 'select' });
  drag(session, [10, 15], [10, 15]);

  session.run({ type: 'nudge', dx: 1, dy: 0 });
  session.run({ type: 'nudge', dx: 1, dy: 0 });
  session.run({ type: 'nudge', dx: 0, dy: 10 });
  expect(set().preview?.start).toEqual({ x: 12, y: 20 });
  // Width steps and color picks restyle the selected shape.
  session.run({ type: 'brush-size', direction: 1 });
  session.chooseColor(BLUE, 'primary');
  session.run({ type: 'toggle-grid' });
  expect(set().get('box')).toMatchObject({ start: { x: 12, y: 20 }, color: BLUE });
  expect(set().get('box')!.width).toBeGreaterThan(2);

  session.run({ type: 'undo' });
  expect(set().get('box')).toMatchObject({ start: { x: 12, y: 20 }, color: RED, width: 2 });
  expect(session.state.state.shapeWidth).toBe(2);
  session.run({ type: 'undo' });
  expect(set().get('box')?.start).toEqual({ x: 10, y: 10 });
  expect(session.state.state.canUndo).toBe(false);
});

test('undo and redo of a restyle bring the color controls along, without touching Recent', async () => {
  const { session, set } = await open([box('box')]);
  session.run({ type: 'tool', tool: 'select' });
  drag(session, [10, 15], [10, 15]);
  expect(session.state.state.primary).toBe(RED);

  session.chooseColor(BLUE, 'primary');
  session.flushPendingEdits();
  const recent = session.state.state.recent;
  expect(recent[0]).toBe(BLUE);

  session.run({ type: 'undo' });
  expect(set().get('box')?.color).toBe(RED);
  expect(session.state.state.selectedShape?.id).toBe('box');
  expect(session.state.state.primary).toBe(RED);
  expect(session.state.state.recent).toBe(recent);

  session.run({ type: 'redo' });
  expect(set().get('box')?.color).toBe(BLUE);
  expect(session.state.state.primary).toBe(BLUE);
  expect(session.state.state.recent).toBe(recent);
});

test('a nudge held at the image edge keeps holding after zooming out', async () => {
  const arrow: Annotation = {
    id: 'arrow',
    kind: 'arrow',
    start: { x: 10, y: 30 },
    end: { x: 40, y: 30 },
    color: RED,
    width: 2,
  };
  const { session, set } = await open([arrow]);
  session.run({ type: 'tool', tool: 'select' });
  drag(session, [20, 30], [20, 30]);
  // At 8× the tip holds 8 screen px, one document pixel, on the image.
  for (let step = 0; step < 60; step++) session.run({ type: 'nudge', dx: -1, dy: 0 });
  expect(set().preview?.end).toEqual({ x: 1, y: 30 });
  session.setViewport({
    zoom: 1,
    panX: 0,
    panY: 0,
    cssWidth: 512,
    cssHeight: 512,
    devicePixelRatio: 1,
  });
  for (let step = 0; step < 10; step++) session.run({ type: 'nudge', dx: -10, dy: 0 });
  session.flushPendingEdits();
  expect(set().get('arrow')?.end).toEqual({ x: 1, y: 30 });
});

test('flushPendingEdits lands a pending nudge as its undo step, without touching a selection', async () => {
  // This is what a pagehide must be able to reach to keep a nudge or restyle from being lost on
  // an immediate reload or app switch, so it has to actually commit the amend — not merely act as
  // a no-op alias for some other command that happens to flush shapes as a side effect — and it
  // must leave an unrelated floating selection alone, since a reload is expected to keep that
  // uncommitted (unlike a shape amend, which the artist already saw applied).
  const { session, set } = await open([box('box')]);
  session.run({ type: 'tool', tool: 'select' });
  drag(session, [10, 15], [10, 15]);

  session.run({ type: 'nudge', dx: 1, dy: 0 });
  expect(set().preview?.start).toEqual({ x: 11, y: 10 });
  expect(set().get('box')?.start).toEqual({ x: 10, y: 10 }); // not committed yet

  session.flushPendingEdits();
  expect(set().get('box')?.start).toEqual({ x: 11, y: 10 });
  expect(session.state.state.canUndo).toBe(true);

  session.run({ type: 'undo' });
  expect(set().get('box')?.start).toEqual({ x: 10, y: 10 });
});

test('the eyedropper picks a shape’s exact color over the pixels beneath it', async () => {
  const { session } = await open([box('box', BLUE)]);
  session.run({ type: 'tool', tool: 'eyedropper' });
  await Bun.sleep(0);
  session.beginGesture(input(10.4, 15.5));
  session.endGesture();
  expect(session.state.state.primary).toBe(BLUE);
});

test('a pixel tool deselects the shape, and a pinch takeover restores the drag', async () => {
  const { session, set } = await open([box('box')]);
  session.run({ type: 'tool', tool: 'select' });
  drag(session, [10, 15], [10, 15]);

  session.beginGesture(input(10, 15), 'touch');
  session.extendGesture([input(20, 30)]);
  expect(set().preview?.start).toEqual({ x: 20, y: 25 });
  session.cancelGesture();
  expect(set().preview).toBeNull();
  expect(set().get('box')?.start).toEqual({ x: 10, y: 10 });
  expect(session.state.state.selectedShape?.id).toBe('box');
  expect(session.state.state.canUndo).toBe(false);

  session.run({ type: 'tool', tool: 'pencil' });
  expect(session.state.state.selectedShape).toBeNull();
  expect(session.overlay.state.selectedAnnotationId).toBeNull();
});

test('a Shapes press before the controller loads still draws, released or held', async () => {
  const { session, set } = await open([], { load: false });
  // Arming starts the load, and these presses land before it resolves.
  session.run({ type: 'shape-tool', kind: 'rectangle' });
  drag(session, [5, 5], [20, 20]);
  expect(set().shapes).toHaveLength(0);
  await Bun.sleep(0);
  expect(set().shapes).toHaveLength(1);
  expect(session.state.state.canUndo).toBe(true);

  const held = await open([], { load: false });
  held.session.run({ type: 'shape-tool', kind: 'arrow' });
  held.session.beginGesture(input(5, 5));
  held.session.extendGesture([input(10, 10)]);
  await Bun.sleep(0);
  held.session.extendGesture([input(30, 20)]);
  held.session.endGesture();
  expect(held.set().shapes[0]).toMatchObject({ kind: 'arrow', end: { x: 30, y: 20 } });
  expect(held.session.state.state.selectedShape?.kind).toBe('arrow');
});
