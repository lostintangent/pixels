import { packRgba } from '../../document';
import type { DocumentColorSpace, PackedColor } from '../../document';

/** Hue in degrees [0, 360), saturation and value in [0, 1]. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

export const TRANSPARENT: PackedColor = 0;

export const red = (color: PackedColor) => color & 255;
export const green = (color: PackedColor) => (color >>> 8) & 255;
export const blue = (color: PackedColor) => (color >>> 16) & 255;
export const alpha = (color: PackedColor) => color >>> 24;

const byteHex = (value: number) => value.toString(16).padStart(2, '0');

/** `#rrggbb`, ignoring alpha. */
export function toHex(color: PackedColor): string {
  return `#${byteHex(red(color))}${byteHex(green(color))}${byteHex(blue(color))}`;
}

/** Display form: `#E8553D`, or `Transparent` for fully transparent pixels. */
export function formatColor(color: PackedColor): string {
  return alpha(color) === 0 ? 'Transparent' : toHex(color).toUpperCase();
}

const unit = (byte: number) => Math.round((byte / 255) * 1e4) / 1e4;

/**
 * CSS for a color's bytes in the document's color space, so a swatch shows exactly what the
 * canvas paints. Four decimals round-trip every byte.
 */
export function toCss(color: PackedColor, colorSpace: DocumentColorSpace = 'srgb'): string {
  const a = alpha(color);
  if (colorSpace === 'display-p3')
    return `color(display-p3 ${unit(red(color))} ${unit(green(color))} ${unit(blue(color))} / ${unit(a)})`;
  if (a === 255) return toHex(color);
  return `rgb(${red(color)} ${green(color)} ${blue(color)} / ${Math.round((a / 255) * 1000) / 1000})`;
}

/** Accepts `rgb`, `rrggbb`, with or without `#`, case-insensitive. Returns an opaque color. */
export function parseHex(input: string): PackedColor | null {
  const digits = input.trim().replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(digits)) return null;
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits;
  const value = Number.parseInt(full, 16);
  return packRgba((value >> 16) & 255, (value >> 8) & 255, value & 255);
}

/**
 * What a hex field's text means while someone types. Six digits can only be one color, so they
 * apply live. Three digits are also the start of six, so they wait for Enter or blur. A prefix of
 * a valid entry is still in progress, not an error.
 */
type HexDraft =
  | { kind: 'complete'; color: PackedColor }
  | { kind: 'short'; color: PackedColor }
  | { kind: 'partial' }
  | { kind: 'invalid' };

export function readHexDraft(input: string): HexDraft {
  const digits = input.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{0,6}$/i.test(digits)) return { kind: 'invalid' };
  const color = parseHex(digits);
  if (color === null) return { kind: 'partial' };
  return digits.length === 6 ? { kind: 'complete', color } : { kind: 'short', color };
}

export function toHsv(color: PackedColor): Hsv {
  const r = red(color) / 255;
  const g = green(color) / 255;
  const b = blue(color) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function fromHsv({ h, s, v }: Hsv): PackedColor {
  const chroma = v * s;
  const sector = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r, g, b] =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = v - chroma;
  return packRgba(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255));
}

/**
 * Converting a grey or black back to HSV loses its hue. Keep the previous hue so dragging
 * through the bottom or left edge of the picker never snaps the hue rail to red.
 */
export function toHsvKeepingHue(color: PackedColor, previous: Hsv): Hsv {
  const next = toHsv(color);
  if (next.s === 0 || next.v === 0) return { h: previous.h, s: next.s, v: next.v };
  return next;
}
