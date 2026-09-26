import { Button } from '@astryxdesign/core/Button';
import { useEffect } from 'react';
import { attachAutosave } from '../../../files';
import type { Autosave, DocumentStore } from '../../../files';
import type { EditorSession } from '../../session/session';
import { useToast } from '../toasts';

/**
 * Keeps the live document persisted. A resize swaps in a new document with a new tile grid, so
 * autosave re-attaches with a full resave. Leaving flushes pending tiles instead of dropping them.
 */
export function useAutosave(session: EditorSession, store: DocumentStore): void {
  const showToast = useToast();

  useEffect(() => {
    let autosave: Autosave | null = null;
    let dismissError: (() => void) | null = null;

    const attach = (initialResave: boolean) => {
      autosave?.dispose();
      const current = attachAutosave(session.bitmap.state, store, {
        initialResave,
        onStatus(status) {
          session.setSaveStatus(status);
          if (status !== 'error') {
            dismissError?.();
            dismissError = null;
            return;
          }
          dismissError = showToast({
            type: 'error',
            body: 'Your latest changes aren’t saved yet.',
            uniqueID: 'autosave-error',
            endContent: (
              <Button
                variant="secondary"
                size="sm"
                label="Retry"
                onClick={() => void current.flush().catch(() => {})}
              />
            ),
          });
        },
      });
      autosave = current;
    };

    attach(false);
    let document = session.bitmap.state;
    const subscription = session.bitmap.subscribe(() => {
      if (session.bitmap.state === document) return;
      document = session.bitmap.state;
      attach(true);
    });

    return () => {
      subscription.unsubscribe();
      dismissError?.();
      // flush() takes its snapshot synchronously, so disposing right after can't lose tiles.
      autosave?.flush().catch(() => {});
      autosave?.dispose();
    };
  }, [session, store, showToast]);
}
