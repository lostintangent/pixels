/** Palette's framework-free entry: color math and palette state, safe to import from any core. */
import type { PackedColor } from '../document';

export interface PaletteState {
  primary: PackedColor;
  secondary: PackedColor;
  recent: readonly PackedColor[];
}

export { alpha, formatColor, toCss, TRANSPARENT } from './core/color';
export { DEFAULT_PALETTE, RECENT_LIMIT, rememberColor } from './core/palette';
