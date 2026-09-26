import type { PixelRect } from '../../document';

export function segmentBounds(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
): PixelRect {
  const before = Math.floor((size - 1) / 2);
  const after = size - before - 1;
  const x = Math.min(x0, x1) - before;
  const y = Math.min(y0, y1) - before;
  return {
    x,
    y,
    width: Math.max(x0, x1) + after - x + 1,
    height: Math.max(y0, y1) + after - y + 1,
  };
}

export function paintSquare(
  pixels: Uint32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  size: number,
  color: number,
): number {
  const before = Math.floor((size - 1) / 2);
  const left = Math.max(0, x - before);
  const top = Math.max(0, y - before);
  const right = Math.min(width, x - before + size);
  const bottom = Math.min(height, y - before + size);
  let changed = 0;
  for (let row = top; row < bottom; row++) {
    let index = row * width + left;
    const end = row * width + right;
    while (index < end) {
      if (pixels[index] !== color) {
        pixels[index] = color;
        changed++;
      }
      index++;
    }
  }
  return changed;
}

export function rasterLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  plot: (x: number, y: number) => void,
): void {
  let dx = Math.abs(x1 - x0);
  let dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  while (true) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const twice = error * 2;
    if (twice >= dy) {
      error += dy;
      x0 += sx;
    }
    if (twice <= dx) {
      error += dx;
      y0 += sy;
    }
  }
}
