import { describe, expect, test } from 'bun:test';
import { parseChord, SHEET_GROUPS, sheetGroups } from './shortcutSheet';
import { resolveShortcut } from './shortcuts';
import type { KeyPress, ShortcutContext } from './shortcuts';
import { SHAPES, TOOLS } from './tools';

const CONTEXTS: readonly ShortcutContext[] = [
  { hasSelection: false },
  { hasSelection: true },
  { hasSelection: false, hasShapeSelection: true },
  { hasSelection: true, gesturing: true },
];

const NAMED = [
  'Escape',
  'Enter',
  'Tab',
  'Delete',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'F1',
];
const PRINTABLE = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index));

/** One name per distinct press. Letters fold, since the resolver ignores their case. */
function chordId(press: KeyPress): string {
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key;
  return [press.mod && 'mod', press.alt && 'alt', press.shift && 'shift', key]
    .filter(Boolean)
    .join('+');
}

const resolves = (press: KeyPress) =>
  CONTEXTS.some((context) => resolveShortcut(press, context) !== null);

const rows = SHEET_GROUPS.flatMap((group) => group.rows);
const listed = new Set(
  rows.flatMap((row) => row.chords.map((chord) => chordId(parseChord(chord)))),
);

describe('shortcut sheet', () => {
  test('lists every chord the keyboard resolves', () => {
    const missing: string[] = [];
    for (const key of [...PRINTABLE, ...NAMED])
      for (let bits = 0; bits < 8; bits++) {
        const press = {
          key,
          mod: (bits & 1) !== 0,
          shift: (bits & 2) !== 0,
          alt: (bits & 4) !== 0,
        };
        if (resolves(press) && !listed.has(chordId(press))) missing.push(chordId(press));
      }
    expect([...new Set(missing)]).toEqual([]);
  });

  test('every listed chord resolves', () => {
    const dead = rows.flatMap((row) =>
      row.chords
        .filter((chord) => !resolves(parseChord(chord)))
        .map((chord) => `${row.label}: ${chord}`),
    );
    expect(dead).toEqual([]);
  });

  test('every tool and shape is listed by its key', () => {
    const tools = SHEET_GROUPS.find((group) => group.title === 'Tools')!;
    expect(tools.rows.map((row) => row.label)).toEqual(
      [...TOOLS, ...SHAPES].map((tool) => tool.label),
    );
  });

  test('pointer rows carry no chords, and every key row shows a keycap', () => {
    for (const group of SHEET_GROUPS)
      for (const row of group.rows) {
        const shown = row.ways.flat().filter((token) => 'keys' in token);
        if (row.chords.length > 0) expect(shown.length).toBeGreaterThan(0);
        if (group.input === 'touch') expect(row.chords).toEqual([]);
      }
  });

  test('touch leads on a coarse pointer and trails on a fine one', () => {
    expect(sheetGroups('coarse')[0]!.input).toBe('touch');
    expect(sheetGroups('fine').at(-1)!.input).toBe('touch');
    expect(sheetGroups('coarse')).toHaveLength(SHEET_GROUPS.length);
  });

  test('parses Kbd chords', () => {
    expect(parseChord('mod+shift+z')).toEqual({ key: 'z', mod: true, shift: true, alt: false });
    expect(parseChord('mod+\u2212')).toEqual({ key: '-', mod: true, shift: false, alt: false });
    expect(parseChord('plus').key).toBe('+');
    expect(parseChord('shift+left').key).toBe('ArrowLeft');
  });
});
