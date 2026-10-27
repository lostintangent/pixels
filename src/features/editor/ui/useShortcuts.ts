import { useEffect } from 'react';
import { resolveShortcut } from '../core/shortcuts';
import type { EditorCommand, SelectionAction } from '../core/shortcuts';
import type { EditorSession } from '../session/session';

const IS_APPLE = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');

/** Keys stay with whatever owns focus: text fields, menus, and open dialogs or sheets. */
export const OWNS_KEYS =
  'input, textarea, select, [contenteditable], [role="menu"], [role="listbox"], dialog, [role="dialog"]';

/**
 * Color surfaces edit live beside the canvas, so Undo and Redo still reach the document from
 * anywhere in them, including a sheet's own focus root outside the marked content, which keeps
 * focus through a touch drag. Text fields inside them keep their own native undo.
 */
const PASSES_HISTORY = '[data-passes-history]';
const SURFACE = 'dialog, [role="dialog"]';
const TEXT_ENTRY = 'input, textarea, [contenteditable]';
const HISTORY = new Set<EditorCommand['type']>(['undo', 'redo']);

/** The slice of `Element` that key routing reads, so it can be tested without a DOM. */
export interface KeyTarget {
  closest(selectors: string): KeyTarget | null;
  querySelector(selectors: string): unknown;
}

/** Whether a resolved shortcut reaches the editor from `target`, rather than staying with it. */
export function shortcutReachesEditor(
  target: KeyTarget | null,
  command: EditorCommand['type'],
  isPanelOpen: boolean,
): boolean {
  if (!target?.closest(OWNS_KEYS) && !isPanelOpen) return true;
  if (!HISTORY.has(command) || !target || target.closest(TEXT_ENTRY)) return false;
  if (target.closest(PASSES_HISTORY)) return true;
  return Boolean(target.closest(SURFACE)?.querySelector(PASSES_HISTORY));
}

/** Composite widgets that move their own focus with arrow keys, even when they don't consume them. */
const OWNS_ARROWS = '[role="radiogroup"], [role="slider"], [role="tablist"], [role="grid"]';

/** Toggles fire once per press. Stepping commands repeat while held. */
const REPEATS = new Set<EditorCommand['type']>(['zoom', 'brush-size', 'undo', 'redo', 'nudge']);

/** These arrive as the browser's copy, cut, and paste events instead. See useClipboard. */
const CLIPBOARD = new Set<SelectionAction>(['copy', 'cut', 'paste']);

export function useShortcuts(session: EditorSession, run: (command: EditorCommand) => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;

      const command = resolveShortcut(
        {
          key: event.key,
          code: event.code,
          mod: IS_APPLE ? event.metaKey : event.ctrlKey,
          shift: event.shiftKey,
          alt: event.altKey,
          // Firefox reports AltGraph for Option on macOS, including Command+Option chords.
          altGraph: !IS_APPLE && event.getModifierState('AltGraph'),
        },
        {
          hasSelection: session.state.state.selection !== null,
          hasShapeSelection: session.state.state.selectedShape !== null,
          gesturing: session.gesturing,
        },
      );
      if (!command) return;
      if (!shortcutReachesEditor(target, command.type, session.state.state.panel !== null)) return;
      if (command.type === 'nudge' && target?.closest(OWNS_ARROWS)) return;
      if (command.type === 'selection' && CLIPBOARD.has(command.action)) return;
      // Tab moves focus through the chrome and only hides it from the canvas. Hidden chrome is
      // inert, so from anywhere else Tab brings it back instead of leaving the page.
      if (
        command.type === 'toggle-chrome' &&
        target?.getAttribute('role') !== 'application' &&
        !session.state.state.chromeHidden
      )
        return;
      // Leave Enter to the focused button.
      if (
        command.type === 'selection' &&
        command.action === 'commit' &&
        target instanceof HTMLButtonElement
      )
        return;
      event.preventDefault();
      if (event.repeat && !REPEATS.has(command.type)) return;
      run(command);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [session, run]);
}
