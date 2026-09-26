import type { PackedColor } from '../document';

export interface PaletteState {
  primary: PackedColor;
  secondary: PackedColor;
  recent: readonly PackedColor[];
}

export type { Hsv } from './core/color';
export {
  alpha,
  formatColor,
  fromHsv,
  parseHex,
  toCss,
  toHex,
  toHsv,
  toHsvKeepingHue,
  TRANSPARENT,
} from './core/color';
export { DEFAULT_PALETTE, RECENT_LIMIT, rememberColor } from './core/palette';
export { ColorPanel } from './ui/ColorPanel';
export { ColorPicker } from './ui/ColorPicker';
export { ColorPickerPopover } from './ui/ColorPickerPopover';
export { ColorSheet } from './ui/ColorSheet';
export { ColorWell } from './ui/ColorWell';
export { Swatches } from './ui/Swatches';
export type { SwatchSlot } from './ui/Swatches';
