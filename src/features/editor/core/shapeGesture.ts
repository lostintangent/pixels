import {
  hitAnnotationSet,
  rectOf,
  resizeRect,
  snap45,
  snapToShapeGrid,
  square,
  strokeOffset,
  targetsOf,
  translateAnnotation,
} from '../../annotations';
import type {
  Annotation,
  AnnotationHandleId,
  AnnotationKind,
  AnnotationSet,
} from '../../annotations/model';
import type { PixelPoint } from '../../document';

/** Shape hit tolerance in screen pixels: a finger covers more than a cursor. */
export const SHAPE_HIT_SLOP = { mouse: 5, touch: 14 } as const;
/** How far from a handle's center a press still grabs it, in screen pixels. Touch is a 44 px target. */
const HANDLE_REACH = { mouse: 8, touch: 22 } as const;
/** Movement below this many screen pixels keeps a press a tap, so a tap never draws or moves. */
const DEAD_ZONE = { mouse: 3, touch: 8 } as const;
/** A drawn shape smaller than this along its short side (or an arrow this short) is discarded. */
const MIN_SIZE = 2;
/**
 * How much of a shape's stroke, in screen pixels along its centerline, has to stay on the image.
 * Enough to see and grab again, like a handle's reach. A shorter side only has to stay whole.
 */
const KEEP_ON_IMAGE = 8;

export interface ShapeTarget {
  shape: Annotation;
  /** The grabbed handle, or null for the body. */
  handle: AnnotationHandleId | null;
}

/**
 * What a press at `point` lands on. The selected shape's handles win first, nearest one where
 * touch targets overlap. Then shapes from the top down, where an unselected rectangle only hits
 * on its stroke so an arrow can start inside a box.
 */
export function shapeTargetAt(
  shapes: AnnotationSet,
  selectedId: string | null,
  point: PixelPoint,
  zoom: number,
  touch: boolean,
  coarse: boolean,
): ShapeTarget | null {
  const selected = selectedId === null ? null : shapes.get(selectedId);
  if (selected) {
    let best: AnnotationHandleId | null = null;
    let reach: number = touch ? HANDLE_REACH.touch : HANDLE_REACH.mouse;
    for (const handle of targetsOf(selected, zoom, touch || coarse)) {
      const distance = Math.hypot((handle.x - point.x) * zoom, (handle.y - point.y) * zoom);
      if (distance <= reach) {
        reach = distance;
        best = handle.id;
      }
    }
    if (best) return { shape: selected, handle: best };
  }
  const slop = (touch ? SHAPE_HIT_SLOP.touch : SHAPE_HIT_SLOP.mouse) / zoom;
  const shape = hitAnnotationSet(shapes, point, slop, selectedId ?? undefined);
  return shape ? { shape, handle: null } : null;
}

export interface ShapeStyle {
  color: Annotation['color'];
  width: number;
}

export type ShapeDrag =
  | { mode: 'draw'; kind: AnnotationKind; id: string; start: PixelPoint }
  | { mode: 'move'; original: Annotation; id: string; start: PixelPoint }
  | {
      mode: 'handle';
      original: Annotation;
      handle: AnnotationHandleId;
      start: PixelPoint;
      /** From the press to the handle's drawn center, so the handle follows rather than jumps. */
      grab: PixelPoint;
    };

/** Where a shape draws on the image, so a drag can keep some of it there. */
export interface ShapeBounds {
  width: number;
  height: number;
  zoom: number;
}

export interface ShapeDragModifiers {
  shift: boolean;
  alt: boolean;
}

const snap = (point: PixelPoint): PixelPoint => ({
  x: Math.round(point.x),
  y: Math.round(point.y),
});

/**
 * Starts a drag from a press. A target moves or reshapes that shape. An Option press on a body
 * moves a copy under `copyId`. A press on nothing draws a new `kind` at `width` under `newId`.
 */
export function beginShapeDrag(
  target: ShapeTarget | null,
  point: PixelPoint,
  draw: { kind: AnnotationKind; width: number },
  ids: { newId: string; copyId: string },
  alt: boolean,
): ShapeDrag {
  if (!target) {
    const start = snapToShapeGrid(point, draw.kind, draw.width);
    return { mode: 'draw', kind: draw.kind, id: ids.newId, start };
  }
  const start = snap(point);
  if (target.handle) {
    const center = handleCenter(target.shape, target.handle);
    const grab = { x: center.x - point.x, y: center.y - point.y };
    return { mode: 'handle', original: target.shape, handle: target.handle, start, grab };
  }
  return { mode: 'move', original: target.shape, id: alt ? ids.copyId : target.shape.id, start };
}

/** Whether a press has traveled far enough, in screen pixels, to become a drag. */
export function leftDeadZone(
  start: PixelPoint,
  point: PixelPoint,
  zoom: number,
  touch: boolean,
): boolean {
  const distance = Math.hypot((point.x - start.x) * zoom, (point.y - start.y) * zoom);
  return distance >= (touch ? DEAD_ZONE.touch : DEAD_ZONE.mouse);
}

/** The drawn center of a handle, before touch targets spread out from it. */
function handleCenter(shape: Annotation, handle: AnnotationHandleId): PixelPoint {
  if (shape.kind === 'arrow') {
    const offset = strokeOffset(shape.width);
    const end = handle === 'start' ? shape.start : shape.end;
    return { x: end.x + offset, y: end.y + offset };
  }
  const rect = rectOf(shape);
  const x = handle.includes('w')
    ? rect.x
    : handle.includes('e')
      ? rect.x + rect.width
      : rect.x + rect.width / 2;
  const y = handle.includes('n')
    ? rect.y
    : handle.includes('s')
      ? rect.y + rect.height
      : rect.y + rect.height / 2;
  return { x, y };
}

/**
 * The shape a drag shows at `point`. Shift squares a rectangle, snaps an arrow to 45°, and locks a
 * move to one axis. Option draws a rectangle out from its center. With `bounds`, a move or reshape
 * of a shape on the image stops where any further would leave too little of it there.
 */
export function liveShape(
  drag: ShapeDrag,
  point: PixelPoint,
  modifiers: ShapeDragModifiers,
  style: ShapeStyle,
  bounds?: ShapeBounds,
): Annotation {
  const shape = freeShape(drag, point, modifiers, style);
  if (drag.mode === 'draw' || !bounds || keepsOnImage(shape, bounds)) return shape;
  if (!keepsOnImage(drag.original, bounds)) return shape;
  // Moving or reshaping on the image is a straight path, so search it for the last place it stays.
  const from = drag.mode === 'move' ? drag.start : handleCenter(drag.original, drag.handle);
  const to = drag.mode === 'move' ? point : { x: point.x + drag.grab.x, y: point.y + drag.grab.y };
  const toward = (t: number): PixelPoint => {
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    return drag.mode === 'move' ? { x, y } : { x: x - drag.grab.x, y: y - drag.grab.y };
  };
  let kept = { ...drag.original, id: drag.mode === 'move' ? drag.id : drag.original.id };
  let lo = 0;
  let hi = 1;
  for (let step = 0; step < 16; step++) {
    const mid = (lo + hi) / 2;
    const candidate = freeShape(drag, toward(mid), modifiers, style);
    if (keepsOnImage(candidate, bounds)) {
      lo = mid;
      kept = candidate;
    } else hi = mid;
  }
  return kept;
}

function freeShape(
  drag: ShapeDrag,
  point: PixelPoint,
  { shift, alt }: ShapeDragModifiers,
  style: ShapeStyle,
): Annotation {
  if (drag.mode === 'draw') {
    const { start, kind } = drag;
    const at = snapToShapeGrid(point, kind, style.width);
    const end = shift ? (kind === 'rectangle' ? square(start, at) : snap45(start, at)) : at;
    const from =
      alt && kind === 'rectangle' ? { x: 2 * start.x - end.x, y: 2 * start.y - end.y } : start;
    return { id: drag.id, kind, start: from, end, ...style };
  }
  const { original } = drag;
  const at =
    drag.mode === 'handle'
      ? snapToShapeGrid(
          { x: point.x + drag.grab.x, y: point.y + drag.grab.y },
          original.kind,
          original.width,
        )
      : snap(point);
  if (drag.mode === 'move') {
    let dx = at.x - drag.start.x;
    let dy = at.y - drag.start.y;
    if (shift) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    return { ...translateAnnotation(original, { x: dx, y: dy }), id: drag.id };
  }
  if (original.kind === 'arrow') {
    const fixed = drag.handle === 'start' ? original.end : original.start;
    const moved = shift ? snap45(fixed, at) : at;
    return drag.handle === 'start' ? { ...original, start: moved } : { ...original, end: moved };
  }
  return resizeRect(original, drag.handle, at, shift);
}

/** A drawn shape too small to see or grab. Releasing one draws nothing. */
export function isDegenerateShape(shape: Annotation): boolean {
  const dx = Math.abs(shape.end.x - shape.start.x);
  const dy = Math.abs(shape.end.y - shape.start.y);
  return shape.kind === 'rectangle'
    ? dx < MIN_SIZE || dy < MIN_SIZE
    : Math.hypot(dx, dy) < MIN_SIZE;
}

/**
 * Whether enough of the shape's stroke lands on the image to see and grab: a run of its centerline
 * at least `KEEP_ON_IMAGE` screen pixels long, or a whole side when that side is shorter. A stroke
 * centered on the image's edge counts, since half of it is drawn there.
 */
export function keepsOnImage(shape: Annotation, bounds: ShapeBounds): boolean {
  const keep = KEEP_ON_IMAGE / bounds.zoom;
  const offset = strokeOffset(shape.width);
  if (shape.kind === 'arrow') {
    const [x0, y0, x1, y1] = [shape.start.x, shape.start.y, shape.end.x, shape.end.y];
    return keepsRun(x0 + offset, y0 + offset, x1 + offset, y1 + offset, keep, bounds);
  }
  const rect = rectOf(shape);
  const x0 = rect.x + offset;
  const y0 = rect.y + offset;
  const x1 = Math.max(x0, rect.x + rect.width - offset);
  const y1 = Math.max(y0, rect.y + rect.height - offset);
  return (
    keepsRun(x0, y0, x1, y0, keep, bounds) ||
    keepsRun(x1, y0, x1, y1, keep, bounds) ||
    keepsRun(x0, y1, x1, y1, keep, bounds) ||
    keepsRun(x0, y0, x0, y1, keep, bounds)
  );
}

/** Clips a centerline to the image, edges included, and measures what is left. */
function keepsRun(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  keep: number,
  { width, height }: ShapeBounds,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const sides: [number, number][] = [
    [-dx, ax],
    [dx, width - ax],
    [-dy, ay],
    [dy, height - ay],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return false;
    } else if (p < 0) t0 = Math.max(t0, q / p);
    else t1 = Math.min(t1, q / p);
    if (t0 > t1) return false;
  }
  const length = Math.hypot(dx, dy);
  // A hair of tolerance so a run of exactly `keep` survives the clipping arithmetic.
  return (t1 - t0) * length >= Math.min(length, keep) - 1e-9;
}
