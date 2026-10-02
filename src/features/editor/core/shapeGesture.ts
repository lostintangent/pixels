import {
  hitAnnotationSet,
  resizeRect,
  snap45,
  snapToShapeGrid,
  square,
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
  | { mode: 'handle'; original: Annotation; handle: AnnotationHandleId; start: PixelPoint };

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
  if (target.handle)
    return { mode: 'handle', original: target.shape, handle: target.handle, start };
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

/**
 * The shape a drag shows at `point`. Shift squares a rectangle, snaps an arrow to 45°, and locks a
 * move to one axis. Option draws a rectangle out from its center.
 */
export function liveShape(
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
    drag.mode === 'handle' ? snapToShapeGrid(point, original.kind, original.width) : snap(point);
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
