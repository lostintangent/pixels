import type { ToolKind } from '../../tools';
import { SHAPES, TOOLS } from './tools';
import type { ShapeKind } from './tools';

export type EditorCommand =
  | { type: 'tool'; tool: ToolKind }
  | { type: 'shape-tool'; kind: ShapeKind }
  | { type: 'shape'; action: ShapeAction }
  | { type: 'swap-colors' }
  | { type: 'brush-size'; direction: -1 | 1 }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'zoom'; direction: -1 | 1 }
  | { type: 'zoom-fit' }
  | { type: 'zoom-actual' }
  | { type: 'toggle-grid' }
  | { type: 'toggle-chrome' }
  | { type: 'open'; panel: 'new' | 'export' | 'resize' | 'shortcuts' }
  | { type: 'open-file' }
  | { type: 'selection'; action: SelectionAction }
  | { type: 'nudge'; dx: number; dy: number };

export type SelectionAction =
  | 'all'
  | 'commit'
  | 'cancel'
  | 'clear'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'duplicate';

/** What the keyboard can do to the selected markup shape. Arrow keys nudge it like pixels. */
export type ShapeAction = 'delete' | 'deselect' | 'duplicate';

/** A platform-neutral key press. `mod` is Command on Apple platforms and Control elsewhere. */
export interface KeyPress {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

export interface ShortcutContext {
  hasSelection: boolean;
  /** A markup shape is selected. It never coexists with a pixel selection. */
  hasShapeSelection?: boolean;
  /** A pointer gesture owns the selection until it lifts. */
  gesturing?: boolean;
}

const NUDGES: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

const TOOL_KEYS = new Map(TOOLS.map((tool) => [tool.key, tool.kind]));
const SHAPE_KEYS = new Map(SHAPES.map((shape) => [shape.key, shape.kind]));

/** Maps a key press to an editor command. Returns null for keys the editor leaves alone. */
export function resolveShortcut(press: KeyPress, context: ShortcutContext): EditorCommand | null {
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key;
  const shape = context.hasShapeSelection === true;

  if (press.mod) {
    if (press.alt) {
      if (press.shift) return null;
      if (key === 'n') return { type: 'open', panel: 'new' };
      return key === 'c' ? { type: 'open', panel: 'resize' } : null;
    }
    if (key === 'z') return { type: press.shift ? 'redo' : 'undo' };
    if (key === 'y' && !press.shift) return { type: 'redo' };
    if (key === 'e' && press.shift) return { type: 'open', panel: 'export' };
    // Shift types + on most layouts, so ⌘+ reads either way, as it does in browsers.
    if (key === '+') return { type: 'zoom', direction: 1 };
    if (press.shift) return null;
    switch (key) {
      case 'o':
        return { type: 'open-file' };
      case '=':
        return { type: 'zoom', direction: 1 };
      case '-':
        return { type: 'zoom', direction: -1 };
      case '0':
        return { type: 'zoom-fit' };
      case '1':
        return { type: 'zoom-actual' };
      case "'":
        return { type: 'toggle-grid' };
      case 'a':
        return { type: 'selection', action: 'all' };
      case 'd':
        // Preview's ⌘D: duplicate a shape. With pixels selected it stays Deselect.
        if (shape) return { type: 'shape', action: 'duplicate' };
        return context.hasSelection ? { type: 'selection', action: 'cancel' } : null;
      case 'c':
        return context.hasSelection ? { type: 'selection', action: 'copy' } : null;
      case 'x':
        return context.hasSelection ? { type: 'selection', action: 'cut' } : null;
      case 'v':
        return { type: 'selection', action: 'paste' };
      default:
        return null;
    }
  }

  if (press.alt) return null;
  if (shape) {
    switch (key) {
      case 'Escape':
      case 'Enter':
        return { type: 'shape', action: 'deselect' };
      case 'Delete':
      case 'Backspace':
        return { type: 'shape', action: 'delete' };
    }
  }
  switch (key) {
    case 'Escape':
      return context.hasSelection ? { type: 'selection', action: 'cancel' } : null;
    case 'Enter':
      return context.hasSelection ? { type: 'selection', action: 'commit' } : null;
    case 'Delete':
    case 'Backspace':
      return context.hasSelection ? { type: 'selection', action: 'clear' } : null;
    case 'Tab':
      return press.shift ? null : { type: 'toggle-chrome' };
    // Shift types these on most layouts, so they resolve before the Shift bail-out below.
    case '?':
      return { type: 'open', panel: 'shortcuts' };
    case '+':
      return { type: 'zoom', direction: 1 };
  }
  const nudge = NUDGES[key];
  if (nudge) {
    if ((!context.hasSelection && !shape) || context.gesturing) return null;
    const step = press.shift ? 10 : 1;
    return { type: 'nudge', dx: nudge[0] * step, dy: nudge[1] * step };
  }
  if (press.shift) return null;
  const tool = TOOL_KEYS.get(key);
  if (tool) return { type: 'tool', tool };
  const kind = SHAPE_KEYS.get(key);
  if (kind) return { type: 'shape-tool', kind };
  switch (key) {
    case 'x':
      return { type: 'swap-colors' };
    case '[':
      return { type: 'brush-size', direction: -1 };
    case ']':
      return { type: 'brush-size', direction: 1 };
    case '0':
      return { type: 'zoom-fit' };
    case '1':
      return { type: 'zoom-actual' };
    case '=':
      return { type: 'zoom', direction: 1 };
    case '-':
      return { type: 'zoom', direction: -1 };
    default:
      return null;
  }
}
