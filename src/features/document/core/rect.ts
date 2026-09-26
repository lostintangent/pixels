import type { PixelRect } from './contracts';

export function intersectRect(
  rect: PixelRect,
  bounds: PixelRect,
  out: PixelRect,
): PixelRect | null {
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
  if (right <= x || bottom <= y) return null;
  out.x = x;
  out.y = y;
  out.width = right - x;
  out.height = bottom - y;
  return out;
}

export function unionRect(a: PixelRect, b: PixelRect, out: PixelRect): PixelRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  out.x = x;
  out.y = y;
  out.width = right - x;
  out.height = bottom - y;
  return out;
}

export function fullRect(width: number, height: number): PixelRect {
  return { x: 0, y: 0, width, height };
}
