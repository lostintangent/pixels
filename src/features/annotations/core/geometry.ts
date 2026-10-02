import type { PixelPoint } from '../../document';
import type { Annotation, AnnotationHandle, AnnotationHandleId } from './contracts';

export interface RectangleGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectOf(shape: Annotation): RectangleGeometry {
  return {
    x: Math.min(shape.start.x, shape.end.x),
    y: Math.min(shape.start.y, shape.end.y),
    width: Math.abs(shape.end.x - shape.start.x),
    height: Math.abs(shape.end.y - shape.start.y),
  };
}

export function arrowGeom(shape: Annotation) {
  const dx = shape.end.x - shape.start.x;
  const dy = shape.end.y - shape.start.y;
  const length = Math.hypot(dx, dy);
  const ux = length ? dx / length : 1;
  const uy = length ? dy / length : 0;
  // Width 6 keeps the prototype's 28 px head, while width 1 stays useful on sprites.
  const head = Math.min(length * 0.5, shape.width * 4.7);
  const half = head * 0.42 + shape.width * 0.3;
  const baseX = shape.end.x - ux * head;
  const baseY = shape.end.y - uy * head;
  return {
    length,
    head,
    half,
    base: { x: baseX, y: baseY },
    left: { x: baseX - uy * half, y: baseY + ux * half },
    right: { x: baseX + uy * half, y: baseY - ux * half },
  };
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
    : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** No allocation on the 200-shape hit-test path. */
export function hitShape(
  shape: Annotation,
  point: PixelPoint,
  tolerance: number,
  selected = false,
): boolean {
  const halfStroke = shape.width / 2 + tolerance;
  if (shape.kind === 'rectangle') {
    const x0 = Math.min(shape.start.x, shape.end.x);
    const x1 = Math.max(shape.start.x, shape.end.x);
    const y0 = Math.min(shape.start.y, shape.end.y);
    const y1 = Math.max(shape.start.y, shape.end.y);
    if (
      point.x < x0 - halfStroke ||
      point.x > x1 + halfStroke ||
      point.y < y0 - halfStroke ||
      point.y > y1 + halfStroke
    )
      return false;
    if (selected) return true;
    return !(
      point.x > x0 + halfStroke &&
      point.x < x1 - halfStroke &&
      point.y > y0 + halfStroke &&
      point.y < y1 - halfStroke
    );
  }
  const ax = shape.start.x;
  const ay = shape.start.y;
  const bx = shape.end.x;
  const by = shape.end.y;
  if (distanceToSegment(point.x, point.y, ax, ay, bx, by) <= halfStroke) return true;
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  const ux = length ? dx / length : 1;
  const uy = length ? dy / length : 0;
  const head = Math.min(length * 0.5, shape.width * 4.7);
  const half = head * 0.42 + shape.width * 0.3;
  return (
    distanceToSegment(point.x, point.y, bx - ux * head, by - uy * head, bx, by) <=
    half * 0.8 + tolerance
  );
}

export function handlesOf(shape: Annotation, zoom: number, coarse: boolean): AnnotationHandle[] {
  if (shape.kind === 'arrow') {
    return [
      { id: 'start', x: shape.start.x, y: shape.start.y },
      { id: 'end', x: shape.end.x, y: shape.end.y },
    ];
  }
  const rect = rectOf(shape);
  const x1 = rect.x + rect.width;
  const y1 = rect.y + rect.height;
  const handles: AnnotationHandle[] = [
    { id: 'nw', x: rect.x, y: rect.y },
    { id: 'ne', x: x1, y: rect.y },
    { id: 'se', x: x1, y: y1 },
    { id: 'sw', x: rect.x, y: y1 },
  ];
  const minimum = coarse ? 88 : 40;
  if (rect.width * zoom >= minimum) {
    const cx = rect.x + rect.width / 2;
    handles.push({ id: 'n', x: cx, y: rect.y }, { id: 's', x: cx, y: y1 });
  }
  if (rect.height * zoom >= minimum) {
    const cy = rect.y + rect.height / 2;
    handles.push({ id: 'e', x: x1, y: cy }, { id: 'w', x: rect.x, y: cy });
  }
  return handles;
}

/** Touch centers move outward until a 24 screen-pixel body remains grabbable. */
export function targetsOf(shape: Annotation, zoom: number, coarse: boolean): AnnotationHandle[] {
  const handles = handlesOf(shape, zoom, coarse);
  if (!coarse) return handles;
  const keep = 44 + 24;
  if (shape.kind === 'arrow') {
    const dx = shape.end.x - shape.start.x;
    const dy = shape.end.y - shape.start.y;
    const length = Math.hypot(dx, dy);
    const push = Math.max(0, (keep - length * zoom) / 2) / zoom;
    const ux = length ? dx / length : 1;
    const uy = length ? dy / length : 0;
    return handles.map((handle) =>
      handle.id === 'start'
        ? { ...handle, x: handle.x - ux * push, y: handle.y - uy * push }
        : { ...handle, x: handle.x + ux * push, y: handle.y + uy * push },
    );
  }
  const rect = rectOf(shape);
  const pushX = Math.max(0, (keep - rect.width * zoom) / 2) / zoom;
  const pushY = Math.max(0, (keep - rect.height * zoom) / 2) / zoom;
  return handles.map((handle) => ({
    ...handle,
    x: handle.x + (handle.id.includes('w') ? -pushX : handle.id.includes('e') ? pushX : 0),
    y: handle.y + (handle.id.includes('n') ? -pushY : handle.id.includes('s') ? pushY : 0),
  }));
}

export function snap45(start: PixelPoint, point: PixelPoint): PixelPoint {
  const dx = point.x - start.x;
  const dy = point.y - start.y;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const length = Math.hypot(dx, dy);
  return {
    x: Math.round(start.x + Math.cos(angle) * length),
    y: Math.round(start.y + Math.sin(angle) * length),
  };
}

export function square(start: PixelPoint, point: PixelPoint): PixelPoint {
  const side = Math.max(Math.abs(point.x - start.x), Math.abs(point.y - start.y));
  return {
    x: start.x + Math.sign(point.x - start.x || 1) * side,
    y: start.y + Math.sign(point.y - start.y || 1) * side,
  };
}

export function resizeRect(
  original: Annotation,
  handle: AnnotationHandleId,
  point: PixelPoint,
  shift: boolean,
): Annotation {
  const rect = rectOf(original);
  let x0 = rect.x;
  let y0 = rect.y;
  let x1 = rect.x + rect.width;
  let y1 = rect.y + rect.height;
  if (handle.includes('w')) x0 = point.x;
  if (handle.includes('e')) x1 = point.x;
  if (handle.includes('n')) y0 = point.y;
  if (handle.includes('s')) y1 = point.y;
  if (shift && handle.length === 2) {
    const fixed = { x: handle.includes('w') ? x1 : x0, y: handle.includes('n') ? y1 : y0 };
    const squared = square(fixed, {
      x: handle.includes('w') ? x0 : x1,
      y: handle.includes('n') ? y0 : y1,
    });
    return { ...original, start: fixed, end: squared };
  }
  return { ...original, start: { x: x0, y: y0 }, end: { x: x1, y: y1 } };
}
