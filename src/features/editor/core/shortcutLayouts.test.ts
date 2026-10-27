import { describe, expect, test } from 'bun:test';
import { resolveShortcut } from './shortcuts';
import type { EditorCommand, KeyPress } from './shortcuts';

const idle = { hasSelection: false };
const selected = { hasSelection: true };

function press(
  key: string,
  code: string,
  flags: Partial<Pick<KeyPress, 'mod' | 'shift' | 'alt' | 'altGraph'>> = {},
): KeyPress {
  return { key, code, mod: false, shift: false, alt: false, ...flags };
}

const sizeUp: EditorCommand = { type: 'brush-size', direction: 1 };
const sizeDown: EditorCommand = { type: 'brush-size', direction: -1 };
const fit: EditorCommand = { type: 'zoom-fit' };
const actual: EditorCommand = { type: 'zoom-actual' };

describe('keyboard layouts', () => {
  const cases: readonly [string, KeyPress, EditorCommand | null][] = [
    ['US right bracket', press(']', 'BracketRight'), sizeUp],
    ['US left bracket', press('[', 'BracketLeft'), sizeDown],
    ['German Option+6 types right bracket', press(']', 'Digit6', { alt: true }), sizeUp],
    ['German Option+5 types left bracket', press('[', 'Digit5', { alt: true }), sizeDown],
    [
      'French Shift+Option+) types right bracket',
      press(']', 'Minus', { shift: true, alt: true }),
      sizeUp,
    ],
    ['Swedish Option+9 types right bracket', press(']', 'Digit9', { alt: true }), sizeUp],
    ['Spanish Option+bracket', press('[', 'BracketLeft', { alt: true }), sizeDown],
    ['Italian Option+bracket', press(']', 'BracketRight', { alt: true }), sizeUp],
    [
      'Swiss AltGr types right bracket',
      press(']', 'Digit9', { mod: true, alt: true, altGraph: true }),
      sizeUp,
    ],
    [
      'Windows AltGr types left bracket',
      press('[', 'Digit8', { mod: true, alt: true, altGraph: true }),
      sizeDown,
    ],
    ['US 0 fits', press('0', 'Digit0'), fit],
    ['French AZERTY Shift+à types 0', press('0', 'Digit0', { shift: true }), fit],
    ['US 1 shows actual size', press('1', 'Digit1'), actual],
    ['French AZERTY Shift+& types 1', press('1', 'Digit1', { shift: true }), actual],
    ['Russian у on KeyE', press('у', 'KeyE'), { type: 'tool', tool: 'eraser' }],
    ['Russian и on KeyB', press('и', 'KeyB'), { type: 'tool', tool: 'pencil' }],
    ['Greek ε on KeyE', press('ε', 'KeyE'), { type: 'tool', tool: 'eraser' }],
    ['AZERTY Latin letter follows key', press('b', 'KeyN'), { type: 'tool', tool: 'pencil' }],
    ['Dvorak Latin letter follows key', press('e', 'KeyD'), { type: 'tool', tool: 'eraser' }],
    [
      'German Shift+ß types question mark',
      press('?', 'Minus', { shift: true }),
      { type: 'open', panel: 'shortcuts' },
    ],
    ['US Command+quote toggles grid', press("'", 'Quote', { mod: true }), { type: 'toggle-grid' }],
    [
      'German Command+Shift+# types quote',
      press("'", 'Backslash', { mod: true, shift: true }),
      { type: 'toggle-grid' },
    ],
    ['German plus key zooms', press('+', 'BracketRight'), { type: 'zoom', direction: 1 }],
    ['US shifted digit types punctuation', press(')', 'Digit0', { shift: true }), null],
    ['US shifted bracket types brace', press('{', 'BracketLeft', { shift: true }), null],
    ['Option+letter alone is not a tool', press('ç', 'KeyC', { alt: true }), null],
    [
      'AltGr letter is not a tool',
      press('€', 'KeyE', { mod: true, alt: true, altGraph: true }),
      null,
    ],
    [
      'Command+Option+Shift remains unbound',
      press('n', 'KeyN', { mod: true, alt: true, shift: true }),
      null,
    ],
    [
      'Command+Shift+Z still redoes',
      press('Z', 'KeyZ', { mod: true, shift: true }),
      { type: 'redo' },
    ],
    [
      'Command+Option+N uses physical letter',
      press('Dead', 'KeyN', { mod: true, alt: true }),
      { type: 'open', panel: 'new' },
    ],
    [
      'Command+Option+C uses physical letter',
      press('ç', 'KeyC', { mod: true, alt: true }),
      { type: 'open', panel: 'resize' },
    ],
    [
      'Firefox Mac Command+Option+N reports AltGraph',
      press('Dead', 'KeyN', { mod: true, alt: true, altGraph: true }),
      { type: 'open', panel: 'new' },
    ],
    [
      'Firefox Mac Command+Option+C reports AltGraph',
      press('ç', 'KeyC', { mod: true, alt: true, altGraph: true }),
      { type: 'open', panel: 'resize' },
    ],
    [
      'Firefox Mac Option+B reports AltGraph',
      press('∫', 'KeyB', { alt: true, altGraph: true }),
      null,
    ],
    [
      'Firefox Mac German Option+5 types left bracket',
      press('[', 'Digit5', { alt: true, altGraph: true }),
      sizeDown,
    ],
    [
      'Firefox Windows Control+Alt+N reports AltGraph',
      press('n', 'KeyN', { mod: true, alt: true, altGraph: true }),
      { type: 'open', panel: 'new' },
    ],
    [
      'Firefox Windows Control+Alt+B is not Pencil',
      press('b', 'KeyB', { mod: true, alt: true, altGraph: true }),
      null,
    ],
  ];

  for (const [name, input, expected] of cases)
    test(name, () => expect(resolveShortcut(input, idle)).toEqual(expected));

  test('Shift+arrow retains ten-pixel nudge', () => {
    expect(resolveShortcut(press('ArrowRight', 'ArrowRight', { shift: true }), selected)).toEqual({
      type: 'nudge',
      dx: 10,
      dy: 0,
    });
  });
});
