import type { PackedColor } from '../document';
export interface PaletteState {
  primary: PackedColor;
  secondary: PackedColor;
  recent: readonly PackedColor[];
}
