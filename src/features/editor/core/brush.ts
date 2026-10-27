/**
 * Brush sizes are a ladder, not a linear range. Most pixel work happens from 1 to 4 px, so
 * those get a full step each and larger sizes thin out. A slider over the ladder's indices
 * gives 1 to 4 px about a third of the track.
 */
export const BRUSH_SIZES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32, 48, 64] as const;

/** The index of the largest step at or below `size`. */
export function brushSizeIndex(size: number): number {
  let index = 0;
  for (let i = 0; i < BRUSH_SIZES.length; i++) if (BRUSH_SIZES[i]! <= size) index = i;
  return index;
}

export function brushSizeAt(index: number): number {
  const clamped = Math.min(BRUSH_SIZES.length - 1, Math.max(0, Math.round(index)));
  return BRUSH_SIZES[clamped]!;
}

export function stepBrushSize(size: number, direction: -1 | 1): number {
  const index = brushSizeIndex(size);
  if (direction < 0 && BRUSH_SIZES[index]! < size) return BRUSH_SIZES[index]!;
  return brushSizeAt(index + direction);
}
