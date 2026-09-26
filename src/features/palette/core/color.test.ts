import { describe, expect, test } from 'bun:test';
import { packRgba } from '../../document';
import {
  formatColor,
  fromHsv,
  parseHex,
  toCss,
  toHex,
  toHsv,
  toHsvKeepingHue,
  TRANSPARENT,
} from './color';
import { DEFAULT_PALETTE, rememberColor } from './palette';

describe('hex', () => {
  test('parses six and three digit hex with or without a hash', () => {
    expect(parseHex('#e8553d')).toBe(packRgba(0xe8, 0x55, 0x3d));
    expect(parseHex('E8553D')).toBe(packRgba(0xe8, 0x55, 0x3d));
    expect(parseHex(' #fa0 ')).toBe(packRgba(0xff, 0xaa, 0x00));
  });

  test('rejects anything else', () => {
    for (const input of ['', '#', '#12345', '#1234567', 'ggg', '#e8553dff'])
      expect(parseHex(input)).toBeNull();
  });

  test('round-trips through hex and formats for display', () => {
    const color = packRgba(0x12, 0xab, 0xef);
    expect(toHex(color)).toBe('#12abef');
    expect(formatColor(color)).toBe('#12ABEF');
    expect(formatColor(TRANSPARENT)).toBe('Transparent');
  });

  test('css keeps partial alpha', () => {
    expect(toCss(packRgba(255, 0, 0))).toBe('#ff0000');
    expect(toCss(packRgba(255, 0, 0, 0))).toBe('rgb(255 0 0 / 0)');
  });
});

describe('hsv', () => {
  test('round-trips every palette color exactly', () => {
    for (const color of DEFAULT_PALETTE) expect(fromHsv(toHsv(color))).toBe(color);
  });

  test('maps primaries to their hues', () => {
    expect(toHsv(packRgba(255, 0, 0))).toEqual({ h: 0, s: 1, v: 1 });
    expect(toHsv(packRgba(0, 255, 0)).h).toBe(120);
    expect(toHsv(packRgba(0, 0, 255)).h).toBe(240);
  });

  test('keeps the previous hue for greys and black', () => {
    const previous = { h: 200, s: 0.5, v: 0.5 };
    expect(toHsvKeepingHue(packRgba(0, 0, 0), previous)).toEqual({ h: 200, s: 0, v: 0 });
    expect(toHsvKeepingHue(packRgba(128, 128, 128), previous).h).toBe(200);
    expect(toHsvKeepingHue(packRgba(255, 0, 0), previous).h).toBe(0);
  });
});

describe('recent colors', () => {
  const [a, b, c] = [1, 2, 3].map((n) => packRgba(n, n, n));

  test('puts the newest first without duplicates', () => {
    expect(rememberColor([a!, b!], c!)).toEqual([c!, a!, b!]);
    expect(rememberColor([a!, b!, c!], b!)).toEqual([b!, a!, c!]);
  });

  test('returns the same list when the color is already newest', () => {
    const recent = [a!, b!];
    expect(rememberColor(recent, a!)).toBe(recent);
  });

  test('caps the list', () => {
    expect(rememberColor([a!, b!], c!, 2)).toEqual([c!, a!]);
  });
});
