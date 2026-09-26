import type { PackedColor } from '../../document';
import { parseHex } from './color';

export const RECENT_LIMIT = 8;

const hex = (value: string): PackedColor => {
  const color = parseHex(value);
  if (color === null) throw new Error(`Invalid palette color ${value}`);
  return color;
};

/** A neutral ramp, then warm, green and teal, and cool and violet ramps. Eight per row. */
export const DEFAULT_PALETTE: readonly PackedColor[] = [
  '#000000',
  '#1f1d2b',
  '#3d3b4f',
  '#6b6a80',
  '#9c9bb0',
  '#c9c8d6',
  '#ecebf2',
  '#ffffff',
  '#3b1f2b',
  '#7a2e3a',
  '#c2413b',
  '#e8553d',
  '#f59a5b',
  '#ffd08a',
  '#fff1c4',
  '#8c5a3c',
  '#1e3a2f',
  '#2f6b3f',
  '#4f9d4a',
  '#93c95b',
  '#d7ef8f',
  '#16464f',
  '#1f8a8a',
  '#58d0c0',
  '#1b2451',
  '#2c4cb0',
  '#4a8ff0',
  '#9fd3ff',
  '#3c2266',
  '#7a44c9',
  '#c47ae0',
  '#f28fb5',
].map(hex);

/** Most recent first, without duplicates, capped at `limit`. */
export function rememberColor(
  recent: readonly PackedColor[],
  color: PackedColor,
  limit = RECENT_LIMIT,
): readonly PackedColor[] {
  if (recent[0] === color) return recent;
  return [color, ...recent.filter((entry) => entry !== color)].slice(0, limit);
}
