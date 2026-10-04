import { describe, expect, test } from 'bun:test';
import { createAnnotationSet } from '../../annotations/model';
import type { Annotation } from '../../annotations/model';
import { packRgba } from '../../document';
import {
  beginShapeDrag,
  isDegenerateShape,
  keepsOnImage,
  leftDeadZone,
  liveShape,
  shapeTargetAt,
} from './shapeGesture';

const color = packRgba(255, 59, 48);
const style = { color: packRgba(0, 122, 255), width: 3 };
const ids = { newId: 'new', copyId: 'copy' };
const none = { shift: false, alt: false };

const box: Annotation = {
  id: 'box',
  kind: 'rectangle',
  start: { x: 100, y: 100 },
  end: { x: 200, y: 160 },
  width: 4,
  color,
};
const arrow: Annotation = {
  id: 'arrow',
  kind: 'arrow',
  start: { x: 120, y: 130 },
  end: { x: 180, y: 130 },
  width: 4,
  color,
};

function setOf(...shapes: Annotation[]) {
  const set = createAnnotationSet();
  set.replace(shapes);
  return set;
}

test('an unselected rectangle hits on its stroke, so presses inside it fall through', () => {
  const set = setOf(box);
  expect(shapeTargetAt(set, null, { x: 150, y: 101 }, 1, false, false)).toEqual({
    shape: box,
    handle: null,
  });
  expect(shapeTargetAt(set, null, { x: 150, y: 140 }, 1, false, false)).toBeNull();
  expect(shapeTargetAt(set, 'box', { x: 150, y: 140 }, 1, false, false)?.handle).toBeNull();
});

test('mouse tolerance is 5 screen pixels and touch is 14, at any zoom', () => {
  const set = setOf(box);
  // The stroke's outer edge is y 98. Mouse reaches 5 screen px beyond it, touch 14.
  expect(shapeTargetAt(set, null, { x: 150, y: 93 }, 1, false, false)).not.toBeNull();
  expect(shapeTargetAt(set, null, { x: 150, y: 92 }, 1, false, false)).toBeNull();
  expect(shapeTargetAt(set, null, { x: 150, y: 84 }, 1, true, true)).not.toBeNull();
  expect(shapeTargetAt(set, null, { x: 150, y: 83 }, 1, true, true)).toBeNull();
  // At 4× the same screen distances are a quarter as many document pixels.
  expect(shapeTargetAt(set, null, { x: 150, y: 96.75 }, 4, false, false)).not.toBeNull();
  expect(shapeTargetAt(set, null, { x: 150, y: 96.5 }, 4, false, false)).toBeNull();
});

test('the topmost shape wins, so an arrow inside a box is reachable', () => {
  const set = setOf(box, arrow);
  expect(shapeTargetAt(set, null, { x: 150, y: 131 }, 1, false, false)?.shape.id).toBe('arrow');
  expect(
    shapeTargetAt(setOf(arrow, box), null, { x: 150, y: 131 }, 1, false, false)?.shape.id,
  ).toBe('arrow');
});

test('only the selected shape shows handles, and they win over shapes above it', () => {
  const set = setOf(box, arrow);
  expect(shapeTargetAt(set, null, { x: 120, y: 130 }, 1, false, false)?.handle).toBeNull();
  expect(shapeTargetAt(set, 'arrow', { x: 122, y: 131 }, 1, false, false)).toEqual({
    shape: arrow,
    handle: 'start',
  });
  // The box's corner sits under nothing, but a handle 7 px away is still in reach.
  expect(shapeTargetAt(set, 'box', { x: 205, y: 165 }, 1, false, false)?.handle).toBe('se');
  expect(shapeTargetAt(set, 'box', { x: 209, y: 169 }, 1, false, false)).toBeNull();
});

test('touch handles are 44 px targets and overlapping ones go to the nearest center', () => {
  const tiny: Annotation = { ...box, start: { x: 0, y: 0 }, end: { x: 10, y: 10 } };
  const set = setOf(tiny);
  // 21 screen px from the pushed-out corner still grabs it.
  const corner = shapeTargetAt(set, 'box', { x: -14, y: -14 }, 2, true, true);
  expect(corner?.handle).toBe('nw');
  const se = shapeTargetAt(set, 'box', { x: 22, y: 22 }, 2, true, true);
  expect(se?.handle).toBe('se');
  // Targets slide outward on a small shape, so its middle still moves it.
  expect(shapeTargetAt(set, 'box', { x: 5, y: 5 }, 2, true, true)).toEqual({
    shape: tiny,
    handle: null,
  });
});

test('a press on nothing draws, a body moves, Option copies, and a handle reshapes', () => {
  const at = { x: 10.4, y: 19.6 };
  // An odd arrow starts on the pixel under the press, where its cap is drawn. Rectangles and even
  // arrows start on the nearest grid line.
  expect(beginShapeDrag(null, at, { kind: 'arrow', width: 3 }, ids, false)).toEqual({
    mode: 'draw',
    kind: 'arrow',
    id: 'new',
    start: { x: 10, y: 19 },
  });
  expect(beginShapeDrag(null, at, { kind: 'arrow', width: 4 }, ids, false)).toMatchObject({
    start: { x: 10, y: 20 },
  });
  expect(beginShapeDrag(null, at, { kind: 'rectangle', width: 3 }, ids, false)).toMatchObject({
    start: { x: 10, y: 20 },
  });
  expect(
    beginShapeDrag(
      { shape: box, handle: null },
      at,
      { kind: 'arrow', width: style.width },
      ids,
      false,
    ),
  ).toMatchObject({
    mode: 'move',
    id: 'box',
  });
  expect(
    beginShapeDrag(
      { shape: box, handle: null },
      at,
      { kind: 'arrow', width: style.width },
      ids,
      true,
    ),
  ).toMatchObject({
    mode: 'move',
    id: 'copy',
  });
  // Option on a handle reshapes rather than copying.
  expect(
    beginShapeDrag(
      { shape: box, handle: 'se' },
      at,
      { kind: 'arrow', width: style.width },
      ids,
      true,
    ),
  ).toMatchObject({
    mode: 'handle',
    handle: 'se',
  });
});

test('a press stays a tap until it travels 3 screen px with a mouse or 8 with a finger', () => {
  const start = { x: 10, y: 10 };
  expect(leftDeadZone(start, { x: 12.9, y: 10 }, 1, false)).toBe(false);
  expect(leftDeadZone(start, { x: 13, y: 10 }, 1, false)).toBe(true);
  expect(leftDeadZone(start, { x: 13.5, y: 10 }, 2, true)).toBe(false);
  expect(leftDeadZone(start, { x: 14, y: 10 }, 2, true)).toBe(true);
});

test('drawing uses the current style and Shift squares rectangles or snaps arrows', () => {
  const rect = beginShapeDrag(
    null,
    { x: 10, y: 10 },
    { kind: 'rectangle', width: style.width },
    ids,
    false,
  );
  expect(liveShape(rect, { x: 40.4, y: 25.6 }, none, style)).toEqual({
    id: 'new',
    kind: 'rectangle',
    start: { x: 10, y: 10 },
    end: { x: 40, y: 26 },
    ...style,
  });
  expect(liveShape(rect, { x: 40, y: 26 }, { shift: true, alt: false }, style).end).toEqual({
    x: 40,
    y: 40,
  });
  expect(liveShape(rect, { x: 40, y: 26 }, { shift: false, alt: true }, style)).toMatchObject({
    start: { x: -20, y: -6 },
    end: { x: 40, y: 26 },
  });

  const line = beginShapeDrag(
    null,
    { x: 0, y: 0 },
    { kind: 'arrow', width: style.width },
    ids,
    false,
  );
  expect(liveShape(line, { x: 50, y: 6 }, { shift: true, alt: false }, style).end).toEqual({
    x: 50,
    y: 0,
  });
  // Option only centers rectangles.
  expect(liveShape(line, { x: 50, y: 6 }, { shift: false, alt: true }, style).start).toEqual({
    x: 0,
    y: 0,
  });
});

test('moving keeps the shape style and Shift locks the dominant axis', () => {
  const move = beginShapeDrag(
    { shape: box, handle: null },
    { x: 150, y: 101 },
    { kind: 'arrow', width: style.width },
    ids,
    false,
  );
  expect(liveShape(move, { x: 160, y: 104 }, none, style)).toEqual({
    ...box,
    start: { x: 110, y: 103 },
    end: { x: 210, y: 163 },
  });
  expect(liveShape(move, { x: 160, y: 104 }, { shift: true, alt: false }, style)).toMatchObject({
    start: { x: 110, y: 100 },
    end: { x: 210, y: 160 },
  });
  const copy = beginShapeDrag(
    { shape: box, handle: null },
    { x: 150, y: 101 },
    { kind: 'arrow', width: style.width },
    ids,
    true,
  );
  expect(liveShape(copy, { x: 150, y: 111 }, none, style)).toMatchObject({
    id: 'copy',
    start: { x: 100, y: 110 },
  });
});

test('arrow endpoints move alone and snap around the fixed end', () => {
  const drag = beginShapeDrag(
    { shape: arrow, handle: 'end' },
    { x: 180, y: 130 },
    { kind: 'arrow', width: style.width },
    ids,
    false,
  );
  expect(liveShape(drag, { x: 190.2, y: 170.7 }, none, style)).toEqual({
    ...arrow,
    end: { x: 190, y: 171 },
  });
  expect(liveShape(drag, { x: 160, y: 168 }, { shift: true, alt: false }, style)).toMatchObject({
    start: arrow.start,
    end: { x: 159, y: 169 },
  });
  const start = beginShapeDrag(
    { shape: arrow, handle: 'start' },
    arrow.start,
    { kind: 'arrow', width: style.width },
    ids,
    false,
  );
  expect(liveShape(start, { x: 100, y: 100 }, none, style)).toMatchObject({
    start: { x: 100, y: 100 },
    end: arrow.end,
  });
  // An odd arrow's end grabbed at its drawn center lands on the pixel under the pointer, even in
  // its right half.
  const odd = { ...arrow, width: 1 };
  const oddEnd = beginShapeDrag(
    { shape: odd, handle: 'end' },
    { x: odd.end.x + 0.5, y: odd.end.y + 0.5 },
    { kind: 'arrow', width: 1 },
    ids,
    false,
  );
  expect(liveShape(oddEnd, { x: 190.8, y: 170.9 }, none, style).end).toEqual({ x: 190, y: 170 });
});

test('rectangle handles resize from the opposite side, and edges move one side', () => {
  const corner = beginShapeDrag(
    { shape: box, handle: 'nw' },
    box.start,
    { kind: 'arrow', width: style.width },
    ids,
    false,
  );
  expect(liveShape(corner, { x: 90, y: 80 }, none, style)).toMatchObject({
    id: 'box',
    start: { x: 90, y: 80 },
    end: { x: 200, y: 160 },
    width: 4,
    color,
  });
  const edge = beginShapeDrag(
    { shape: box, handle: 'e' },
    { x: 200, y: 130 },
    { kind: 'arrow', width: style.width },
    ids,
    false,
  );
  expect(liveShape(edge, { x: 230, y: 50 }, none, style)).toMatchObject({
    start: { x: 100, y: 100 },
    end: { x: 230, y: 160 },
  });
});

test('shapes under 2 document pixels are discarded on release', () => {
  const rect = (dx: number, dy: number): Annotation => ({
    ...box,
    end: { x: 100 + dx, y: 100 + dy },
  });
  expect(isDegenerateShape(rect(1, 40))).toBe(true);
  expect(isDegenerateShape(rect(40, -1))).toBe(true);
  expect(isDegenerateShape(rect(2, 2))).toBe(false);
  const line = (dx: number, dy: number): Annotation => ({
    ...arrow,
    end: { x: arrow.start.x + dx, y: arrow.start.y + dy },
  });
  expect(isDegenerateShape(line(1, 1))).toBe(true);
  expect(isDegenerateShape(line(0, 2))).toBe(false);
});

test('a handle grabbed off its center follows the drag instead of jumping to the pointer', () => {
  // A finger 20 px off the corner of a 44 px touch target, and a cursor 6 px off an arrow's end.
  const corner = beginShapeDrag(
    { shape: box, handle: 'se' },
    { x: 214, y: 174 },
    { kind: 'arrow', width: style.width },
    ids,
    false,
  );
  expect(liveShape(corner, { x: 214, y: 174 }, none, style)).toEqual(box);
  expect(liveShape(corner, { x: 224, y: 179 }, none, style)).toMatchObject({
    start: box.start,
    end: { x: 210, y: 165 },
  });
  const end = beginShapeDrag(
    { shape: arrow, handle: 'end' },
    { x: 186, y: 130 },
    { kind: 'arrow', width: style.width },
    ids,
    false,
  );
  expect(liveShape(end, { x: 187, y: 131 }, none, style).end).toEqual({ x: 181, y: 131 });
});

describe('keeping shapes on the image', () => {
  const image = { width: 300, height: 200, zoom: 1 };

  test('a shape keeps when 8 screen px of its stroke centerline is on the image', () => {
    const at = (x: number, y: number): Annotation => ({
      ...arrow,
      start: { x, y },
      end: { x: x + 60, y },
    });
    expect(keepsOnImage(at(-52, 50), image)).toBe(true);
    expect(keepsOnImage(at(-53, 50), image)).toBe(false);
    expect(keepsOnImage(at(100, 200), image)).toBe(true);
    expect(keepsOnImage(at(100, 201), image)).toBe(false);
    // At 4× the same 8 screen px is 2 document px.
    expect(keepsOnImage(at(-58, 50), { ...image, zoom: 4 })).toBe(true);
    expect(keepsOnImage(at(-59, 50), { ...image, zoom: 4 })).toBe(false);
    // A rectangle around the whole image outlines its edges, and one around it misses entirely.
    const outline = { ...box, start: { x: 0, y: 0 }, end: { x: 300, y: 200 } };
    expect(keepsOnImage(outline, image)).toBe(true);
    expect(
      keepsOnImage({ ...outline, start: { x: -1, y: -1 }, end: { x: 301, y: 201 } }, image),
    ).toBe(false);
    // A short side only has to be whole, and an odd stroke is drawn half a pixel in.
    const tiny = { ...box, width: 1, start: { x: 296, y: 10 }, end: { x: 299, y: 13 } };
    expect(keepsOnImage(tiny, image)).toBe(true);
    expect(keepsOnImage({ ...tiny, start: { x: 300, y: 10 }, end: { x: 303, y: 13 } }, image)).toBe(
      false,
    );
  });

  test('a move stops where any further would leave too little on the image', () => {
    const move = beginShapeDrag(
      { shape: box, handle: null },
      { x: 150, y: 101 },
      { kind: 'arrow', width: style.width },
      ids,
      false,
    );
    // Dragged 400 px left, the box stops with its right side on the image's left edge, where half
    // of that stroke still draws along its full height.
    const kept = liveShape(move, { x: -250, y: 101 }, none, style, image);
    expect(keepsOnImage(kept, image)).toBe(true);
    expect(kept.end.x).toBe(0);
    expect(kept.start.y).toBe(100);
    // Without bounds, or inside them, nothing changes.
    expect(liveShape(move, { x: -250, y: 101 }, none, style).end.x).toBe(-200);
    expect(liveShape(move, { x: 160, y: 104 }, none, style, image).end).toEqual({ x: 210, y: 163 });
    // A copy that stops keeps its own id.
    const copy = beginShapeDrag(
      { shape: box, handle: null },
      { x: 150, y: 101 },
      { kind: 'arrow', width: style.width },
      ids,
      true,
    );
    expect(liveShape(copy, { x: 150, y: 900 }, none, style, image)).toMatchObject({
      id: 'copy',
      start: { x: 100, y: 200 },
    });
  });

  test('a reshape stops too, and a shape already off the image moves freely', () => {
    // An arrow pointing off the image's right edge keeps 8 px of shaft as its tail follows.
    const outward = { ...arrow, start: { x: 250, y: 130 }, end: { x: 350, y: 130 } };
    const tail = beginShapeDrag(
      { shape: outward, handle: 'start' },
      outward.start,
      { kind: 'arrow', width: style.width },
      ids,
      false,
    );
    const kept = liveShape(tail, { x: 900, y: 130 }, none, style, image);
    expect(kept).toMatchObject({ start: { x: 292, y: 130 }, end: outward.end });
    // Its head can swing anywhere while the tail holds it on.
    const head = beginShapeDrag(
      { shape: outward, handle: 'end' },
      outward.end,
      { kind: 'arrow', width: style.width },
      ids,
      false,
    );
    expect(liveShape(head, { x: 900, y: 900 }, none, style, image).end).toEqual({ x: 900, y: 900 });
    const lost = { ...box, start: { x: 400, y: 100 }, end: { x: 500, y: 160 } };
    const move = beginShapeDrag(
      { shape: lost, handle: null },
      { x: 450, y: 100 },
      { kind: 'arrow', width: style.width },
      ids,
      false,
    );
    expect(liveShape(move, { x: 470, y: 100 }, none, style, image).start.x).toBe(420);
  });
});
