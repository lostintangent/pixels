import type { KeyPress } from './shortcuts';
import { SHAPES, TOOLS } from './tools';

/**
 * The Shortcuts and gestures sheet's content. Chords use Astryx Kbd syntax (`mod+shift+z`), so
 * the sheet renders them as written and a test can resolve each one through `resolveShortcut`.
 */

/** One step of a way to act: a keycap chord, or a word for the pointer or touch part. */
export type SheetToken = { readonly keys: string } | { readonly text: string };
/** One way to do something, read left to right, such as ⌥ then "drag". */
export type SheetWay = readonly SheetToken[];

export interface SheetRow {
  readonly label: string;
  /** Alternatives, shown in order with "or" between them. */
  readonly ways: readonly SheetWay[];
  /** The ways name the label's parts in order, such as Copy, Cut, Paste, rather than alternatives. */
  readonly isList?: boolean;
  /** Every key chord this row stands for, including ones it doesn't show. Empty for pointer rows. */
  readonly chords: readonly string[];
}

export interface SheetGroup {
  readonly title: string;
  readonly input: 'keys' | 'touch';
  readonly rows: readonly SheetRow[];
}

/** Keys the resolver also takes under another name: = beside +, and Delete beside ⌫. */
const ALSO: Readonly<Record<string, readonly string[]>> = {
  plus: ['='],
  backspace: ['delete'],
};
/**
 * Keys that resolve with or without Shift: ones Shift types on most layouts, and ones where a
 * Shift still held from a drag shouldn't swallow the press.
 */
const SHIFT_OPTIONAL = new Set(['?', 'plus', 'enter', 'escape', 'backspace', 'delete']);

function expand(chord: string): string[] {
  const parts = chord.split('+');
  const key = parts.pop()!;
  const names = [key, ...(ALSO[key] ?? [])];
  return names.flatMap((name) => {
    const chord = [...parts, name].join('+');
    if (!SHIFT_OPTIONAL.has(name) || parts.includes('shift')) return [chord];
    return [chord, [...parts, 'shift', name].join('+')];
  });
}

/** A row of key chords, each one its own way. */
function keys(label: string, ...shown: string[]): SheetRow {
  return { label, ways: shown.map((chord) => [{ keys: chord }]), chords: shown.flatMap(expand) };
}

/** A row whose chords each do one part of the label, in order. */
function each(label: string, ...shown: string[]): SheetRow {
  return { ...keys(label, ...shown), isList: true };
}

/** A row the pointer or touch completes, so it has no chord of its own. */
function act(label: string, ...ways: SheetWay[]): SheetRow {
  return { label, ways, chords: [] };
}

const k = (chord: string): SheetToken => ({ keys: chord });
const t = (text: string): SheetToken => ({ text });
const ARROWS = ['left', 'up', 'down', 'right'] as const;

export const SHEET_GROUPS: readonly SheetGroup[] = [
  {
    title: 'Tools',
    input: 'keys',
    rows: [...TOOLS, ...SHAPES].map((tool) => keys(tool.label, tool.key)),
  },
  {
    title: 'Drawing',
    input: 'keys',
    rows: [
      each('Brush size', '[', ']'),
      keys('Swap colors', 'x'),
      act('Eyedropper', [t('Hold'), k('alt')]),
      act('Snap angle or square', [k('shift'), t('drag')]),
      act('Rectangle from center', [k('alt'), t('drag')]),
    ],
  },
  {
    title: 'Selection and shapes',
    input: 'keys',
    rows: [
      keys('Select all', 'mod+a'),
      each('Copy, cut, paste', 'mod+c', 'mod+x', 'mod+v'),
      keys('Duplicate shape', 'mod+d'),
      act('Move a copy', [k('alt'), t('drag')]),
      {
        label: 'Nudge',
        ways: [ARROWS.map(k)],
        chords: [...ARROWS],
      },
      {
        label: 'Nudge 10 px',
        ways: [[k('shift'), ...ARROWS.map(k)]],
        chords: ARROWS.map((arrow) => `shift+${arrow}`),
      },
      keys('Done', 'enter'),
      keys('Cancel or deselect', 'escape', 'mod+d'),
      keys('Delete', 'backspace'),
    ],
  },
  {
    title: 'View',
    input: 'keys',
    rows: [
      keys('Zoom in', 'mod+plus', 'plus'),
      keys('Zoom out', 'mod+\u2212', '\u2212'),
      keys('Fit to screen', 'mod+0', '0'),
      keys('Actual size', 'mod+1', '1'),
      keys('Pixel grid', "mod+'"),
      keys('Hide or show chrome', 'tab'),
      act('Pan', [k('space'), t('drag')], [t('Two-finger scroll')]),
      act('Zoom at pointer', [k('mod'), t('scroll')], [t('Pinch')]),
    ],
  },
  {
    title: 'History',
    input: 'keys',
    rows: [keys('Undo', 'mod+z'), keys('Redo', 'mod+shift+z', 'mod+y')],
  },
  {
    title: 'Document',
    input: 'keys',
    rows: [
      keys('New canvas', 'mod+alt+n'),
      keys('Open PNG', 'mod+o'),
      keys('Export PNG', 'mod+shift+e'),
      keys('Resize canvas', 'mod+alt+c'),
      keys('Shortcuts and gestures', '?'),
    ],
  },
  {
    title: 'Touch',
    input: 'touch',
    rows: [
      act('Draw', [t('One finger or pen')]),
      act('Pan and zoom', [t('Two fingers')]),
      act('Undo', [t('Two-finger tap')]),
      act('Redo', [t('Three-finger tap')]),
      act('With a pen', [t('Fingers pan and zoom')]),
      act('Eyedropper', [t('Picks once, then returns')]),
    ],
  },
];

/** Gestures lead where touch is the main input, and keys lead where a mouse or trackpad is. */
export function sheetGroups(pointer: 'fine' | 'coarse'): readonly SheetGroup[] {
  if (pointer === 'fine') return SHEET_GROUPS;
  return [
    ...SHEET_GROUPS.filter((group) => group.input === 'touch'),
    ...SHEET_GROUPS.filter((group) => group.input !== 'touch'),
  ];
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  plus: '+',
  '\u2212': '-',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  tab: 'Tab',
  space: ' ',
};

/** Reads a Kbd chord as the key press it stands for. */
export function parseChord(chord: string): KeyPress {
  const parts = chord.split('+');
  const key = parts.pop()!;
  return {
    key: NAMED_KEYS[key] ?? key,
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  };
}
