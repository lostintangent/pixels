import { useEffect } from 'react';
import { appClipboard } from '../../session/clipboard';
import type { EditorSession } from '../../session/session';
import { OWNS_KEYS } from '../useShortcuts';
import type { FileActions } from './FileActions';

/**
 * Marks the system clipboard as holding a Pixels copy. Pixels themselves stay in the in-app
 * clipboard, so they paste back exactly, while an image copied elsewhere afterwards replaces
 * the marker and pastes instead.
 */
const MARKER = 'application/x-pixels-selection';

type ClipboardAction = 'copy' | 'cut';

/** Set by a button while it raises a copy event, since a cut command needs an editable target. */
let chromeAction: ClipboardAction | null = null;

/**
 * Copy, cut, and paste ride the browser's clipboard events rather than keydown, since only
 * those events can read a pasted image or write the marker.
 */
export function useClipboard(session: EditorSession, files: FileActions): void {
  useEffect(() => {
    const ownsEvent = (event: ClipboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      return Boolean(target?.closest(OWNS_KEYS)) || session.state.state.panel !== null;
    };

    const onCopy = (action: ClipboardAction) => (event: ClipboardEvent) => {
      if (ownsEvent(event) || !event.clipboardData || !session.state.state.selection) return;
      session.run({ type: 'selection', action: chromeAction ?? action });
      event.clipboardData.setData(MARKER, appClipboard.token);
      event.preventDefault();
    };
    const copy = onCopy('copy');
    const cut = onCopy('cut');

    const paste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (ownsEvent(event) || !data) return;
      event.preventDefault();
      if (data.getData(MARKER) === appClipboard.token) {
        session.run({ type: 'selection', action: 'paste' });
        return;
      }
      const image = [...data.files].find((file) => file.type.startsWith('image/'));
      if (image) {
        files.pasteFile(image);
        return;
      }
      // Some browsers drop custom types, which leaves an empty clipboard behind a Pixels copy.
      if (data.types.length === 0) session.run({ type: 'selection', action: 'paste' });
    };

    window.addEventListener('copy', copy);
    window.addEventListener('cut', cut);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('copy', copy);
      window.removeEventListener('cut', cut);
      window.removeEventListener('paste', paste);
    };
  }, [session, files]);
}

/**
 * Copy or cut from a button. `execCommand` raises a real copy event, so the marker is written
 * the same way as ⌘C. Where it's unsupported, the in-app clipboard still gets the pixels.
 */
export function copyFromChrome(session: EditorSession, action: ClipboardAction): void {
  chromeAction = action;
  try {
    if (!document.execCommand('copy')) session.run({ type: 'selection', action });
  } finally {
    chromeAction = null;
  }
}
