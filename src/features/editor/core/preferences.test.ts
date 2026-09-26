import { describe, expect, test } from 'bun:test';
import { packRgba } from '../../document';
import { RECENT_LIMIT } from '../../palette/model';
import { decodeToolPreferences, sameToolPreferences } from './preferences';
import { DEFAULT_TOOL_PREFERENCES } from './state';
import type { ToolPreferences } from './state';

const red = packRgba(255, 0, 0, 255);
const blue = packRgba(0, 0, 255, 255);

const saved: ToolPreferences = {
  tool: 'fill',
  brushSize: 8,
  primary: red,
  secondary: blue,
  recent: [red, blue],
  gridEnabled: false,
};

describe('decodeToolPreferences', () => {
  test('restores preferences that survive a JSON round trip', () => {
    expect(decodeToolPreferences(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  test('falls back to defaults for anything that is not an object', () => {
    for (const value of [null, undefined, 'pencil', 3, true])
      expect(decodeToolPreferences(value)).toEqual(DEFAULT_TOOL_PREFERENCES);
  });

  test('replaces only the fields that are no longer valid', () => {
    const decoded = decodeToolPreferences({ ...saved, tool: 'airbrush', brushSize: 7 });
    expect(decoded).toEqual({
      ...saved,
      tool: DEFAULT_TOOL_PREFERENCES.tool,
      brushSize: DEFAULT_TOOL_PREFERENCES.brushSize,
    });
  });

  test('rejects colors outside 32-bit unsigned integers', () => {
    for (const color of [-1, 0x1_0000_0000, 1.5, '#ff0000']) {
      const decoded = decodeToolPreferences({ ...saved, primary: color, secondary: color });
      expect(decoded.primary).toBe(DEFAULT_TOOL_PREFERENCES.primary);
      expect(decoded.secondary).toBe(DEFAULT_TOOL_PREFERENCES.secondary);
    }
    expect(decodeToolPreferences({ ...saved, primary: 0 }).primary).toBe(0);
  });

  test('keeps valid recents in order, without repeats, up to the limit', () => {
    const many = Array.from({ length: RECENT_LIMIT + 4 }, (_, i) => packRgba(i, 0, 0, 255));
    expect(decodeToolPreferences({ recent: [red, 'x', red, blue, -1] }).recent).toEqual([
      red,
      blue,
    ]);
    expect(decodeToolPreferences({ recent: many }).recent).toEqual(many.slice(0, RECENT_LIMIT));
  });
});

describe('sameToolPreferences', () => {
  test('compares recents by value', () => {
    expect(sameToolPreferences(saved, { ...saved, recent: [red, blue] })).toBe(true);
    expect(sameToolPreferences(saved, { ...saved, recent: [blue, red] })).toBe(false);
    expect(sameToolPreferences(saved, { ...saved, gridEnabled: true })).toBe(false);
  });
});
