import { useEffect } from 'react';
import { resolveShortcut } from '../core/shortcuts';
import type { EditorCommand } from '../core/shortcuts';
import type { EditorSession } from '../session/session';

const IS_APPLE = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');

/** Keys stay with whatever owns focus: text fields, menus, and open dialogs or sheets. */
const OWNS_KEYS =
  'input, textarea, select, [contenteditable], [role="menu"], [role="listbox"], dialog, [role="dialog"]';

/** Toggles fire once per press. Stepping commands repeat while held. */
const REPEATS = new Set<EditorCommand['type']>(['zoom', 'brush-size', 'undo', 'redo']);

export function useShortcuts(session: EditorSession, run: (command: EditorCommand) => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(OWNS_KEYS)) return;
      if (session.state.state.panel) return;

      const command = resolveShortcut(
        {
          key: event.key,
          mod: IS_APPLE ? event.metaKey : event.ctrlKey,
          shift: event.shiftKey,
          alt: event.altKey,
        },
        { hasSelection: session.state.state.selection !== null },
      );
      if (!command) return;
      // Tab still moves focus through the chrome. It only hides chrome from the canvas.
      if (
        command.type === 'toggle-chrome' &&
        target &&
        target !== document.body &&
        target.getAttribute('role') !== 'application'
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
