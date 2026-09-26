import type { ToolKind } from '../../tools';
import { TOOLS } from './tools';

export type EditorCommand =
  | { type: 'tool'; tool: ToolKind }
  | { type: 'swap-colors' }
  | { type: 'brush-size'; direction: -1 | 1 }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'zoom'; direction: -1 | 1 }
  | { type: 'zoom-fit' }
  | { type: 'zoom-actual' }
  | { type: 'toggle-grid' }
  | { type: 'toggle-chrome' }
  | { type: 'open'; panel: 'new' | 'export' | 'resize' }
  | { type: 'open-file' }
  | { type: 'selection'; action: SelectionAction };

export type SelectionAction =
  | 'all'
  | 'commit'
  | 'cancel'
  | 'clear'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'duplicate';

/** A platform-neutral key press. `mod` is Command on Apple platforms and Control elsewhere. */
export interface KeyPress {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

export interface ShortcutContext {
  hasSelection: boolean;
}

const TOOL_KEYS = new Map(TOOLS.map((tool) => [tool.key, tool.kind]));

/** Maps a key press to an editor command. Returns null for keys the editor leaves alone. */
export function resolveShortcut(press: KeyPress, context: ShortcutContext): EditorCommand | null {
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key;

  if (press.mod) {
    if (press.alt && key === 'n') return { type: 'open', panel: 'new' };
    if (press.alt && key === 'c') return { type: 'open', panel: 'resize' };
    if (press.alt) return null;
    if (key === 'z') return { type: press.shift ? 'redo' : 'undo' };
    if (key === 'y' && !press.shift) return { type: 'redo' };
    if (key === 'e' && press.shift) return { type: 'open', panel: 'export' };
    if (press.shift) return null;
    switch (key) {
      case 'o':
        return { type: 'open-file' };
      case '=':
      case '+':
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
  }
  if (press.shift) return null;
  const tool = TOOL_KEYS.get(key);
  if (tool) return { type: 'tool', tool };
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
    case '+':
      return { type: 'zoom', direction: 1 };
    case '-':
      return { type: 'zoom', direction: -1 };
    default:
      return null;
  }
}
